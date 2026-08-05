import { list } from "@vercel/blob";
import { isPostgresStorageEnabled, pingDatabase } from "@/lib/db";
import {
  getAudioSessionChunkStorageBackend,
  getAudioStorageBackend,
  getGeneratedAudioBlobToken,
  getStorageConfiguration,
} from "@/lib/storage/config";
import { pingR2Bucket } from "@/lib/storage/r2";
import { countRecords } from "@/lib/db/records";

export async function getStorageHealth() {
  const configuration = getStorageConfiguration();
  const database = isPostgresStorageEnabled()
    ? await pingDatabase()
    : { ok: true, latencyMs: 0 };
  const recordCounts = isPostgresStorageEnabled()
    ? {
        conversations: await countRecords("conversation_history"),
        deviceProfiles: await countRecords("device_profiles"),
        promotedRules: await countRecords("promoted_rules"),
        textCacheEntries: await countRecords("ai_text_cache"),
      }
    : null;
  let blob = { ok: true, latencyMs: 0 };
  let r2 = { ok: true, latencyMs: 0 };

  if (getAudioStorageBackend() === "vercel-blob") {
    const startedAt = Date.now();
    await list({
      prefix: "generated-audio/",
      limit: 1,
      token: getGeneratedAudioBlobToken(),
    });
    blob = { ok: true, latencyMs: Date.now() - startedAt };
  }
  if (
    getAudioStorageBackend() === "r2" ||
    getAudioSessionChunkStorageBackend() === "r2"
  ) {
    r2 = await pingR2Bucket();
  }

  return {
    ok: database.ok && blob.ok && r2.ok,
    configuration,
    database,
    blob,
    r2,
    recordCounts,
    checkedAt: new Date().toISOString(),
  };
}
