import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type AdminCredentials = {
  username: string;
  password: string;
};

export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const SESSION_VERSION = "v1";
const SESSION_KEY_CONTEXT = "ai-speaking-admin-session-v1";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeValueEquals(candidate: string, expected: string) {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

function sessionSigningKey(credentials: AdminCredentials) {
  return sha256(
    `${SESSION_KEY_CONTEXT}\0${credentials.username}\0${credentials.password}`,
  );
}

function sign(payload: string, credentials: AdminCredentials) {
  return createHmac("sha256", sessionSigningKey(credentials))
    .update(payload, "utf8")
    .digest("base64url");
}

export function adminCredentialsMatch(
  candidate: AdminCredentials,
  expected: AdminCredentials,
) {
  const usernameMatches = safeValueEquals(
    candidate.username,
    expected.username,
  );
  const passwordMatches = safeValueEquals(
    candidate.password,
    expected.password,
  );

  return usernameMatches && passwordMatches;
}

export function createAdminSessionToken(
  credentials: AdminCredentials,
  nowMs = Date.now(),
) {
  const expiresAt =
    Math.floor(nowMs / 1000) + ADMIN_SESSION_MAX_AGE_SECONDS;
  const encodedUsername = Buffer.from(credentials.username, "utf8").toString(
    "base64url",
  );
  const payload = `${SESSION_VERSION}.${expiresAt}.${encodedUsername}`;

  return `${payload}.${sign(payload, credentials)}`;
}

export function verifyAdminSessionToken(
  token: string,
  credentials: AdminCredentials,
  nowMs = Date.now(),
) {
  if (!token || token.length > 2048) {
    return false;
  }

  const [version, rawExpiresAt, encodedUsername, signature, extra] =
    token.split(".");
  if (
    extra !== undefined ||
    version !== SESSION_VERSION ||
    !/^\d+$/.test(rawExpiresAt ?? "") ||
    !encodedUsername ||
    !signature
  ) {
    return false;
  }

  const expiresAt = Number(rawExpiresAt);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) {
    return false;
  }

  let tokenUsername: string;
  try {
    tokenUsername = Buffer.from(encodedUsername, "base64url").toString("utf8");
  } catch {
    return false;
  }

  const payload = `${version}.${rawExpiresAt}.${encodedUsername}`;
  const expectedSignature = sign(payload, credentials);

  return (
    safeValueEquals(tokenUsername, credentials.username) &&
    safeValueEquals(signature, expectedSignature)
  );
}
