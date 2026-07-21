import { list } from "@vercel/blob";
import { isPostgresStorageEnabled, pingDatabase } from "@/lib/db";
import {
  getAudioStorageBackend,
  getGeneratedAudioBlobToken,
  getStorageConfiguration,
} from "@/lib/storage/config";
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

  if (getAudioStorageBackend() === "vercel-blob") {
    const startedAt = Date.now();
    await list({
      prefix: "generated-audio/",
      limit: 1,
      token: getGeneratedAudioBlobToken(),
    });
    blob = { ok: true, latencyMs: Date.now() - startedAt };
  }

  return {
    ok: database.ok && blob.ok,
    configuration,
    database,
    blob,
    recordCounts,
    checkedAt: new Date().toISOString(),
  };
}
