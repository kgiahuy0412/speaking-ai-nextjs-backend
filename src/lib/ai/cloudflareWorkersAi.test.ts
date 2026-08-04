import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCloudflareAudioTranscriptionBody,
  buildCloudflareAudioTranslationBody,
  VIETNAMESE_CHILD_ASR_PROMPT,
} from "./cloudflareWorkersAiRequest";

test("builds a Cloudflare request for English audio translation", () => {
  const bytes = Buffer.from("audio bytes");
  const audio = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const body = buildCloudflareAudioTranslationBody(audio, "vi");

  assert.equal(body.audio, bytes.toString("base64"));
  assert.equal(body.task, "translate");
  assert.equal(body.language, "vi");
  assert.equal(body.vad_filter, true);
  assert.equal(body.condition_on_previous_text, false);
});

test("builds a Cloudflare request for faithful Vietnamese transcription", () => {
  const bytes = Buffer.from("audio bytes");
  const audio = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const body = buildCloudflareAudioTranscriptionBody(audio, "vi");

  assert.equal(body.audio, bytes.toString("base64"));
  assert.equal(body.task, "transcribe");
  assert.equal(body.language, "vi");
  assert.equal(body.vad_filter, true);
  assert.equal(body.condition_on_previous_text, false);
  assert.equal(body.initial_prompt, VIETNAMESE_CHILD_ASR_PROMPT);
  assert.equal(body.beam_size, 10);
  assert.equal(body.hallucination_silence_threshold, 0.8);
  assert.equal(body.no_speech_threshold, 0.55);
  assert.equal(body.compression_ratio_threshold, 2.2);
  assert.equal(body.log_prob_threshold, -0.8);
  assert.equal(body.initial_prompt.includes("Vietnamese child speaking"), false);
});
