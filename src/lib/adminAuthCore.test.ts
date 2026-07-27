import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  adminCredentialsMatch,
  createAdminSessionToken,
  verifyAdminSessionToken,
  type AdminCredentials,
} from "./adminAuthCore";

const credentials: AdminCredentials = {
  username: "admin@example.com",
  password: "a-long-test-password",
};
const nowMs = Date.UTC(2026, 6, 27, 12, 0, 0);

test("accepts only the configured username and password", () => {
  assert.equal(adminCredentialsMatch(credentials, credentials), true);
  assert.equal(
    adminCredentialsMatch(
      { ...credentials, username: "another-admin@example.com" },
      credentials,
    ),
    false,
  );
  assert.equal(
    adminCredentialsMatch(
      { ...credentials, password: "the-wrong-password" },
      credentials,
    ),
    false,
  );
});

test("creates a valid session for the configured credentials", () => {
  const token = createAdminSessionToken(credentials, nowMs);

  assert.equal(verifyAdminSessionToken(token, credentials, nowMs), true);
});

test("rejects an expired session", () => {
  const token = createAdminSessionToken(credentials, nowMs);
  const expiredAtMs =
    nowMs + ADMIN_SESSION_MAX_AGE_SECONDS * 1000;

  assert.equal(verifyAdminSessionToken(token, credentials, expiredAtMs), false);
});

test("rejects a tampered session", () => {
  const token = createAdminSessionToken(credentials, nowMs);
  const tamperedToken = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

  assert.equal(
    verifyAdminSessionToken(tamperedToken, credentials, nowMs),
    false,
  );
});

test("changing either environment credential invalidates existing sessions", () => {
  const token = createAdminSessionToken(credentials, nowMs);

  assert.equal(
    verifyAdminSessionToken(
      token,
      { ...credentials, username: "new-admin@example.com" },
      nowMs,
    ),
    false,
  );
  assert.equal(
    verifyAdminSessionToken(
      token,
      { ...credentials, password: "a-new-long-password" },
      nowMs,
    ),
    false,
  );
});

test("rejects malformed and oversized session values", () => {
  assert.equal(verifyAdminSessionToken("not-a-session", credentials, nowMs), false);
  assert.equal(verifyAdminSessionToken("x".repeat(2049), credentials, nowMs), false);
});
