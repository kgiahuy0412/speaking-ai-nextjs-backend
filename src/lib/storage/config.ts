export type PersistenceBackend = "local" | "postgres";
export type AudioStorageBackend = "local" | "postgres" | "vercel-blob" | "r2";
export type AudioSessionChunkStorageBackend = "local" | "postgres" | "r2";

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

function enabled(name: string, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes" || value === "on";
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
    configuredBackend === "vercel-blob" ||
    configuredBackend === "r2"
  ) {
    return configuredBackend;
  }

  return getPersistenceBackend() === "postgres" ? "postgres" : "local";
}

export function getAudioSessionChunkStorageBackend(): AudioSessionChunkStorageBackend {
  const persistenceBackend = getPersistenceBackend();
  const configuredBackend = process.env.AUDIO_SESSION_CHUNK_STORAGE_BACKEND
    ?.trim()
    .toLowerCase();

  if (persistenceBackend === "local") {
    if (configuredBackend && configuredBackend !== "local") {
      throw new Error(
        "Audio session dùng R2/PostgreSQL cần PERSISTENCE_BACKEND=postgres.",
      );
    }
    return "local";
  }

  if (configuredBackend === "r2" || configuredBackend === "postgres") {
    return configuredBackend;
  }
  if (configuredBackend && configuredBackend !== "local") {
    throw new Error(
      "AUDIO_SESSION_CHUNK_STORAGE_BACKEND chỉ hỗ trợ postgres hoặc r2 trong production.",
    );
  }

  return getAudioStorageBackend() === "r2" ? "r2" : "postgres";
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
    cleanupIntervalSeconds: positiveInteger(
      "AUDIO_UPLOAD_CLEANUP_INTERVAL_SECONDS",
      300,
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

export function getR2CredentialsConfig() {
  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.CLOUDFLARE_R2_BUCKET?.trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2 chưa được cấu hình đủ CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY và CLOUDFLARE_R2_BUCKET.",
    );
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
  };
}

export function getR2StorageConfig() {
  const credentials = getR2CredentialsConfig();
  const publicBaseUrl = process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL?.trim()
    .replace(/\/+$/, "");

  if (!publicBaseUrl) {
    throw new Error(
      "AUDIO_STORAGE_BACKEND=r2 cần CLOUDFLARE_R2_PUBLIC_BASE_URL để phát audio cache.",
    );
  }

  return { ...credentials, publicBaseUrl };
}

export function getAudioUploadSecurityConfig() {
  const configuredTokenSecret =
    process.env.AUDIO_UPLOAD_TOKEN_SECRET?.trim() || null;
  const tokenSecret =
    configuredTokenSecret && configuredTokenSecret.length >= 32
      ? configuredTokenSecret
      : null;
  return {
    tokenSecret,
    invalidTokenSecret: Boolean(configuredTokenSecret && !tokenSecret),
    scopedTokensEnabled: Boolean(tokenSecret),
    requireScopedToken: enabled("AUDIO_UPLOAD_REQUIRE_SCOPED_TOKEN"),
    createRequestsPerMinute: positiveInteger(
      "AUDIO_UPLOAD_CREATE_REQUESTS_PER_MINUTE",
      30,
    ),
    sessionRequestsPerMinute: positiveInteger(
      "AUDIO_UPLOAD_SESSION_REQUESTS_PER_MINUTE",
      180,
    ),
  };
}

export function getStorageConfiguration() {
  const persistenceBackend = getPersistenceBackend();
  const audioStorageBackend = getAudioStorageBackend();
  const audioSessionChunkStorageBackend =
    getAudioSessionChunkStorageBackend();
  const r2CredentialsConfigured = Boolean(
    process.env.CLOUDFLARE_R2_ACCOUNT_ID?.trim() &&
      process.env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim() &&
      process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim() &&
      process.env.CLOUDFLARE_R2_BUCKET?.trim(),
  );

  return {
    persistenceBackend,
    audioStorageBackend,
    audioSessionChunkStorageBackend,
    postgresConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    postgresAudioConfigured:
      audioStorageBackend === "postgres" &&
      Boolean(process.env.DATABASE_URL?.trim()),
    blobConfigured: Boolean(
      process.env.GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN?.trim() ||
        process.env.BLOB_READ_WRITE_TOKEN?.trim(),
    ),
    r2CredentialsConfigured,
    r2Configured: Boolean(
      r2CredentialsConfigured &&
        process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL?.trim(),
    ),
    uploadLimits: getAudioUploadLimits(),
  };
}
