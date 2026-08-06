import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { AppError } from "@/lib/appError";
import {
  authorizeAudioSessionRequest,
  authorizeWorkerAudioSessionPipeline,
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

test("Worker pipeline transcript requires a fresh server-side HMAC", () => {
  const audioSessionId = "audio_v2-worker-test";
  const snapshotChunkCount = 4;
  const sourceText = "Con muốn uống nước";
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify([
    audioSessionId,
    snapshotChunkCount,
    timestamp,
    sourceText,
  ]);
  const signature = createHmac(
    "sha256",
    process.env.AUDIO_UPLOAD_TOKEN_SECRET!,
  )
    .update(payload)
    .digest("base64url");
  const signedRequest = new Request("https://example.test/api/audio", {
    headers: {
      "x-worker-pipeline-timestamp": timestamp.toString(),
      "x-worker-pipeline-signature": signature,
    },
  });

  assert.doesNotThrow(() =>
    authorizeWorkerAudioSessionPipeline(signedRequest, {
      audioSessionId,
      snapshotChunkCount,
      sourceText,
    }),
  );
  assert.throws(
    () =>
      authorizeWorkerAudioSessionPipeline(signedRequest, {
        audioSessionId,
        snapshotChunkCount,
        sourceText: "Câu bị thay đổi từ trình duyệt",
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === "AUDIO_SESSION_UNAUTHORIZED",
  );
});
