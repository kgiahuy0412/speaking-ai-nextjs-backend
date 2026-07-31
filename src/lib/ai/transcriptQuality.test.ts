import assert from "node:assert/strict";
import test from "node:test";
import { getVietnameseTranscriptQualityIssue } from "./transcriptQuality";

test("accepts short Vietnamese child speech with and without accents", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue("Con muốn đi chơi công viên."),
    null,
  );
  assert.equal(getVietnameseTranscriptQualityIssue("con muon uong nuoc"), null);
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

test("rejects silence hallucinations before translation", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue("Cảm ơn các bạn đã xem.", [
      { avg_logprob: -0.2, no_speech_prob: 0.05 },
    ]),
    "common_hallucination",
  );
  assert.equal(
    getVietnameseTranscriptQualityIssue("con muốn uống nước", [
      { avg_logprob: -0.55, no_speech_prob: 0.78 },
    ]),
    "no_speech",
  );
});

test("rejects a transcript that cannot fit the recorded duration", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue(
      "con muốn đi công viên cùng với bố mẹ và các bạn vào buổi sáng ngày mai",
      [],
      { utteranceDurationMs: 1000 },
    ),
    "implausible_speaking_rate",
  );
  assert.equal(
    getVietnameseTranscriptQualityIssue("con muốn uống nước", [], {
      utteranceDurationMs: 1500,
    }),
    null,
  );
});
