import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getBatchPrefetchCandidate,
  reserveBatchPrefetchAttempt,
  saveBatchPrefetchCandidate,
} from "./batchPrefetch";

function candidateInput(audioSessionId: string, sourceText: string) {
  return {
    audioSessionId,
    context: "home" as const,
    childAge: 6,
    sourceText,
    translation: {
      englishText: "Can I have some water, please?",
      mode: "rule" as const,
      source: "phrase_rule" as const,
    },
    audioUrl: "/generated-audio/water.mp3",
    audioSource: "cache" as const,
    snapshot: {
      sampleRate: 24_000,
      channelCount: 1,
      bitsPerSample: 16 as const,
      pcmByteLength: 48_000,
      chunkCount: 5,
    },
    previewLatencyMs: 400,
    asrLatencyMs: 350,
  };
}

test("prefetch becomes stable only after the same safe result repeats", () => {
  const audioSessionId = `audio_v2-${crypto.randomUUID()}`;
  const first = saveBatchPrefetchCandidate(
    candidateInput(audioSessionId, "Con muốn uống nước."),
  );
  const second = saveBatchPrefetchCandidate({
    ...candidateInput(audioSessionId, "Con muốn uống nước"),
    previousPrefetchId: first.id,
  });
  const changed = saveBatchPrefetchCandidate({
    ...candidateInput(audioSessionId, "Con muốn uống sữa"),
    previousPrefetchId: second.id,
  });

  assert.equal(first.stabilityCount, 1);
  assert.equal(second.stabilityCount, 2);
  assert.equal(changed.stabilityCount, 1);
  assert.equal(getBatchPrefetchCandidate(second.id, audioSessionId)?.id, second.id);
  assert.equal(
    getBatchPrefetchCandidate(second.id, `audio_v2-${crypto.randomUUID()}`),
    null,
  );
});

test("prefetch attempts are throttled per audio session", () => {
  const audioSessionId = `audio_v2-${crypto.randomUUID()}`;

  assert.equal(reserveBatchPrefetchAttempt(audioSessionId), true);
  assert.equal(reserveBatchPrefetchAttempt(audioSessionId), false);
});

test("prefetch stability does not depend on deferred audio", () => {
  const audioSessionId = `audio_v2-${crypto.randomUUID()}`;
  const first = saveBatchPrefetchCandidate({
    ...candidateInput(audioSessionId, "Con muốn uống nước."),
    audioUrl: null,
    audioSource: null,
  });
  const second = saveBatchPrefetchCandidate({
    ...candidateInput(audioSessionId, "Con muốn uống nước"),
    audioUrl: null,
    audioSource: null,
    previousPrefetchId: first.id,
  });

  assert.equal(second.stabilityCount, 2);
  assert.equal(second.audioUrl, null);
  assert.equal(second.audioSource, null);
});
