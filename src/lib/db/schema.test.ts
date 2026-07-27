import assert from "node:assert/strict";
import test from "node:test";
import { managedStorageSchemaStatements } from "./schema";

const expectedColumns = {
  app_records: [
    "namespace",
    "record_key",
    "client_id",
    "created_at",
    "updated_at",
    "expires_at",
    "revision",
    "value",
  ],
  audio_upload_sessions: [
    "session_id",
    "status",
    "created_at",
    "updated_at",
    "expires_at",
    "finalize_lease_until",
    "total_bytes",
    "chunk_count",
    "request_hash",
    "result",
  ],
  audio_upload_chunks: [
    "session_id",
    "sequence",
    "sha256",
    "size_bytes",
    "content_base64",
    "created_at",
  ],
  generated_audio: [
    "file_name",
    "content_base64",
    "content_type",
    "size_bytes",
    "created_at",
    "updated_at",
  ],
} as const;

test("managed schema creates every required table", () => {
  for (const table of Object.keys(expectedColumns)) {
    assert.ok(
      managedStorageSchemaStatements.some((statement) =>
        statement.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      ),
      `missing idempotent CREATE TABLE for ${table}`,
    );
  }
});

test("managed schema adds every missing column idempotently", () => {
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const alterStatement = managedStorageSchemaStatements.find((statement) =>
      statement.includes(`ALTER TABLE ${table}`),
    );

    assert.ok(alterStatement, `missing ALTER TABLE for ${table}`);

    for (const column of columns) {
      assert.match(
        alterStatement,
        new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`),
        `missing idempotent column ${table}.${column}`,
      );
    }
  }
});
