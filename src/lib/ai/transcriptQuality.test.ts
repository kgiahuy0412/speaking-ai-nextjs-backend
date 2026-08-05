import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("rejects common video-outro hallucinations from quiet child audio", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue(
      "Hãy subscribe cho kênh La La School để không bỏ lỡ những video hấp dẫn",
    ),
    "common_hallucination",
  );
  assert.equal(
    getVietnameseTranscriptQualityIssue(
      "Cảm ơn các bạn đã theo dõi và hẹn gặp lại trong video tiếp theo.",
    ),
    "common_hallucination",
  );
});

test("accepts a legitimate short goodbye", () => {
  assert.equal(getVietnameseTranscriptQualityIssue("Hẹn gặp lại nhé."), null);
});

test("keeps a short repeated child phrase when there is too little evidence to reject it", () => {
  assert.equal(
    getVietnameseTranscriptQualityIssue("cơm cơm"),
    null,
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

test("rejects stock hallucinations found in the Cloudflare child-audio audit", () => {
  const hallucinations = [
    "Hãy subscribe cho kênh La La School để không bỏ lỡ những video hấp dẫn.",
    "Các bạn hãy đăng ký kênh để ủng hộ kênh của mình nhé.",
    "Cảm ơn các bạn đã xem video này.",
    "Cảm ơn các bạn đã theo dõi và hẹn gặp lại trong những video tiếp theo.",
    "Phụ đề được thực hiện bởi Amara.org.",
  ];

  for (const transcript of hallucinations) {
    assert.equal(
      getVietnameseTranscriptQualityIssue(transcript),
      "common_hallucination",
      transcript,
    );
  }
});

test("does not block legitimate child phrases that mention video or meeting again", () => {
  const validPhrases = [
    "Con muốn xem video về con mèo.",
    "Con muốn đăng ký học bơi.",
    "Hẹn gặp lại mẹ sau giờ học.",
  ];

  for (const transcript of validPhrases) {
    assert.equal(getVietnameseTranscriptQualityIssue(transcript), null);
  }
});

test("pipeline validates ASR before translation and TTS", async () => {
  const asrSource = await readFile(new URL("./asr.ts", import.meta.url), "utf8");
  const pipelineSource = await readFile(
    new URL("./pipeline.ts", import.meta.url),
    "utf8",
  );

  assert.match(asrSource, /getVietnameseTranscriptQualityIssue/);
  assert.match(asrSource, /"ASR_LOW_CONFIDENCE"/);
  assert.ok(
    pipelineSource.indexOf("transcribeVietnamese(input)") <
      pipelineSource.indexOf("generateEnglishSentence("),
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
