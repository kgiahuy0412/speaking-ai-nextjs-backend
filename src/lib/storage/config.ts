export type PersistenceBackend = "local" | "postgres";
export type AudioStorageBackend = "local" | "postgres" | "vercel-blob";

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

export function getPersistenceBackend(): PersistenceBackend {
  const configuredBackend = process.env.PERSISTENCE_BACKEND
    ?.trim()
    .toLowerCase();

  if (configuredBackend === "postgres" || configuredBackend === "local") {
    return configuredBackend;
  }

  return process.env.DATABASE_URL?.trim() ? "postgres" : "local";
}

export function getAudioStorageBackend(): AudioStorageBackend {
  const configuredBackend = process.env.AUDIO_STORAGE_BACKEND
    ?.trim()
    .toLowerCase();

  if (
    configuredBackend === "local" ||
    configuredBackend === "postgres" ||
    configuredBackend === "vercel-blob"
  ) {
    return configuredBackend;
  }

  return getPersistenceBackend() === "postgres" ? "postgres" : "local";
}

export function getAudioUploadLimits() {
  return {
    maxChunkBytes: positiveInteger("AUDIO_UPLOAD_MAX_CHUNK_BYTES", 1_048_576),
    maxSessionBytes: positiveInteger(
      "AUDIO_UPLOAD_MAX_SESSION_BYTES",
      16_777_216,
    ),
    maxChunks: positiveInteger("AUDIO_UPLOAD_MAX_CHUNKS", 1_000),
    sessionTtlSeconds: positiveInteger("AUDIO_UPLOAD_SESSION_TTL_SECONDS", 900),
    finalizedResultTtlSeconds: positiveInteger(
      "AUDIO_FINALIZED_RESULT_TTL_SECONDS",
      86_400,
    ),
    finalizeLeaseSeconds: positiveInteger(
      "AUDIO_FINALIZE_LEASE_SECONDS",
      60,
    ),
  };
}

export function getGeneratedAudioBlobToken() {
  const token =
    process.env.GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN?.trim() ||
    process.env.BLOB_READ_WRITE_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "AUDIO_STORAGE_BACKEND=vercel-blob nhưng chưa có GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN hoặc BLOB_READ_WRITE_TOKEN.",
    );
  }

  return token;
}

export function getStorageConfiguration() {
  const persistenceBackend = getPersistenceBackend();
  const audioStorageBackend = getAudioStorageBackend();

  return {
    persistenceBackend,
    audioStorageBackend,
    postgresConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    postgresAudioConfigured:
      audioStorageBackend === "postgres" &&
      Boolean(process.env.DATABASE_URL?.trim()),
    blobConfigured: Boolean(
      process.env.GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN?.trim() ||
        process.env.BLOB_READ_WRITE_TOKEN?.trim(),
    ),
    uploadLimits: getAudioUploadLimits(),
  };
}
