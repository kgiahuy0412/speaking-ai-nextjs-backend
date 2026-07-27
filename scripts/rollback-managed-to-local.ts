import { list } from "@vercel/blob";
import { loadEnvConfig } from "@next/env";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listRecordEntries } from "../src/lib/db/records";
import { getGeneratedAudioBlobToken } from "../src/lib/storage/config";
import type { DeviceProfile } from "../src/types/admin";
import type { ConversationHistoryEntry } from "../src/types/conversation";
import type { PromotedRule } from "../src/lib/ai/promotedRules";
import type { AiTextCacheEntry } from "../src/lib/ai/textCache";

const projectRoot = process.cwd();
loadEnvConfig(projectRoot);

const applyRollback = process.argv.includes("--apply");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function listAllAudioBlobs() {
  const blobs = [];
  let cursor: string | undefined;
  do {
    const page = await list({
      prefix: "generated-audio/",
      limit: 1_000,
      cursor,
      token: getGeneratedAudioBlobToken(),
    });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("Thiếu DATABASE_URL; chưa thể tạo bản rollback.");
  }

  process.env.PERSISTENCE_BACKEND = "postgres";
  const snapshotDir = path.join(
    projectRoot,
    "backups",
    `managed-rollback-${timestamp()}`,
  );
  const snapshotDataDir = path.join(snapshotDir, "data");
  const snapshotAudioDir = path.join(snapshotDir, "generated-audio");
  await mkdir(snapshotDataDir, { recursive: true });
  await mkdir(snapshotAudioDir, { recursive: true });

  const [history, profiles, rules, textCache, blobs] = await Promise.all([
    listRecordEntries<ConversationHistoryEntry>("conversation_history", {
      oldestFirst: true,
      limit: 100_000,
    }),
    listRecordEntries<DeviceProfile>("device_profiles", { limit: 100_000 }),
    listRecordEntries<PromotedRule>("promoted_rules", { limit: 100_000 }),
    listRecordEntries<AiTextCacheEntry>("ai_text_cache", { limit: 100_000 }),
    listAllAudioBlobs(),
  ]);

  const historyContent = history.length
    ? `${history.map((entry) => JSON.stringify(entry.value)).join("\n")}\n`
    : "";
  await writeFile(
    path.join(snapshotDataDir, "conversation-history.jsonl"),
    historyContent,
    "utf8",
  );
  await writeFile(
    path.join(snapshotDataDir, "device-profiles.json"),
    `${JSON.stringify(Object.fromEntries(profiles.map((entry) => [entry.key, entry.value])), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(snapshotDataDir, "promoted-rules.json"),
    `${JSON.stringify(Object.fromEntries(rules.map((entry) => [entry.key, entry.value])), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(snapshotDataDir, "ai-text-cache.json"),
    `${JSON.stringify(Object.fromEntries(textCache.map((entry) => [entry.key, entry.value])), null, 2)}\n`,
    "utf8",
  );

  for (const blob of blobs) {
    const response = await fetch(blob.url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Không tải được ${blob.pathname}: HTTP ${response.status}`);
    }
    await writeFile(
      path.join(snapshotAudioDir, path.basename(blob.pathname)),
      Buffer.from(await response.arrayBuffer()),
    );
  }

  if (applyRollback) {
    const safetyDir = path.join(
      projectRoot,
      "backups",
      `pre-rollback-local-${timestamp()}`,
    );
    await mkdir(safetyDir, { recursive: true });
    await cp(path.join(projectRoot, "data"), path.join(safetyDir, "data"), {
      recursive: true,
      force: false,
    }).catch(() => undefined);
    await cp(
      path.join(projectRoot, "public", "generated-audio"),
      path.join(safetyDir, "generated-audio"),
      { recursive: true, force: false },
    ).catch(() => undefined);
    await cp(snapshotDataDir, path.join(projectRoot, "data"), {
      recursive: true,
      force: true,
    });
    await cp(snapshotAudioDir, path.join(projectRoot, "public", "generated-audio"), {
      recursive: true,
      force: true,
    });
  }

  console.info(
    JSON.stringify(
      {
        ok: true,
        snapshotDir,
        applied: applyRollback,
        counts: {
          conversations: history.length,
          deviceProfiles: profiles.length,
          promotedRules: rules.length,
          textCacheEntries: textCache.length,
          audioFiles: blobs.length,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
