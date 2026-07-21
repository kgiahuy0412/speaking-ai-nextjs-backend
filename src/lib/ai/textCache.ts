import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PracticeContext } from "@/types/conversation";
import { normalizeVietnamese } from "@/lib/normalize";
import { PROMPT_VERSION } from "./prompts";
import { isPostgresStorageEnabled } from "@/lib/db";
import {
  deleteRecord,
  getRecord,
  listRecords,
  putRecord,
} from "@/lib/db/records";

export type AiTextCacheEntry = {
  context: PracticeContext;
  normalizedVietnameseText: string;
  originalVietnameseText: string;
  englishText: string;
  clientId?: string;
  childAge: number;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
};

type AiTextCacheFile = Record<string, AiTextCacheEntry>;

const cacheDir = path.join(process.cwd(), "data");
const cachePath = path.join(cacheDir, "ai-text-cache.json");
const textCacheNamespace = "ai_text_cache";

type TextCacheGlobalState = typeof globalThis & {
  __aiSpeakingTextCacheMutationQueue?: Promise<void>;
};

const textCacheGlobal = globalThis as TextCacheGlobalState;

function getCacheKey(
  context: PracticeContext,
  normalizedVietnameseText: string,
  childAge: number,
  clientId?: string,
) {
  return [
    PROMPT_VERSION,
    clientId ? `client:${clientId}` : "global",
    context,
    `age:${childAge}`,
    normalizedVietnameseText,
  ].join("::");
}

function getLegacyCacheKey(
  context: PracticeContext,
  normalizedVietnameseText: string,
  childAge: number,
) {
  return [
    PROMPT_VERSION,
    context,
    `age:${childAge}`,
    normalizedVietnameseText,
  ].join("::");
}

async function readAiTextCache() {
  try {
    return JSON.parse(await readFile(cachePath, "utf8")) as AiTextCacheFile;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    } else {
      throw error;
    }
  }
}

async function writeAiTextCache(cache: AiTextCacheFile) {
  const temporaryPath = path.join(
    cacheDir,
    `.ai-text-cache-${crypto.randomUUID()}.tmp`,
  );
  await mkdir(cacheDir, { recursive: true });

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(cache, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, cachePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function enqueueMutation<T>(operation: () => Promise<T>) {
  const queue =
    textCacheGlobal.__aiSpeakingTextCacheMutationQueue ?? Promise.resolve();
  const result = queue.then(operation, operation);
  textCacheGlobal.__aiSpeakingTextCacheMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function getCachedAiEnglishText(
  vietnameseText: string,
  context: PracticeContext,
  childAge: number,
  clientId?: string,
) {
  const normalizedVietnameseText = normalizeVietnamese(vietnameseText);

  if (!normalizedVietnameseText) {
    return null;
  }

  if (isPostgresStorageEnabled()) {
    const cacheKey = getCacheKey(
      context,
      normalizedVietnameseText,
      childAge,
      clientId,
    );
    const entry = await getRecord<AiTextCacheEntry>(
      textCacheNamespace,
      cacheKey,
    );
    const legacyEntry =
      !entry && !clientId
        ? await getRecord<AiTextCacheEntry>(
            textCacheNamespace,
            getLegacyCacheKey(context, normalizedVietnameseText, childAge),
          )
        : null;
    const matched = entry?.value ?? legacyEntry?.value;

    return matched
      ? { englishText: matched.englishText, normalizedVietnameseText }
      : null;
  }

  await textCacheGlobal.__aiSpeakingTextCacheMutationQueue;
  const cache = await readAiTextCache();
  const entry =
    cache[
      getCacheKey(context, normalizedVietnameseText, childAge, clientId)
    ] ??
    (!clientId
      ? cache[
          getLegacyCacheKey(context, normalizedVietnameseText, childAge)
        ]
      : null) ??
    null;

  return entry
    ? {
        englishText: entry.englishText,
        normalizedVietnameseText,
      }
    : null;
}

export async function saveAiEnglishText(
  vietnameseText: string,
  context: PracticeContext,
  childAge: number,
  englishText: string,
  clientId?: string,
) {
  const normalizedVietnameseText = normalizeVietnamese(vietnameseText);

  if (!normalizedVietnameseText || !englishText.trim()) {
    return;
  }

  if (isPostgresStorageEnabled()) {
    const key = getCacheKey(
      context,
      normalizedVietnameseText,
      childAge,
      clientId,
    );
    const existing = await getRecord<AiTextCacheEntry>(
      textCacheNamespace,
      key,
    );
    const now = new Date().toISOString();
    const entry: AiTextCacheEntry = {
      context,
      normalizedVietnameseText,
      originalVietnameseText: vietnameseText,
      englishText: englishText.trim(),
      clientId,
      childAge,
      promptVersion: PROMPT_VERSION,
      createdAt: existing?.value.createdAt ?? now,
      updatedAt: now,
    };

    await putRecord({
      namespace: textCacheNamespace,
      key,
      clientId,
      createdAt: entry.createdAt,
      value: entry,
    });
    return;
  }

  await enqueueMutation(async () => {
    const cache = { ...(await readAiTextCache()) };
    const key = getCacheKey(
      context,
      normalizedVietnameseText,
      childAge,
      clientId,
    );
    const now = new Date().toISOString();

    cache[key] = {
      context,
      normalizedVietnameseText,
      originalVietnameseText: vietnameseText,
      englishText: englishText.trim(),
      clientId,
      childAge,
      promptVersion: PROMPT_VERSION,
      createdAt: cache[key]?.createdAt ?? now,
      updatedAt: now,
    };

    await writeAiTextCache(cache);
  });
}

export async function removeAiEnglishText(
  vietnameseText: string,
  context: PracticeContext,
  clientId?: string,
) {
  const normalizedVietnameseText = normalizeVietnamese(vietnameseText);

  if (!normalizedVietnameseText) {
    return 0;
  }

  if (isPostgresStorageEnabled()) {
    const entries = await listRecords<AiTextCacheEntry>(textCacheNamespace, {
      ...(clientId === undefined ? {} : { clientId }),
      limit: 100_000,
    });
    const matchingEntries = entries.filter(
      (entry) =>
        entry.context === context &&
        entry.normalizedVietnameseText === normalizedVietnameseText &&
        entry.clientId === clientId,
    );

    for (const entry of matchingEntries) {
      await deleteRecord(
        textCacheNamespace,
        getCacheKey(
          entry.context,
          entry.normalizedVietnameseText,
          entry.childAge,
          entry.clientId,
        ),
        entry.clientId,
      );
    }

    return matchingEntries.length;
  }

  return enqueueMutation(async () => {
    const cache = await readAiTextCache();
    const matchingKeys = Object.entries(cache)
      .filter(([, entry]) => {
        return (
          entry.context === context &&
          entry.normalizedVietnameseText === normalizedVietnameseText &&
          entry.clientId === clientId
        );
      })
      .map(([key]) => key);

    if (matchingKeys.length === 0) {
      return 0;
    }

    const nextCache = { ...cache };
    matchingKeys.forEach((key) => delete nextCache[key]);
    await writeAiTextCache(nextCache);
    return matchingKeys.length;
  });
}
