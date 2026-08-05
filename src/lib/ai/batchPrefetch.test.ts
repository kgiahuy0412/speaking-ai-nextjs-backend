import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getBatchPrefetchCandidate,
  reserveBatchPrefetchAttempt,
  saveBatchPrefetchCandidate,
} from "./batchPrefetch";

function candidateInput(
  audioSessionId: string,
  sourceText: string,
  chunkCount = 5,
) {
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
      pcmByteLength: chunkCount * 9_600,
      chunkCount,
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
  const replayedSnapshot = saveBatchPrefetchCandidate({
    ...candidateInput(audioSessionId, "Con muốn uống nước"),
    previousPrefetchId: first.id,
  });
  const second = saveBatchPrefetchCandidate({
    ...candidateInput(audioSessionId, first.sourceText, 6),
    previousPrefetchId: replayedSnapshot.id,
  });
  const changed = saveBatchPrefetchCandidate({
    ...candidateInput(audioSessionId, "Con muốn uống sữa"),
    previousPrefetchId: second.id,
  });

  assert.equal(first.stabilityCount, 1);
  assert.equal(replayedSnapshot.stabilityCount, 1);
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
