export const managedStorageSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS app_records (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    client_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1,
    value JSONB NOT NULL,
    PRIMARY KEY (namespace, record_key)
  )`,
  `CREATE INDEX IF NOT EXISTS app_records_namespace_created_idx
    ON app_records (namespace, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS app_records_namespace_client_idx
    ON app_records (namespace, client_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS app_records_expires_idx
    ON app_records (expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS audio_upload_sessions (
    session_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('uploading', 'finalizing', 'finalized')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    finalize_lease_until TIMESTAMPTZ,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    request_hash TEXT,
    result JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS audio_upload_sessions_expires_idx
    ON audio_upload_sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS audio_upload_chunks (
    session_id TEXT NOT NULL REFERENCES audio_upload_sessions(session_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    content_base64 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, sequence)
  )`,
] as const;
