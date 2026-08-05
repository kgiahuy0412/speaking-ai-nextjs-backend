import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resetAudioSessionAsrFlightsForTesting,
  transcribeAudioSessionOnce,
} from "./audioSessionAsr";

const snapshot = {
  sampleRate: 16_000,
  channelCount: 1,
  bitsPerSample: 16,
  pcmByteLength: 32_000,
  chunkCount: 5,
};

test("terminal preview and finalize join one ASR for the same snapshot", async () => {
  resetAudioSessionAsrFlightsForTesting();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transcribe = async () => {
    calls += 1;
    await gate;
    return "Con muốn uống nước";
  };
  const audioSessionId = `audio_v2-${crypto.randomUUID()}`;

  const preview = transcribeAudioSessionOnce({
    audioSessionId,
    snapshot,
    transcribe,
  });
  const finalize = transcribeAudioSessionOnce({
    audioSessionId,
    snapshot,
    transcribe,
  });
  release();
  const [previewResult, finalizeResult] = await Promise.all([preview, finalize]);

  assert.equal(calls, 1);
  assert.equal(previewResult.sourceText, finalizeResult.sourceText);
  assert.equal(previewResult.joined, false);
  assert.equal(finalizeResult.joined, true);
});

test("a newer PCM snapshot owns a separate ASR flight", async () => {
  resetAudioSessionAsrFlightsForTesting();
  let calls = 0;
  const transcribe = async () => {
    calls += 1;
    return `transcript-${calls}`;
  };
  const audioSessionId = `audio_v2-${crypto.randomUUID()}`;

  await transcribeAudioSessionOnce({ audioSessionId, snapshot, transcribe });
  await transcribeAudioSessionOnce({
    audioSessionId,
    snapshot: {
      ...snapshot,
      chunkCount: 6,
      pcmByteLength: 38_400,
    },
    transcribe,
  });

  assert.equal(calls, 2);
});
