import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ConversationHistoryEntry,
  ConversationHistoryPatch,
  ConversationResponse,
} from "@/types/conversation";
import { getChildDataRetentionDays } from "@/lib/dataPolicy";
import { logEvent } from "@/lib/observability";
import { isPostgresStorageEnabled } from "@/lib/db";
import {
  clearRecords,
  deleteRecord,
  deleteRecordsOlderThan,
  insertRecordIfAbsent,
  listRecords,
  putRecord,
  updateRecord,
} from "@/lib/db/records";

const historyDir = path.join(process.cwd(), "data");
const historyPath = path.join(historyDir, "conversation-history.jsonl");
const historyNamespace = "conversation_history";
const maxHistoryResponseItems = 50;
const maxStoredHistoryItems = 500;
const ruleTextSources = new Set([
  "phrase_rule",
  "keyword_rule",
  "promoted_rule",
  "semantic_cache",
]);
const adaptiveTextSources = new Set(["openai", "text_cache"]);

let mutationQueue: Promise<void> = Promise.resolve();
let lastMalformedSignature = "";

type ParsedHistory = {
  entries: ConversationHistoryEntry[];
  malformedLines: number[];
};

function initialLearningStatus(
  textSource: ConversationResponse["textSource"],
): ConversationHistoryEntry["learningStatus"] {
  if (ruleTextSources.has(textSource)) {
    return "already_rule";
  }
  if (textSource === "openai") {
    return "cached";
  }
  if (textSource === "text_cache") {
    return "observing";
  }
  return "not_eligible";
}

function isFileNotFound(error: unknown) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseHistory(content: string): ParsedHistory {
  const entries: ConversationHistoryEntry[] = [];
  const malformedLines: number[] = [];

  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }

    try {
      entries.push(JSON.parse(line) as ConversationHistoryEntry);
    } catch {
      malformedLines.push(index + 1);
    }
  });

  const signature = malformedLines.join(",");

  if (signature && signature !== lastMalformedSignature) {
    console.warn("conversation_history_malformed_lines", {
      lines: malformedLines,
    });
  }

  lastMalformedSignature = signature;
  return { entries, malformedLines };
}

async function readHistoryFile() {
  try {
    return parseHistory(await readFile(historyPath, "utf8"));
  } catch (error) {
    if (isFileNotFound(error)) {
      return { entries: [], malformedLines: [] } satisfies ParsedHistory;
    }

    throw error;
  }
}

async function writeHistoryFile(entries: ConversationHistoryEntry[]) {
  await mkdir(historyDir, { recursive: true });

  const temporaryPath = path.join(
    historyDir,
    `.conversation-history-${crypto.randomUUID()}.tmp`,
  );
  const content =
    entries.length > 0
      ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "";

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, historyPath);
    lastMalformedSignature = "";
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function enqueueMutation<T>(operation: () => Promise<T>) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function applyConversationHistoryPatch(
  entry: ConversationHistoryEntry,
  patch: ConversationHistoryPatch,
) {
  return {
    ...entry,
    englishText: patch.englishText ?? entry.englishText,
    originalEnglishText:
      patch.originalEnglishText ?? entry.originalEnglishText,
    audioUrl: patch.audioUrl ?? entry.audioUrl,
    audioSource: patch.audioSource ?? entry.audioSource,
    latency: {
      ...entry.latency,
      ...patch.latency,
    },
    qualityApproved: patch.qualityApproved ?? entry.qualityApproved,
    reviewStatus: patch.reviewStatus ?? entry.reviewStatus,
    reviewedAt: patch.reviewedAt ?? entry.reviewedAt,
    reviewedBy: patch.reviewedBy ?? entry.reviewedBy,
    reviewNote: patch.reviewNote ?? entry.reviewNote,
    aiReview: patch.aiReview ?? entry.aiReview,
    promotedToRule: patch.promotedToRule ?? entry.promotedToRule,
    learningStatus: patch.learningStatus ?? entry.learningStatus,
    learningReason: patch.learningReason ?? entry.learningReason,
    learningUseCount: patch.learningUseCount ?? entry.learningUseCount,
  } satisfies ConversationHistoryEntry;
}

export async function appendConversationHistory(
  conversation: ConversationResponse,
  inputMode: ConversationHistoryEntry["inputMode"],
) {
  const entry: ConversationHistoryEntry = {
    ...conversation,
    createdAt: new Date().toISOString(),
    inputMode,
    reviewStatus: "unreviewed",
    learningStatus: initialLearningStatus(conversation.textSource),
    learningUseCount: adaptiveTextSources.has(conversation.textSource)
      ? 1
      : undefined,
  };

  if (isPostgresStorageEnabled()) {
    await insertRecordIfAbsent({
      namespace: historyNamespace,
      key: entry.conversationId,
      clientId: entry.clientId,
      createdAt: entry.createdAt,
      value: entry,
    });
    return;
  }

  await enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    entries.push(entry);
    await writeHistoryFile(entries.slice(-maxStoredHistoryItems));
  });
}

export async function readConversationHistory(limit = maxHistoryResponseItems) {
  const safeLimit = Math.max(
    1,
    Math.min(Math.floor(limit), maxStoredHistoryItems),
  );

  if (isPostgresStorageEnabled()) {
    const retentionDays = getChildDataRetentionDays();

    if (retentionDays) {
      const cutoff = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const deletedCount = await deleteRecordsOlderThan(
        historyNamespace,
        cutoff,
      );

      if (deletedCount > 0) {
        logEvent("info", "child_history_retention_applied", {
          retentionDays,
          deletedCount,
          storage: "postgres",
        });
      }
    }

    return listRecords<ConversationHistoryEntry>(historyNamespace, {
      limit: safeLimit,
    });
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const retentionDays = getChildDataRetentionDays();
    const cutoff = retentionDays
      ? Date.now() - retentionDays * 24 * 60 * 60 * 1000
      : null;
    const retainedEntries = cutoff
      ? entries.filter((entry) => {
          const createdAt = Date.parse(entry.createdAt);
          return !Number.isFinite(createdAt) || createdAt >= cutoff;
        })
      : entries;

    if (retainedEntries.length !== entries.length) {
      await writeHistoryFile(retainedEntries);
      logEvent("info", "child_history_retention_applied", {
        retentionDays,
        deletedCount: entries.length - retainedEntries.length,
      });
    }

    return [...retainedEntries].reverse().slice(0, safeLimit);
  });
}

export async function claimLegacyConversationHistory(clientId: string) {
  if (isPostgresStorageEnabled()) {
    const entries = await listRecords<ConversationHistoryEntry>(
      historyNamespace,
      { limit: 100_000, oldestFirst: true },
    );
    const hasAnotherOwner = entries.some(
      (entry) => entry.clientId && entry.clientId !== clientId,
    );
    let claimed = 0;

    for (const entry of entries) {
      let nextEntry = entry;

      if (!entry.clientId && !hasAnotherOwner) {
        claimed += 1;
        nextEntry = { ...nextEntry, clientId };
      }

      if (nextEntry.clientId === clientId && !nextEntry.learningStatus) {
        nextEntry = {
          ...nextEntry,
          learningStatus: initialLearningStatus(nextEntry.textSource),
          learningUseCount: adaptiveTextSources.has(nextEntry.textSource)
            ? 1
            : undefined,
        };
      }

      if (nextEntry !== entry) {
        await putRecord({
          namespace: historyNamespace,
          key: nextEntry.conversationId,
          clientId: nextEntry.clientId,
          createdAt: nextEntry.createdAt,
          value: nextEntry,
        });
      }
    }

    return claimed;
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const hasAnotherOwner = entries.some(
      (entry) => entry.clientId && entry.clientId !== clientId,
    );

    let claimed = 0;
    let changed = false;
    const nextEntries = entries.map((entry) => {
      let nextEntry = entry;

      if (!entry.clientId && !hasAnotherOwner) {
        claimed += 1;
        changed = true;
        nextEntry = { ...entry, clientId };
      }

      if (nextEntry.clientId === clientId && !nextEntry.learningStatus) {
        changed = true;
        return {
          ...nextEntry,
          learningStatus: initialLearningStatus(nextEntry.textSource),
          learningUseCount: adaptiveTextSources.has(nextEntry.textSource)
            ? 1
            : undefined,
        };
      }

      return nextEntry;
    });

    if (changed) {
      await writeHistoryFile(nextEntries);
    }

    return claimed;
  });
}

export async function updateConversationHistory(
  patch: ConversationHistoryPatch,
) {
  if (isPostgresStorageEnabled()) {
    return updateRecord<ConversationHistoryEntry>({
      namespace: historyNamespace,
      key: patch.conversationId,
      clientId: patch.clientId,
      mutate: (entry) => applyConversationHistoryPatch(entry, patch),
    });
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    let updatedEntry: ConversationHistoryEntry | null = null;
    const nextEntries = entries.map((entry) => {
      if (
        entry.conversationId !== patch.conversationId ||
        (patch.clientId !== undefined && entry.clientId !== patch.clientId)
      ) {
        return entry;
      }

      updatedEntry = applyConversationHistoryPatch(entry, patch);

      return updatedEntry;
    });

    if (!updatedEntry) {
      return null;
    }

    await writeHistoryFile(nextEntries);
    return updatedEntry;
  });
}

export async function updateConversationHistoryBatch(
  patches: ConversationHistoryPatch[],
) {
  if (patches.length === 0) {
    return 0;
  }

  if (isPostgresStorageEnabled()) {
    let updated = 0;

    for (const patch of patches) {
      const result = await updateConversationHistory(patch);
      updated += result ? 1 : 0;
    }

    return updated;
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const patchesById = new Map(
      patches.map((patch) => [patch.conversationId, patch]),
    );
    let updated = 0;
    const nextEntries = entries.map((entry) => {
      const patch = patchesById.get(entry.conversationId);

      if (
        !patch ||
        (patch.clientId !== undefined && entry.clientId !== patch.clientId)
      ) {
        return entry;
      }

      updated += 1;
      return applyConversationHistoryPatch(entry, patch);
    });

    if (updated > 0) {
      await writeHistoryFile(nextEntries);
    }

    return updated;
  });
}

export async function deleteConversationHistoryEntry(
  conversationId: string,
  clientId?: string,
) {
  if (isPostgresStorageEnabled()) {
    return deleteRecord(historyNamespace, conversationId, clientId);
  }

  return enqueueMutation(async () => {
    const { entries } = await readHistoryFile();
    const nextEntries = entries.filter(
      (entry) =>
        entry.conversationId !== conversationId ||
        (clientId !== undefined && entry.clientId !== clientId),
    );

    if (nextEntries.length === entries.length) {
      return false;
    }

    await writeHistoryFile(nextEntries);
    return true;
  });
}

export async function clearConversationHistory(clientId?: string) {
  if (isPostgresStorageEnabled()) {
    await clearRecords(historyNamespace, clientId);
    return;
  }

  await enqueueMutation(async () => {
    if (clientId === undefined) {
      await writeHistoryFile([]);
      return;
    }

    const { entries } = await readHistoryFile();
    await writeHistoryFile(
      entries.filter((entry) => entry.clientId !== clientId),
    );
  });
}
