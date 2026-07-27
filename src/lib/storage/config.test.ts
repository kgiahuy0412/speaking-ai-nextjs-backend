import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { getPersistenceBackend } from "./config";

const originalPersistenceBackend = process.env.PERSISTENCE_BACKEND;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.PERSISTENCE_BACKEND;
  delete process.env.DATABASE_URL;
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
