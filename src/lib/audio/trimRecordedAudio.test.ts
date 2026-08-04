import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeMonoPcm16Wav,
  findSpeechBounds,
} from "./trimRecordedAudio";

test("findSpeechBounds removes silence but keeps padding around speech", () => {
  const sampleRate = 1_000;
  const samples = new Float32Array(2_000);
  samples.fill(0.001);
  samples.fill(0.2, 700, 1_200);

  const bounds = findSpeechBounds([samples], sampleRate, 0.001);

  assert.ok(bounds);
  assert.equal(bounds.startSample, 460);
  assert.equal(bounds.endSample, 1_520);
});

test("findSpeechBounds ignores one isolated 20 ms click", () => {
  const sampleRate = 1_000;
  const samples = new Float32Array(1_000);
  samples.fill(0.001);
  samples.fill(0.8, 400, 420);

  assert.equal(findSpeechBounds([samples], sampleRate, 0.001), null);
});

test("encodeMonoPcm16Wav writes a valid mono PCM header", async () => {
  const wav = encodeMonoPcm16Wav(
    [Float32Array.from([0, 0.5, -0.5, 1])],
    16_000,
    0,
    4,
  );
  const bytes = new Uint8Array(await wav.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const view = new DataView(bytes.buffer);

  assert.equal(text.slice(0, 4), "RIFF");
  assert.equal(text.slice(8, 12), "WAVE");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(40, true), 8);
});
