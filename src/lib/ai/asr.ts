import type { ConversationRequest } from "@/types/conversation";
import { AppError } from "@/lib/errors";
import { delay } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import { getOpenAIClient } from "./openai";
import { transcribeAudioToVietnamese } from "./cloudflareWorkersAi";
import { sampleVietnameseByContext } from "./prompts";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import { repairVietnameseChildTranscript } from "./transcriptRepair";
import { getVietnameseTranscriptQualityIssue } from "./transcriptQuality";

function assertVietnameseTranscript(text: string, segments: unknown[] = []) {
  const qualityIssue = getVietnameseTranscriptQualityIssue(text, segments);
  if (!containsUnexpectedEastAsianScript(text) && !qualityIssue) return;

  throw new AppError(
    "ASR_LOW_CONFIDENCE",
    "Nhận diện giọng nói chưa đủ chắc chắn. Vui lòng nói lại gần micro hơn.",
  );
}

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
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
  return {
    text: transcription.text.trim(),
    provider: "openai" as const,
    model,
  };
}

async function transcribeAudio(input: ConversationRequest) {
  const audioFile = input.audioFile!;
  const primaryProvider = getPrimaryAsrProvider();

  if (primaryProvider === "cloudflare") {
    const startedAt = performance.now();
    const cloudflareTranscription = (async () => {
      const result = await transcribeAudioToVietnamese(audioFile);
      assertVietnameseTranscript(result.vietnameseText, result.segments);
      return {
        text: result.vietnameseText,
        provider: "cloudflare" as const,
        model: result.model,
      };
    })();

    if (!process.env.OPENAI_API_KEY?.trim()) {
      const result = await cloudflareTranscription;
      logEvent("info", "asr_provider_latency", {
        requestId: input.requestId,
        provider: "cloudflare",
        model: result.model,
        latencyMs: Math.round(performance.now() - startedAt),
        fallbackUsed: false,
      });
      return result.text;
    }

    let fallbackPromise:
      | ReturnType<typeof transcribeWithOpenAI>
      | undefined;
    let fallbackReason = "slow_primary";
    const startFallback = () =>
      (fallbackPromise ??= transcribeWithOpenAI(audioFile));
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    const hedgeDelayMs = positiveInteger("ASR_HEDGE_DELAY_MS", 2_500);
    const delayedFallback = new Promise<
      Awaited<ReturnType<typeof transcribeWithOpenAI>>
    >((resolve, reject) => {
      hedgeTimer = setTimeout(() => {
        fallbackReason = "slow_primary";
        void startFallback().then(resolve, reject);
      }, hedgeDelayMs);
    });
    const primaryOrImmediateFallback = cloudflareTranscription.catch(
      (error) => {
        fallbackReason =
          error instanceof AppError && error.code === "ASR_LOW_CONFIDENCE"
            ? "low_confidence"
            : error instanceof Error
              ? error.name
              : "unknown_error";
        return startFallback();
      },
    );

    const result = await Promise.race([
      primaryOrImmediateFallback,
      delayedFallback,
    ]).finally(() => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
    });
    assertVietnameseTranscript(result.text);
    const fallbackUsed = result.provider === "openai";
    logEvent(fallbackUsed ? "warn" : "info", "asr_provider_latency", {
      requestId: input.requestId,
      provider: result.provider,
      model: result.model,
      latencyMs: Math.round(performance.now() - startedAt),
      fallbackUsed,
      fallbackReason: fallbackUsed ? fallbackReason : undefined,
      hedgeDelayMs,
    });
    return result.text;
  }

  const startedAt = performance.now();
  const result = await transcribeWithOpenAI(audioFile);
  assertVietnameseTranscript(result.text);
  logEvent("info", "asr_provider_latency", {
    requestId: input.requestId,
    provider: "openai",
    model: result.model,
    latencyMs: Math.round(performance.now() - startedAt),
    fallbackUsed: false,
  });
  return result.text;
}

export async function transcribeVietnamese(input: ConversationRequest) {
  if (input.sourceText?.trim()) {
    const sourceText = input.sourceText.trim();
    const confidence = input.benchmark?.asrConfidence;
    if (
      input.asrMode === "android_streaming" &&
      typeof confidence === "number" &&
      confidence >= 0 &&
      confidence < 0.2
    ) {
      throw new AppError(
        "ASR_LOW_CONFIDENCE",
        "Ứng dụng chưa nghe rõ câu nói. Vui lòng nói lại gần micro hơn.",
      );
    }
    assertVietnameseTranscript(sourceText);
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
