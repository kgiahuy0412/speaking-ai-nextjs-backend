import assert from "node:assert/strict";
import test from "node:test";
import { getVietnameseTranscriptQualityIssue } from "./transcriptQuality";

test("accepts short Vietnamese child speech with and without accents", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue("Con muốn đi chơi công viên."),
    null,
  );
  assert.equal(
    getVietnameseTranscriptQualityIssue("con muon uong nuoc"),
    null,
  );
});

test("rejects the old Whisper instruction prompt echo", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue(
      "Vietnamese child speaking short everyday phrases. Preserve every word.",
    ),
    "prompt_echo",
  );
});

test("rejects an English-only result in the Vietnamese ASR path", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue("Hello, how are you?"),
    "unexpected_english",
  );
});

test("rejects low-confidence Whisper segments", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue("con muốn đi chơi", [
      { avg_logprob: -1.2, no_speech_prob: 0.1 },
    ]),
    "low_log_probability",
  );
  assert.equal(
    getVietnameseTranscriptQualityIssue("con muốn đi chơi", [
      { avg_logprob: -0.3, no_speech_prob: 0.1 },
    ]),
    null,
  );
});
