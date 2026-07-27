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
  `ALTER TABLE app_records
    ADD COLUMN IF NOT EXISTS namespace TEXT,
    ADD COLUMN IF NOT EXISTS record_key TEXT,
    ADD COLUMN IF NOT EXISTS client_id TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS value JSONB NOT NULL DEFAULT '{}'::jsonb`,
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
  `ALTER TABLE audio_upload_sessions
    ADD COLUMN IF NOT EXISTS session_id TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uploading'
      CHECK (status IN ('uploading', 'finalizing', 'finalized')),
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS finalize_lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS total_bytes BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chunk_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS request_hash TEXT,
    ADD COLUMN IF NOT EXISTS result JSONB`,
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
  `ALTER TABLE audio_upload_chunks
    ADD COLUMN IF NOT EXISTS session_id TEXT,
    ADD COLUMN IF NOT EXISTS sequence INTEGER,
    ADD COLUMN IF NOT EXISTS sha256 TEXT,
    ADD COLUMN IF NOT EXISTS size_bytes INTEGER,
    ADD COLUMN IF NOT EXISTS content_base64 TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
] as const;
