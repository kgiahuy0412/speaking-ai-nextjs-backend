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
