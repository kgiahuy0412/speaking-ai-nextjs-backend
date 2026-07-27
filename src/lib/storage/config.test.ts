import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { getAudioStorageBackend, getPersistenceBackend } from "./config";

const originalPersistenceBackend = process.env.PERSISTENCE_BACKEND;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAudioStorageBackend = process.env.AUDIO_STORAGE_BACKEND;

beforeEach(() => {
  delete process.env.PERSISTENCE_BACKEND;
  delete process.env.DATABASE_URL;
  delete process.env.AUDIO_STORAGE_BACKEND;
});

after(() => {
  if (originalPersistenceBackend === undefined) {
    delete process.env.PERSISTENCE_BACKEND;
  } else {
    process.env.PERSISTENCE_BACKEND = originalPersistenceBackend;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalAudioStorageBackend === undefined) {
    delete process.env.AUDIO_STORAGE_BACKEND;
  } else {
    process.env.AUDIO_STORAGE_BACKEND = originalAudioStorageBackend;
  }
});

test("uses PostgreSQL automatically when DATABASE_URL is configured", () => {
  process.env.DATABASE_URL = "postgresql://example.invalid/database";

  assert.equal(getPersistenceBackend(), "postgres");
});

test("keeps local storage when no database is configured", () => {
  assert.equal(getPersistenceBackend(), "local");
});

test("an explicit backend overrides automatic detection", () => {
  process.env.DATABASE_URL = "postgresql://example.invalid/database";
  process.env.PERSISTENCE_BACKEND = "local";

  assert.equal(getPersistenceBackend(), "local");

  process.env.PERSISTENCE_BACKEND = "postgres";
  assert.equal(getPersistenceBackend(), "postgres");
});

test("uses PostgreSQL for generated audio when DATABASE_URL is configured", () => {
  process.env.DATABASE_URL = "postgresql://example.invalid/database";

  assert.equal(getAudioStorageBackend(), "postgres");

  process.env.AUDIO_STORAGE_BACKEND = "local";
  assert.equal(getAudioStorageBackend(), "local");
});
