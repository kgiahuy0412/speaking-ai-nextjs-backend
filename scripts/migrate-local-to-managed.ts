import { BlobNotFoundError, head, put } from "@vercel/blob";
import { loadEnvConfig } from "@next/env";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDatabaseSchema } from "../src/lib/db";
import { putRecord } from "../src/lib/db/records";
import {
  getAudioStorageBackend,
  getGeneratedAudioBlobToken,
} from "../src/lib/storage/config";
import type { DeviceProfile } from "../src/types/admin";
import type { ConversationHistoryEntry } from "../src/types/conversation";
import type { PromotedRule } from "../src/lib/ai/promotedRules";
import type { AiTextCacheEntry } from "../src/lib/ai/textCache";

type JsonMap<T> = Record<string, T>;

const projectRoot = process.cwd();
loadEnvConfig(projectRoot);

const dataDir = path.join(projectRoot, "data");
const audioDir = path.join(projectRoot, "public", "generated-audio");
const dryRun = process.argv.includes("--dry-run");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function readHistory() {
  try {
    const content = await readFile(
      path.join(dataDir, "conversation-history.jsonl"),
      "utf8",
    );
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ConversationHistoryEntry);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readAudioFiles() {
  try {
    return (await readdir(audioDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function uploadAudio(fileName: string) {
  const pathname = `generated-audio/${fileName}`;
  const token = getGeneratedAudioBlobToken();

  try {
    await head(pathname, { token });
    return "existing" as const;
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) {
      throw error;
    }
  }

  await put(pathname, await readFile(path.join(audioDir, fileName)), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    token,
  });
  return "uploaded" as const;
}

async function main() {
  const audioStorageBackend = getAudioStorageBackend();
  const [history, profiles, rules, textCache, audioFiles] = await Promise.all([
    readHistory(),
    readJson<JsonMap<DeviceProfile>>(path.join(dataDir, "device-profiles.json"), {}),
    readJson<JsonMap<PromotedRule>>(path.join(dataDir, "promoted-rules.json"), {}),
    readJson<JsonMap<AiTextCacheEntry>>(path.join(dataDir, "ai-text-cache.json"), {}),
    readAudioFiles(),
  ]);
  const summary = {
    conversations: history.length,
    deviceProfiles: Object.keys(profiles).length,
    promotedRules: Object.keys(rules).length,
    textCacheEntries: Object.keys(textCache).length,
    audioFiles: audioFiles.length,
  };

  if (dryRun) {
    console.info(JSON.stringify({ dryRun: true, summary }, null, 2));
    return;
  }

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("Thiếu DATABASE_URL; chưa thể chạy migration.");
  }

  process.env.PERSISTENCE_BACKEND = "postgres";

  const backupDir = path.join(projectRoot, "backups", `pre-managed-${timestamp()}`);
  await mkdir(backupDir, { recursive: true });
  await cp(dataDir, path.join(backupDir, "data"), {
    recursive: true,
    force: false,
  }).catch((error) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  });
  await cp(audioDir, path.join(backupDir, "generated-audio"), {
    recursive: true,
    force: false,
  }).catch((error) => {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  });

  await ensureDatabaseSchema();

  for (const entry of history) {
    await putRecord({
      namespace: "conversation_history",
      key: entry.conversationId,
      clientId: entry.clientId,
      createdAt: entry.createdAt,
      value: entry,
    });
  }
  for (const [key, profile] of Object.entries(profiles)) {
    await putRecord({
      namespace: "device_profiles",
      key,
      clientId: profile.clientId,
      createdAt: profile.createdAt,
      value: profile,
    });
  }
  for (const [key, rule] of Object.entries(rules)) {
    await putRecord({
      namespace: "promoted_rules",
      key,
      clientId: rule.clientId,
      createdAt: rule.createdAt,
      value: rule,
    });
  }
  for (const [key, entry] of Object.entries(textCache)) {
    await putRecord({
      namespace: "ai_text_cache",
      key,
      clientId: entry.clientId,
      createdAt: entry.createdAt,
      value: entry,
    });
  }

  let uploadedAudio = 0;
  let existingAudio = 0;
  if (audioStorageBackend === "vercel-blob") {
    for (const fileName of audioFiles) {
      const result = await uploadAudio(fileName);
      uploadedAudio += result === "uploaded" ? 1 : 0;
      existingAudio += result === "existing" ? 1 : 0;
    }
  }

  const manifest = {
    migratedAt: new Date().toISOString(),
    source: "local",
    destination: { records: "postgres", audio: audioStorageBackend },
    summary,
    uploadedAudio,
    existingAudio,
    localFilesDeleted: false,
  };
  await writeFile(
    path.join(backupDir, "migration-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.info(JSON.stringify({ ok: true, backupDir, ...manifest }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
