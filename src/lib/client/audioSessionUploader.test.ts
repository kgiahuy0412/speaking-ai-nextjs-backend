import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserAudioSessionUploader,
  supportsProgressiveEncodedAudioUpload,
} from "./audioSessionUploader";

test("progressive upload is limited to concatenation-safe web formats", () => {
  assert.equal(
    supportsProgressiveEncodedAudioUpload("audio/webm;codecs=opus"),
    true,
  );
  assert.equal(supportsProgressiveEncodedAudioUpload("audio/ogg"), true);
  assert.equal(supportsProgressiveEncodedAudioUpload("audio/mp4"), false);
});

test("uploads ordered chunks and finalizes the same scoped session", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let clock = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    clock += 10;
    if (url === "/api/audio-sessions") {
      return Response.json({
        audioSessionId: "audio_v2-test",
        uploadToken: "payload.signature",
        capabilities: {
          chunkChecksumSha256: true,
          missingChunkRecovery: true,
          scopedUploadToken: true,
          uploadProtocolVersion: 2,
          chunkStorageBackend: "r2",
        },
      });
    }
    if (url.endsWith("/finalize")) {
      return Response.json({ conversationId: "conv_test" });
    }
    return Response.json({ uploaded: true });
  };
  const uploader = new BrowserAudioSessionUploader({
    mimeType: "audio/webm;codecs=opus",
    requestedSampleRate: 48_000,
    fetchImpl,
    now: () => clock,
  });
  uploader.enqueue(new Blob(["first"], { type: "audio/webm" }));
  uploader.enqueue(new Blob(["second"], { type: "audio/webm" }));

  const stats = await uploader.drain(0);
  const response = await uploader.finalize({ context: "home" });

  assert.equal(response.ok, true);
  assert.equal(stats.transportChunkCount, 2);
  assert.equal(stats.uploadedAudioBytes, 11);
  assert.equal(stats.uploadProtocolVersion, 2);
  assert.equal(stats.chunkStorageBackend, "r2");
  const chunkRequests = requests.filter((request) =>
    request.url.endsWith("/chunks"),
  );
  assert.equal(chunkRequests.length, 2);
  assert.equal(
    (chunkRequests[0].init?.headers as Record<string, string>).Authorization,
    "Bearer payload.signature",
  );
  assert.deepEqual(
    chunkRequests
      .map(
        (request) =>
          (request.init?.headers as Record<string, string>)["Idempotency-Key"],
      )
      .sort(),
    ["chunk:audio_v2-test:0", "chunk:audio_v2-test:1"],
  );
});

test("retries a transient chunk failure with the same idempotency key", async () => {
  let chunkAttempts = 0;
  const idempotencyKeys: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/audio-sessions") {
      return Response.json({ audioSessionId: "audio_test" });
    }
    if (url.endsWith("/chunks")) {
      chunkAttempts += 1;
      idempotencyKeys.push(
        (init?.headers as Record<string, string>)["Idempotency-Key"],
      );
      if (chunkAttempts === 1) {
        return Response.json(
          { error: { message: "temporary failure" } },
          { status: 503 },
        );
      }
    }
    return Response.json({ uploaded: true });
  };
  const uploader = new BrowserAudioSessionUploader({
    mimeType: "audio/webm",
    requestedSampleRate: 48_000,
    fetchImpl,
  });
  uploader.enqueue(new Blob(["audio"], { type: "audio/webm" }));

  const stats = await uploader.drain(performance.now());

  assert.equal(stats.chunkRetryCount, 1);
  assert.deepEqual(idempotencyKeys, [
    "chunk:audio_test:0",
    "chunk:audio_test:0",
  ]);
});
