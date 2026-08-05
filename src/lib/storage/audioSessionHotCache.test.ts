import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getHotAudioCacheStatsForTesting,
  readHotAudioPrefix,
  readHotAudioTail,
  rememberHotAudioChunk,
  resetHotAudioCacheForTesting,
} from "./audioSessionHotCache";

const expiresAt = () => Date.now() + 60_000;

describe("audio session hot cache", () => {
  beforeEach(() => {
    resetHotAudioCacheForTesting();
    delete process.env.AUDIO_SESSION_HOT_CACHE_MAX_BYTES;
  });

  afterEach(() => {
    resetHotAudioCacheForTesting();
    delete process.env.AUDIO_SESSION_HOT_CACHE_MAX_BYTES;
  });

  it("returns an exact contiguous PCM prefix and owns its retained bytes", () => {
    const first = Buffer.from([1, 2]);
    assert.equal(
      rememberHotAudioChunk({
        sessionId: "audio_test",
        sequence: 0,
        sha256: "sha-0",
        bytes: first,
        expiresAt: expiresAt(),
      }),
      true,
    );
    rememberHotAudioChunk({
      sessionId: "audio_test",
      sequence: 1,
      sha256: "sha-1",
      bytes: Buffer.from([3, 4]),
      expiresAt: expiresAt(),
    });
    first[0] = 99;

    assert.deepEqual(
      readHotAudioPrefix({
        sessionId: "audio_test",
        chunkCount: 2,
        pcmByteLength: 4,
      }),
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("allows a preview prefix but requires an exact final session", () => {
    for (let sequence = 0; sequence < 2; sequence += 1) {
      rememberHotAudioChunk({
        sessionId: "audio_preview",
        sequence,
        sha256: `sha-${sequence}`,
        bytes: Buffer.from([sequence, sequence]),
        expiresAt: expiresAt(),
      });
    }

    assert.deepEqual(
      readHotAudioPrefix({
        sessionId: "audio_preview",
        chunkCount: 1,
        pcmByteLength: 2,
        allowTrailingChunks: true,
      }),
      Buffer.from([0, 0]),
    );
    assert.equal(
      readHotAudioPrefix({
        sessionId: "audio_preview",
        chunkCount: 1,
        pcmByteLength: 2,
      }),
      null,
    );
  });

  it("returns only a byte-accurate final tail", () => {
    for (let sequence = 0; sequence < 3; sequence += 1) {
      rememberHotAudioChunk({
        sessionId: "audio_tail",
        sequence,
        sha256: `sha-${sequence}`,
        bytes: Buffer.from([sequence, sequence]),
        expiresAt: expiresAt(),
      });
    }

    assert.deepEqual(
      readHotAudioTail({
        sessionId: "audio_tail",
        snapshotChunkCount: 2,
        snapshotPcmByteLength: 4,
        finalChunkCount: 3,
        finalPcmByteLength: 6,
      }),
      {
        tail: Buffer.from([2, 2]),
        extraChunkCount: 1,
      },
    );
    assert.equal(
      readHotAudioTail({
        sessionId: "audio_tail",
        snapshotChunkCount: 2,
        snapshotPcmByteLength: 3,
        finalChunkCount: 3,
        finalPcmByteLength: 6,
      }),
      null,
    );
  });

  it("drops a shadow session on a conflicting duplicate", () => {
    rememberHotAudioChunk({
      sessionId: "audio_conflict",
      sequence: 0,
      sha256: "first",
      bytes: Buffer.from([1, 2]),
      expiresAt: expiresAt(),
    });

    assert.equal(
      rememberHotAudioChunk({
        sessionId: "audio_conflict",
        sequence: 0,
        sha256: "different",
        bytes: Buffer.from([8, 9]),
        expiresAt: expiresAt(),
      }),
      false,
    );
    assert.deepEqual(getHotAudioCacheStatsForTesting(), {
      sessionCount: 0,
      totalBytes: 0,
    });
  });

  it("evicts least-recently-used sessions when the byte budget is exceeded", () => {
    process.env.AUDIO_SESSION_HOT_CACHE_MAX_BYTES = "3";
    rememberHotAudioChunk({
      sessionId: "audio_old",
      sequence: 0,
      sha256: "old",
      bytes: Buffer.from([1, 2]),
      expiresAt: expiresAt(),
    });
    rememberHotAudioChunk({
      sessionId: "audio_new",
      sequence: 0,
      sha256: "new",
      bytes: Buffer.from([3, 4]),
      expiresAt: expiresAt(),
    });

    assert.equal(
      readHotAudioPrefix({
        sessionId: "audio_old",
        chunkCount: 1,
        pcmByteLength: 2,
      }),
      null,
    );
    assert.deepEqual(
      readHotAudioPrefix({
        sessionId: "audio_new",
        chunkCount: 1,
        pcmByteLength: 2,
      }),
      Buffer.from([3, 4]),
    );
  });
});
