import assert from "node:assert/strict";
import test from "node:test";
import { buildCloudflareAudioTranslationBody } from "./cloudflareWorkersAiRequest";

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
