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

export function classifyCloudflareTranscriptionResponse(input: {
  responseOk: boolean;
  success: boolean | undefined;
  transcript: string;
}) {
  if (!input.responseOk || input.success === false) {
    return "provider_error" as const;
  }
  if (!input.transcript.trim()) {
    return "unclear_speech" as const;
  }
  return null;
}

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
    // Client VAD has already confirmed speech. These values stay conservative
    // against noise while avoiding false rejection of short or quiet child
    // speech. They also align with the server-side transcript validator.
    no_speech_threshold: 0.55,
    compression_ratio_threshold: 2.2,
    log_prob_threshold: -0.8,
  } as const;
}
