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
  prepareEnglishAudio,
  synthesizeEnglishAudio,
  type AudioSynthesisResult,
} from "./tts";

export type ConversationPipelineOptions = {
  deferTextCacheWrite?: boolean;
  prefetchedTranscript?: {
    sourceText: string;
    latencyMs: number;
  };
  prefetchedTranslation?: EnglishGenerationResult;
  prefetchedAudio?: AudioSynthesisResult;
  /**
   * Return a signed streaming URL on every cache miss. Terminal Web previews
   * use this so Safari can start the provider stream while finalize reuses the
   * exact prepared pipeline instead of waiting for durable cache storage.
   */
  streamAudioOnCacheMiss?: boolean;
};

export type PreparedConversationPipeline = {
  asr: {
    value: string;
    latencyMs: number;
  };
  llm: {
    value: EnglishGenerationResult;
    latencyMs: number;
  };
  tts: {
    value: AudioSynthesisResult;
    latencyMs: number;
  };
  preparationMs: number;
};

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export async function prepareConversationPipeline(
  input: ConversationRequest,
  options: ConversationPipelineOptions = {},
): Promise<PreparedConversationPipeline> {
  const startedAt = nowMs();
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
  // A brand-new AI sentence cannot be a cache hit. Return its streaming URL
  // immediately; /api/audio/stream clones the provider response and persists
  // it in `after()` independently from Safari playback. Reviewed rules and
  // known text-cache entries still resolve to durable audio before returning.
  const usesFastStreamingTts =
    !options.prefetchedAudio &&
    (options.streamAudioOnCacheMiss || llm.value.source === "cloudflare");
  const tts = options.prefetchedAudio
    ? { value: options.prefetchedAudio, latencyMs: 0 }
    : await measureStep<AudioSynthesisResult>(() =>
        usesFastStreamingTts
          ? prepareEnglishAudio(llm.value.englishText)
          : synthesizeEnglishAudio(llm.value.englishText),
      );

  return {
    asr,
    llm,
    tts,
    preparationMs: Math.round(nowMs() - startedAt),
  };
}

export function completePreparedConversationPipeline(
  input: ConversationRequest,
  prepared: PreparedConversationPipeline,
): ConversationResponse {
  const conversationId = createId("conv");
  const { asr, llm, tts } = prepared;

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
      timeToFirstAudioMs: prepared.preparationMs,
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
    audioDeliveryMode: tts.value.cacheReady ? "cache" : "stream_and_cache",
    audioCacheHitTarget: 0.85,
    latency: result.latency,
  });

  return result;
}

export async function runConversationPipeline(
  input: ConversationRequest,
  options: ConversationPipelineOptions = {},
): Promise<ConversationResponse> {
  const prepared = await prepareConversationPipeline(input, options);
  return completePreparedConversationPipeline(input, prepared);
}
