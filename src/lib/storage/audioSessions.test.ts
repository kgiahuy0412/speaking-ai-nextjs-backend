import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let testRoot = "";
let originalWorkingDirectory = "";
let sessions: typeof import("./audioSessions");

before(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "ai-speaking-upload-"));
  originalWorkingDirectory = process.cwd();
  process.chdir(testRoot);
  process.env.PERSISTENCE_BACKEND = "local";
  process.env.AUDIO_UPLOAD_MAX_CHUNK_BYTES = "1048576";
  process.env.AUDIO_UPLOAD_MAX_SESSION_BYTES = "16777216";
  process.env.AUDIO_UPLOAD_MAX_CHUNKS = "1000";
  process.env.AUDIO_UPLOAD_SESSION_TTL_SECONDS = "900";
  sessions = await import("./audioSessions");
});

beforeEach(() => {
  process.env.AUDIO_UPLOAD_MAX_CHUNK_BYTES = "1048576";
  process.env.AUDIO_UPLOAD_MAX_SESSION_BYTES = "16777216";
  process.env.AUDIO_UPLOAD_MAX_CHUNKS = "1000";
  process.env.AUDIO_UPLOAD_SESSION_TTL_SECONDS = "900";
});

after(async () => {
  process.chdir(originalWorkingDirectory);
  await rm(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("chunk retry is idempotent and conflicting content is rejected", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  const first = await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from("header")], "header.wav"),
  );
  const duplicate = await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from("header")], "header.wav"),
  );

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    () =>
      sessions.saveAudioSessionChunk(
        sessionId,
        0,
        new File([Buffer.from("different")], "header.wav"),
      ),
    (error: unknown) =>
      error instanceof sessions.AudioUploadError &&
      error.code === "CHUNK_CONFLICT",
  );
});

test("finalize rejects a missing chunk sequence", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from("header")], "header.wav"),
  );
  await sessions.saveAudioSessionChunk(
    sessionId,
    2,
    new File([Buffer.from("audio")], "chunk.pcm"),
  );

  await assert.rejects(
    () => sessions.finalizeAudioUploadSession(sessionId, "audio/wav"),
    (error: unknown) =>
      error instanceof sessions.AudioUploadError &&
      error.code === "MISSING_CHUNKS",
  );
});

test("finalize builds a WAV header from PCM metadata without a header chunk", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from([1, 2])], "chunk-0.pcm"),
  );
  await sessions.saveAudioSessionChunk(
    sessionId,
    1,
    new File([Buffer.from([3, 4])], "chunk-1.pcm"),
  );

  const file = await sessions.finalizeAudioUploadSession(
    sessionId,
    "audio/wav",
    {
      sampleRate: 48_000,
      channelCount: 1,
      bitsPerSample: 16,
      pcmByteLength: 4,
    },
  );
  const bytes = Buffer.from(await file.arrayBuffer());

  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.readUInt32LE(24), 48_000);
  assert.equal(bytes.readUInt32LE(40), 4);
  assert.deepEqual([...bytes.subarray(44)], [1, 2, 3, 4]);
});

test("finalize accepts AAC audio for batch uploads", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from("aac-audio")], "speech.aac", {
      type: "audio/aac",
    }),
  );

  const file = await sessions.finalizeAudioUploadSession(
    sessionId,
    "audio/aac",
  );

  assert.equal(file.name, "speech.aac");
  assert.equal(file.type, "audio/aac");
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "aac-audio");
});

test("finalize accepts other declared audio MIME types", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from("custom-audio")], "speech.custom"),
  );

  const file = await sessions.finalizeAudioUploadSession(
    sessionId,
    "audio/x-custom-codec",
  );

  assert.equal(file.name, "speech.custom-codec");
  assert.equal(file.type, "audio/x-custom-codec");
});

test("finalize rejects PCM metadata with a mismatched byte length", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from([1, 2])], "chunk-0.pcm"),
  );

  await assert.rejects(
    () =>
      sessions.finalizeAudioUploadSession(sessionId, "audio/wav", {
        sampleRate: 48_000,
        channelCount: 1,
        bitsPerSample: 16,
        pcmByteLength: 4,
      }),
    (error: unknown) =>
      error instanceof sessions.AudioUploadError &&
      error.code === "INVALID_PCM_METADATA",
  );
});

test("chunk and session byte limits are enforced", async () => {
  process.env.AUDIO_UPLOAD_MAX_CHUNK_BYTES = "4";
  const chunkLimitedSession = await sessions.createAudioUploadSession();
  await assert.rejects(
    () =>
      sessions.saveAudioSessionChunk(
        chunkLimitedSession,
        0,
        new File([Buffer.alloc(5)], "large.pcm"),
      ),
    (error: unknown) =>
      error instanceof sessions.AudioUploadError &&
      error.code === "CHUNK_TOO_LARGE",
  );

  process.env.AUDIO_UPLOAD_MAX_CHUNK_BYTES = "8";
  process.env.AUDIO_UPLOAD_MAX_SESSION_BYTES = "6";
  const sessionLimitedSession = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionLimitedSession,
    0,
    new File([Buffer.alloc(4)], "first.pcm"),
  );
  await assert.rejects(
    () =>
      sessions.saveAudioSessionChunk(
        sessionLimitedSession,
        1,
        new File([Buffer.alloc(4)], "second.pcm"),
      ),
    (error: unknown) =>
      error instanceof sessions.AudioUploadError &&
      error.code === "SESSION_TOO_LARGE",
  );
});

test("finalize result can be replayed safely with the same request hash", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from("wav")], "speech.wav"),
  );

  assert.deepEqual(
    await sessions.claimAudioSessionFinalize(sessionId, "same-hash"),
    { state: "claimed" },
  );
  const file = await sessions.finalizeAudioUploadSession(sessionId, "audio/wav");
  assert.equal(file.name, "speech.wav");
  await sessions.completeAudioSessionFinalize(sessionId, "same-hash", {
    conversationId: "conversation_test",
  });

  assert.deepEqual(
    await sessions.claimAudioSessionFinalize(sessionId, "same-hash"),
    {
      state: "completed",
      result: { conversationId: "conversation_test" },
    },
  );
  await assert.rejects(
    () => sessions.claimAudioSessionFinalize(sessionId, "different-hash"),
    (error: unknown) =>
      error instanceof sessions.AudioUploadError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("unsupported final audio mime type is rejected", async () => {
  const sessionId = await sessions.createAudioUploadSession();
  await sessions.saveAudioSessionChunk(
    sessionId,
    0,
    new File([Buffer.from("audio")], "speech.bin"),
  );

  await assert.rejects(
    () =>
      sessions.finalizeAudioUploadSession(
        sessionId,
        "application/octet-stream",
      ),
    (error: unknown) =>
      error instanceof sessions.AudioUploadError &&
      error.code === "UNSUPPORTED_AUDIO_TYPE",
  );
});
