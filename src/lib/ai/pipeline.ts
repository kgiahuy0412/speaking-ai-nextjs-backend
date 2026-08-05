import type {
  ConversationRequest,
  ConversationResponse,
} from "@/types/conversation";
import { measureStep, nowMs } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import { transcribeVietnamese } from "./asr";
import {
  generateEnglishSentence,
  type EnglishGenerationResult,
} from "./llm";
import { PROMPT_VERSION } from "./prompts";
import {
  synthesizeEnglishAudio,
  type AudioSynthesisResult,
} from "./tts";

type ConversationPipelineOptions = {
  deferTextCacheWrite?: boolean;
  prefetchedTranscript?: {
    sourceText: string;
    latencyMs: number;
  };
  prefetchedTranslation?: EnglishGenerationResult;
  prefetchedAudio?: AudioSynthesisResult;
};

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export async function runConversationPipeline(
  input: ConversationRequest,
  options: ConversationPipelineOptions = {},
): Promise<ConversationResponse> {
  const startedAt = nowMs();
  const conversationId = createId("conv");

  const asr = options.prefetchedTranscript
    ? {
        value: options.prefetchedTranscript.sourceText,
        latencyMs: options.prefetchedTranscript.latencyMs,
      }
    : await measureStep(() => transcribeVietnamese(input));
  const llm = options.prefetchedTranslation
    ? { value: options.prefetchedTranslation, latencyMs: 0 }
    : await measureStep(() =>
        generateEnglishSentence(
          asr.value,
          input.context,
          input.childAge,
          input.clientId,
          input.requestId,
          options.deferTextCacheWrite,
        ),
      );
  const tts = options.prefetchedAudio
    ? { value: options.prefetchedAudio, latencyMs: 0 }
    : await measureStep(() => synthesizeEnglishAudio(llm.value.englishText));

  const result = {
    requestId: input.requestId,
    clientId: input.clientId,
    conversationId,
    sessionId: input.sessionId ?? createId("sess"),
    context: input.context,
    vietnameseText: asr.value,
    englishText: llm.value.englishText,
    audioUrl: tts.value.audioUrl,
    promptVersion: PROMPT_VERSION,
    processingMode: llm.value.mode,
    matchedRule: llm.value.matchedRule,
    textSource: llm.value.source,
    textProvider: llm.value.textProvider,
    textModel: llm.value.textModel,
    textFallbackUsed: llm.value.textFallbackUsed,
    textFallbackReason: llm.value.textFallbackReason,
    audioSource: tts.value.source,
    asrMode: input.asrMode ?? (input.audioFile ? "batch_chunks" : "text"),
    benchmark: input.benchmark,
    latency: {
      asrMs: asr.latencyMs,
      llmMs: llm.latencyMs,
      ttsMs: tts.latencyMs,
      timeToFirstAudioMs: Math.round(nowMs() - startedAt),
    },
  } satisfies ConversationResponse;

  logEvent("info", "conversation_pipeline_completed", {
    requestId: input.requestId,
    conversationId,
    context: input.context,
    asrMode: result.asrMode,
    processingMode: result.processingMode,
    textSource: result.textSource,
    textProvider: result.textProvider,
    textModel: result.textModel,
    textFallbackUsed: result.textFallbackUsed,
    textFallbackReason: result.textFallbackReason,
    matchedRule: result.matchedRule,
    audioSource: result.audioSource,
    audioCacheHit: result.audioSource === "cache",
    audioCacheReady: tts.value.cacheReady,
    audioCacheHitTarget: 0.85,
    latency: result.latency,
  });

  return result;
}
