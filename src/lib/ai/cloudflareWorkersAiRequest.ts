export type CloudflareWorkersAiEnvelope = {
  result?: {
    text?: unknown;
    word_count?: unknown;
    segments?: unknown;
    vtt?: unknown;
  };
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
};

export const VIETNAMESE_CHILD_ASR_PROMPT =
  "con; mẹ; bố; cô; chú; thầy; bạn; tên; tuổi; uống nước; ăn cơm; màu đỏ; đi chơi; nghe lại; không hiểu; nói chậm lại; cần giúp; quả bóng; con mèo";

export function buildCloudflareAudioTranslationBody(
  audio: ArrayBuffer,
  sourceLanguage: string,
) {
  return {
    audio: Buffer.from(audio).toString("base64"),
    task: "translate",
    language: sourceLanguage,
    vad_filter: true,
    condition_on_previous_text: false,
    initial_prompt:
      "Short everyday speech translated naturally and faithfully into English.",
  } as const;
}

export function buildCloudflareAudioTranscriptionBody(
  audio: ArrayBuffer,
  sourceLanguage: string,
) {
  return {
    audio: Buffer.from(audio).toString("base64"),
    task: "transcribe",
    language: sourceLanguage,
    vad_filter: true,
    condition_on_previous_text: false,
    // A compact vocabulary prompt improves recognition of short Vietnamese child
    // speech without giving Whisper an instruction sentence that it can echo.
    initial_prompt: VIETNAMESE_CHILD_ASR_PROMPT,
    beam_size: 10,
    hallucination_silence_threshold: 0.8,
    // Reject low-confidence/repetitive Whisper segments before they can become a
    // translation or a learned rule.
    no_speech_threshold: 0.55,
    compression_ratio_threshold: 2.2,
    log_prob_threshold: -0.8,
  } as const;
}
