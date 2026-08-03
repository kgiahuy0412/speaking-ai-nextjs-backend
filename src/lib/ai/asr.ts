import type { ConversationRequest } from "@/types/conversation";
import { AppError } from "@/lib/errors";
import { delay } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import { getOpenAIClient } from "./openai";
import { transcribeAudioToVietnamese } from "./cloudflareWorkersAi";
import { resolveCloudflareAsrVadPolicy } from "./cloudflareWorkersAiRequest";
import { sampleVietnameseByContext } from "./prompts";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import { repairVietnameseChildTranscript } from "./transcriptRepair";
import { getVietnameseTranscriptQualityIssue } from "./transcriptQuality";

function assertVietnameseTranscript(
  text: string,
  segments: unknown[] = [],
  options: {
    requestId?: string;
    provider?: "cloudflare" | "openai" | "device";
    utteranceDurationMs?: number;
  } = {},
) {
  const unexpectedScript = containsUnexpectedEastAsianScript(text);
  const qualityIssue = getVietnameseTranscriptQualityIssue(text, segments, {
    utteranceDurationMs: options.utteranceDurationMs,
  });
  if (!unexpectedScript && !qualityIssue) return;

  logEvent("warn", "asr_transcript_rejected", {
    requestId: options.requestId,
    provider: options.provider,
    reason: unexpectedScript ? "unexpected_script" : qualityIssue,
    utteranceDurationMs: options.utteranceDurationMs,
    transcriptLength: text.trim().length,
  });

  throw new AppError(
    "ASR_LOW_CONFIDENCE",
    "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.",
    422,
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
    const vadPolicy = resolveCloudflareAsrVadPolicy({
      clientVadApplied: input.benchmark?.clientVadApplied,
      configuredMode: process.env.CLOUDFLARE_ASR_VAD_MODE,
    });
    input.benchmark = {
      ...input.benchmark,
      cloudflareVadFilter: vadPolicy.vadFilter,
      cloudflareVadMode: vadPolicy.mode,
      cloudflareVadReason: vadPolicy.reason,
    };
    logEvent("info", "cloudflare_asr_vad_policy", {
      requestId: input.requestId,
      clientVadApplied: input.benchmark.clientVadApplied === true,
      vadFilter: vadPolicy.vadFilter,
      mode: vadPolicy.mode,
      reason: vadPolicy.reason,
      audioInputLabel: input.benchmark.audioInputLabel,
      bluetoothAudioInput: input.benchmark.bluetoothAudioInput,
    });
    const cloudflareTranscription = (async () => {
      const result = await transcribeAudioToVietnamese(audioFile, {
        vadFilter: vadPolicy.vadFilter,
      });
      assertVietnameseTranscript(result.vietnameseText, result.segments, {
        requestId: input.requestId,
        provider: "cloudflare",
        utteranceDurationMs: input.benchmark?.utteranceDurationMs,
      });
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

    let fallbackReason = "cloudflare_failed";
    const result = await cloudflareTranscription.catch(async (error) => {
      // Low-confidence audio is a user-actionable result, not a provider
      // outage. Falling back here made a second ASR guess from the same poor
      // audio and could create an unrelated sentence.
      if (error instanceof AppError && error.code === "ASR_LOW_CONFIDENCE") {
        throw error;
      }
      fallbackReason = error instanceof Error ? error.name : "unknown_error";
      return transcribeWithOpenAI(audioFile);
    });
    assertVietnameseTranscript(result.text, [], {
      requestId: input.requestId,
      provider: result.provider,
      utteranceDurationMs: input.benchmark?.utteranceDurationMs,
    });
    const fallbackUsed = result.provider === "openai";
    logEvent(fallbackUsed ? "warn" : "info", "asr_provider_latency", {
      requestId: input.requestId,
      provider: result.provider,
      model: result.model,
      latencyMs: Math.round(performance.now() - startedAt),
      fallbackUsed,
      fallbackReason: fallbackUsed ? fallbackReason : undefined,
    });
    return result.text;
  }

  const startedAt = performance.now();
  const result = await transcribeWithOpenAI(audioFile);
  assertVietnameseTranscript(result.text, [], {
    requestId: input.requestId,
    provider: "openai",
    utteranceDurationMs: input.benchmark?.utteranceDurationMs,
  });
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
        "Mình chưa nghe rõ. Con đưa micro lại gần và nói rõ hơn nhé.",
        422,
      );
    }
    assertVietnameseTranscript(sourceText, [], {
      requestId: input.requestId,
      provider: "device",
      utteranceDurationMs: input.benchmark?.utteranceDurationMs,
    });
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
        "Mình chưa nghe thấy giọng nói. Con đưa micro lại gần và nói rõ hơn nhé.",
        422,
      );
    }

    assertVietnameseTranscript(vietnameseText, [], {
      requestId: input.requestId,
      utteranceDurationMs: input.benchmark?.utteranceDurationMs,
    });

    return repairVietnameseChildTranscript(vietnameseText);
  }

  await delay(320);

  return sampleVietnameseByContext[input.context][0];
}
