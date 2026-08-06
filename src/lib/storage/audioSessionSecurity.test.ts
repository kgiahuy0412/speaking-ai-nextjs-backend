import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AppError } from "@/lib/appError";
import {
  authorizeAudioSessionRequest,
  issueAudioSessionToken,
  parseAudioSessionCreateConfig,
  validateScopedChunkHeaders,
} from "./audioSessionSecurity";

const originalSecret = process.env.AUDIO_UPLOAD_TOKEN_SECRET;

before(() => {
  process.env.AUDIO_UPLOAD_TOKEN_SECRET = "test-secret-that-is-long-enough-for-hmac";
});

after(() => {
  if (originalSecret === undefined) {
    delete process.env.AUDIO_UPLOAD_TOKEN_SECRET;
  } else {
    process.env.AUDIO_UPLOAD_TOKEN_SECRET = originalSecret;
  }
});

test("scoped token is bound to one audio session and its expiry", () => {
  const config = parseAudioSessionCreateConfig({
    protocolVersion: 2,
    audio: {
      encoding: "pcm_s16le",
      requestedSampleRate: 24_000,
      channelCount: 1,
      bitsPerSample: 16,
      sourceChunkDurationMs: 200,
      maxDurationMs: 12_000,
    },
  });
  assert.ok(config);
  const issued = issueAudioSessionToken("audio_v2-test", config);
  const request = new Request("https://example.test/api/audio", {
    headers: { authorization: `Bearer ${issued.token}` },
  });

  const claims = authorizeAudioSessionRequest(request, "audio_v2-test");
  assert.equal(claims?.sessionId, "audio_v2-test");
  assert.equal(claims?.maxDurationMs, 12_000);
  assert.throws(
    () => authorizeAudioSessionRequest(request, "audio_v2-other"),
    (error: unknown) =>
      error instanceof AppError && error.code === "AUDIO_SESSION_UNAUTHORIZED",
  );
});

test("scoped chunk requires stable idempotency and SHA-256 headers", () => {
  const request = new Request("https://example.test/api/audio", {
    headers: {
      "idempotency-key": "chunk:audio_v2-test:3",
      "x-chunk-sha256": "a".repeat(64),
    },
  });
  assert.equal(
    validateScopedChunkHeaders(request, "audio_v2-test", 3, true),
    "a".repeat(64),
  );
  assert.throws(
    () => validateScopedChunkHeaders(request, "audio_v2-test", 4, true),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "AUDIO_CHUNK_IDEMPOTENCY_INVALID",
  );
});
