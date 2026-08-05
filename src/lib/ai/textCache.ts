import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PracticeContext, TextProvider } from "@/types/conversation";
import { PROMPT_VERSION } from "./prompts";
import { isPostgresStorageEnabled } from "@/lib/db";
import {
  deleteRecord,
  getRecord,
  listRecords,
  putRecord,
} from "@/lib/db/records";
import { normalizeVietnameseForExactMatch } from "./exactRules";
import {
  RULE_VERSION,
  TEXT_CACHE_VERSION,
  TRANSLATION_POLICY_VERSION,
} from "./translationPolicy";

export type AiTextCacheEntry = {
  cacheVersion: string;
  translationPolicyVersion: string;
  ruleVersion: string;
  context: PracticeContext;
  normalizedVietnameseText: string;
  originalVietnameseText: string;
  englishText: string;
  clientId?: string;
  childAge: number;
  promptVersion: string;
  textProvider?: TextProvider;
  textModel?: string;
  textFallbackUsed?: boolean;
  textFallbackReason?: string;
  createdAt: string;
  updatedAt: string;
};

type AiTextCacheFile = Record<string, AiTextCacheEntry>;

const cacheDir = path.join(process.cwd(), "data");
const cachePath = path.join(cacheDir, "ai-text-cache.json");
const textCacheNamespace = "ai_text_cache";

type TextCacheGlobalState = typeof globalThis & {
  __aiSpeakingTextCacheMutationQueue?: Promise<void>;
  __aiSpeakingTextCacheMemory?: Map<string, AiTextCacheEntry>;
};

const textCacheGlobal = globalThis as TextCacheGlobalState;
const maxMemoryCacheEntries = 256;

function getTextMemoryCache() {
  textCacheGlobal.__aiSpeakingTextCacheMemory ??= new Map();
  return textCacheGlobal.__aiSpeakingTextCacheMemory;
}

function readTextMemoryCache(key: string) {
  const cache = getTextMemoryCache();
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeTextMemoryCache(key: string, entry: AiTextCacheEntry) {
  const cache = getTextMemoryCache();
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maxMemoryCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function getCacheKey(
  context: PracticeContext,
  normalizedVietnameseText: string,
  childAge: number,
  scope: "global" | `client:${string}` = "global",
) {
  return [
    TEXT_CACHE_VERSION,
    TRANSLATION_POLICY_VERSION,
    PROMPT_VERSION,
    RULE_VERSION,
    scope,
    context,
    `age:${childAge}`,
    normalizedVietnameseText,
  ].join("::");
}

function getLegacyClientCacheKey(
  context: PracticeContext,
  normalizedVietnameseText: string,
  childAge: number,
  clientId: string,
) {
  return getCacheKey(
    context,
    normalizedVietnameseText,
    childAge,
    `client:${clientId}`,
  );
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
  const normalizedVietnameseText =
    normalizeVietnameseForExactMatch(vietnameseText);

  if (!normalizedVietnameseText) {
    return null;
  }

  if (isPostgresStorageEnabled()) {
    const sharedCacheKey = getCacheKey(
      context,
      normalizedVietnameseText,
      childAge,
    );
    const legacyCacheKey = clientId
      ? getLegacyClientCacheKey(
          context,
          normalizedVietnameseText,
          childAge,
          clientId,
        )
      : null;
    const memoryEntry =
      readTextMemoryCache(sharedCacheKey) ??
      (legacyCacheKey ? readTextMemoryCache(legacyCacheKey) : null);
    if (memoryEntry) {
      return {
        englishText: memoryEntry.englishText,
        normalizedVietnameseText,
        textProvider: memoryEntry.textProvider,
        textModel: memoryEntry.textModel,
        textFallbackUsed: memoryEntry.textFallbackUsed,
        textFallbackReason: memoryEntry.textFallbackReason,
      };
    }
    const sharedEntry = await getRecord<AiTextCacheEntry>(
      textCacheNamespace,
      sharedCacheKey,
    );
    // Keep reading the former client-scoped key during migration. Every new
    // successful translation is written to the shared key below, so devices
    // converge on one cache without requiring an offline data migration.
    const legacyEntry =
      !sharedEntry && clientId
        ? await getRecord<AiTextCacheEntry>(
            textCacheNamespace,
            legacyCacheKey!,
          )
        : null;
    const matched = sharedEntry?.value ?? legacyEntry?.value;
    if (matched) {
      writeTextMemoryCache(
        sharedEntry ? sharedCacheKey : legacyCacheKey!,
        matched,
      );
    }

    return matched
      ? {
          englishText: matched.englishText,
          normalizedVietnameseText,
          textProvider: matched.textProvider,
          textModel: matched.textModel,
          textFallbackUsed: matched.textFallbackUsed,
          textFallbackReason: matched.textFallbackReason,
        }
      : null;
  }

  await textCacheGlobal.__aiSpeakingTextCacheMutationQueue;
  const cache = await readAiTextCache();
  const sharedEntry =
    cache[getCacheKey(context, normalizedVietnameseText, childAge)] ?? null;
  const entry =
    sharedEntry ??
    (clientId
      ? cache[
          getLegacyClientCacheKey(
            context,
            normalizedVietnameseText,
            childAge,
            clientId,
          )
        ] ?? null
      : null);

  return entry
    ? {
        englishText: entry.englishText,
        normalizedVietnameseText,
        textProvider: entry.textProvider,
        textModel: entry.textModel,
        textFallbackUsed: entry.textFallbackUsed,
        textFallbackReason: entry.textFallbackReason,
      }
    : null;
}

export async function saveAiEnglishText(
  vietnameseText: string,
  context: PracticeContext,
  childAge: number,
  englishText: string,
  _clientId?: string,
  providerMetadata: {
    textProvider?: TextProvider;
    textModel?: string;
    textFallbackUsed?: boolean;
    textFallbackReason?: string;
  } = {},
) {
  const normalizedVietnameseText =
    normalizeVietnameseForExactMatch(vietnameseText);

  if (!normalizedVietnameseText || !englishText.trim()) {
    return;
  }

  if (isPostgresStorageEnabled()) {
    const key = getCacheKey(
      context,
      normalizedVietnameseText,
      childAge,
    );
    const existing = await getRecord<AiTextCacheEntry>(
      textCacheNamespace,
      key,
    );
    const now = new Date().toISOString();
    const entry: AiTextCacheEntry = {
      cacheVersion: TEXT_CACHE_VERSION,
      translationPolicyVersion: TRANSLATION_POLICY_VERSION,
      ruleVersion: RULE_VERSION,
      context,
      normalizedVietnameseText,
      originalVietnameseText: vietnameseText,
      englishText: englishText.trim(),
      childAge,
      promptVersion: PROMPT_VERSION,
      ...providerMetadata,
      createdAt: existing?.value.createdAt ?? now,
      updatedAt: now,
    };

    await putRecord({
      namespace: textCacheNamespace,
      key,
      createdAt: entry.createdAt,
      value: entry,
    });
    writeTextMemoryCache(key, entry);
    return;
  }

  await enqueueMutation(async () => {
    const cache = { ...(await readAiTextCache()) };
    const key = getCacheKey(
      context,
      normalizedVietnameseText,
      childAge,
    );
    const now = new Date().toISOString();

    cache[key] = {
      cacheVersion: TEXT_CACHE_VERSION,
      translationPolicyVersion: TRANSLATION_POLICY_VERSION,
      ruleVersion: RULE_VERSION,
      context,
      normalizedVietnameseText,
      originalVietnameseText: vietnameseText,
      englishText: englishText.trim(),
      childAge,
      promptVersion: PROMPT_VERSION,
      ...providerMetadata,
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
  const normalizedVietnameseText =
    normalizeVietnameseForExactMatch(vietnameseText);

  if (!normalizedVietnameseText) {
    return 0;
  }

  getTextMemoryCache().clear();

  if (isPostgresStorageEnabled()) {
    const entries = await listRecords<AiTextCacheEntry>(textCacheNamespace, {
      limit: 100_000,
    });
    const matchingEntries = entries.filter(
      (entry) =>
        entry.context === context &&
        entry.normalizedVietnameseText === normalizedVietnameseText &&
        (entry.clientId === undefined || entry.clientId === clientId),
    );

    for (const entry of matchingEntries) {
      await deleteRecord(
        textCacheNamespace,
        getCacheKey(
          entry.context,
          entry.normalizedVietnameseText,
          entry.childAge,
          entry.clientId ? `client:${entry.clientId}` : "global",
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
          (entry.clientId === undefined || entry.clientId === clientId)
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
