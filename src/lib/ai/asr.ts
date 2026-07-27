import type { ConversationRequest } from "@/types/conversation";
import { AppError } from "@/lib/errors";
import { delay } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import { getOpenAIClient } from "./openai";
import { transcribeAudioToVietnamese } from "./cloudflareWorkersAi";
import { sampleVietnameseByContext } from "./prompts";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import { repairVietnameseChildTranscript } from "./transcriptRepair";

function assertVietnameseTranscript(text: string) {
  if (!containsUnexpectedEastAsianScript(text)) {
    return;
  }

  throw new AppError(
    "ASR_LOW_CONFIDENCE",
    "Nhận diện giọng nói chưa đúng tiếng Việt. Vui lòng nói lại gần micro hơn.",
  );
}

function getPrimaryAsrProvider() {
  return process.env.AI_ASR_PRIMARY_PROVIDER === "openai"
    ? "openai"
    : "cloudflare";
}

async function transcribeWithOpenAI(audioFile: File) {
  const client = getOpenAIClient();
  const model = process.env.OPENAI_ASR_MODEL ?? "gpt-4o-mini-transcribe";
  const transcription = await client.audio.transcriptions.create(
    {
      file: audioFile,
      model,
      language: "vi",
      prompt:
        "Vietnamese child speaking short everyday phrases. Preserve the addressee, subject, negation, objects, locations, and question form.",
    },
    { timeout: 15_000 },
  );
  return { text: transcription.text.trim(), model };
}

async function transcribeAudio(input: ConversationRequest) {
  const audioFile = input.audioFile!;
  const primaryProvider = getPrimaryAsrProvider();

  if (primaryProvider === "cloudflare") {
    const startedAt = performance.now();
    try {
      const result = await transcribeAudioToVietnamese(audioFile);
      assertVietnameseTranscript(result.vietnameseText);
      logEvent("info", "asr_provider_latency", {
        requestId: input.requestId,
        provider: "cloudflare",
        model: result.model,
        latencyMs: Math.round(performance.now() - startedAt),
        fallbackUsed: false,
      });
      return result.vietnameseText;
    } catch (error) {
      logEvent("warn", "asr_provider_fallback", {
        requestId: input.requestId,
        primaryProvider: "cloudflare",
        fallbackProvider: "openai",
        latencyMs: Math.round(performance.now() - startedAt),
        reason: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  const startedAt = performance.now();
  const result = await transcribeWithOpenAI(audioFile);
  logEvent("info", "asr_provider_latency", {
    requestId: input.requestId,
    provider: "openai",
    model: result.model,
    latencyMs: Math.round(performance.now() - startedAt),
    fallbackUsed: primaryProvider === "cloudflare",
  });
  return result.text;
}

export async function transcribeVietnamese(input: ConversationRequest) {
  if (input.sourceText?.trim()) {
    const sourceText = input.sourceText.trim();
    return input.asrMode === "android_streaming" ||
      input.asrMode === "openai_realtime"
      ? repairVietnameseChildTranscript(sourceText)
      : sourceText;
  }

  if (input.audioFile) {
    const vietnameseText = (await transcribeAudio(input)).trim();

    if (!vietnameseText) {
      throw new AppError(
        "ASR_LOW_CONFIDENCE",
        "Không nghe thấy giọng nói. Hãy bật micro của máy ảo và nói lại.",
      );
    }

    assertVietnameseTranscript(vietnameseText);

    return repairVietnameseChildTranscript(vietnameseText);
  }

  await delay(320);

  return sampleVietnameseByContext[input.context][0];
}
