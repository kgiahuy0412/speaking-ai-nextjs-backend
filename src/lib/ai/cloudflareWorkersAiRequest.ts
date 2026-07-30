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
    // These thresholds reject low-confidence/repetitive Whisper segments before
    // they can become a translation or a learned rule. Keep the language hint,
    // but deliberately avoid an instruction-style initial_prompt: Whisper may
    // echo that prompt when the recording is quiet or mostly noise.
    no_speech_threshold: 0.55,
    compression_ratio_threshold: 2.2,
    log_prob_threshold: -0.8,
  } as const;
}
