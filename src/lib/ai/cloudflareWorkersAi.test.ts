import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCloudflareAudioTranscriptionBody,
  buildCloudflareAudioTranslationBody,
  classifyCloudflareTranscriptionResponse,
  resolveCloudflareAsrVadPolicy,
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
  assert.equal(body.no_speech_threshold, 0.55);
  assert.equal(body.compression_ratio_threshold, 2.2);
  assert.equal(body.log_prob_threshold, -0.8);
  assert.equal("initial_prompt" in body, false);
});

test("does not run Cloudflare VAD after Flutter already confirmed speech", () => {
  const bytes = Buffer.from("audio bytes");
  const audio = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const policy = resolveCloudflareAsrVadPolicy({
    clientVadApplied: true,
  });
  const body = buildCloudflareAudioTranscriptionBody(audio, "vi", {
    vadFilter: policy.vadFilter,
  });

  assert.equal(policy.mode, "client");
  assert.equal(policy.reason, "client_vad_confirmed");
  assert.equal(body.vad_filter, false);
});

test("keeps Cloudflare VAD for legacy or raw audio", () => {
  const policy = resolveCloudflareAsrVadPolicy({});

  assert.equal(policy.mode, "client");
  assert.equal(policy.reason, "cloudflare_vad_required");
  assert.equal(policy.vadFilter, true);
});

test("can force Cloudflare VAD for an A/B comparison or rollback", () => {
  const policy = resolveCloudflareAsrVadPolicy({
    clientVadApplied: true,
    configuredMode: "cloudflare",
  });

  assert.equal(policy.mode, "cloudflare");
  assert.equal(policy.reason, "cloudflare_vad_required");
  assert.equal(policy.vadFilter, true);
});

test("classifies a successful empty Cloudflare transcript as unclear speech", () => {
  assert.equal(
    classifyCloudflareTranscriptionResponse({
      responseOk: true,
      success: true,
      transcript: "",
    }),
    "unclear_speech",
  );
  assert.equal(
    classifyCloudflareTranscriptionResponse({
      responseOk: true,
      success: true,
      transcript: "Con muốn uống nước.",
    }),
    null,
  );
});
