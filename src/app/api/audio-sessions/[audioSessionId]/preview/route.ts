import { after } from "next/server";
import { transcribeVietnamese } from "@/lib/ai/asr";
import {
  reserveBatchPrefetchAttempt,
  saveBatchPrefetchCandidate,
} from "@/lib/ai/batchPrefetch";
import { resolveFastEnglishSentence } from "@/lib/ai/llm";
import { synthesizeEnglishAudio } from "@/lib/ai/tts";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";
import {
  AudioUploadError,
  finalizeAudioUploadSession,
  type Pcm16WavMetadata,
} from "@/lib/storage/audioSessions";
import { authorizeAudioSessionRequest } from "@/lib/storage/audioSessionSecurity";
import type { PracticeContext, TextSource } from "@/types/conversation";

export const runtime = "nodejs";
export const maxDuration = 35;

type RouteContext = {
  params: Promise<{ audioSessionId: string }>;
};

type PreviewRequest = {
  clientId?: string;
  context?: PracticeContext;
  childAge?: number;
  previousPrefetchId?: string;
  pcm16Wav?: Pcm16WavMetadata;
};

const contexts = new Set<PracticeContext>(["home", "school", "outside"]);
const safeFastSources = new Set<TextSource>([
  "phrase_rule",
  "promoted_rule",
  "text_cache",
]);

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const { audioSessionId } = await context.params;

  try {
    authorizeAudioSessionRequest(request, audioSessionId);
    if (!reserveBatchPrefetchAttempt(audioSessionId)) {
      return withRequestId(
        Response.json({ eligible: false, reason: "prefetch_throttled" }),
        requestId,
      );
    }
    const body = (await request.json().catch(() => null)) as PreviewRequest | null;
    if (!body?.context || !contexts.has(body.context) || !body.pcm16Wav) {
      throw new AppError(
        "BAD_REQUEST",
        "Dữ liệu Batch prefetch không hợp lệ.",
      );
    }
    if (
      body.pcm16Wav.chunkCount === undefined ||
      body.pcm16Wav.chunkCount < 2 ||
      body.pcm16Wav.pcmByteLength < body.pcm16Wav.sampleRate
    ) {
      return withRequestId(
        Response.json({ eligible: false, reason: "audio_too_short" }),
        requestId,
      );
    }

    const audio = await finalizeAudioUploadSession(
      audioSessionId,
      "audio/wav",
      body.pcm16Wav,
      { allowTrailingChunks: true },
    );
    const asrStartedAt = performance.now();
    const sourceText = await transcribeVietnamese({
      requestId,
      clientId: body.clientId?.trim() || undefined,
      context: body.context,
      childAge: body.childAge ?? 6,
      targetLanguage: "en",
      audioFile: audio,
      asrMode: "batch_chunks",
      benchmark: {
        utteranceDurationMs: Math.round(
          (body.pcm16Wav.pcmByteLength /
            (body.pcm16Wav.sampleRate *
              body.pcm16Wav.channelCount *
              (body.pcm16Wav.bitsPerSample / 8))) *
            1_000,
        ),
        clientVadApplied: false,
      },
    });
    const asrLatencyMs = Math.round(performance.now() - asrStartedAt);
    const translation = await resolveFastEnglishSentence(
      sourceText,
      body.context,
      body.childAge ?? 6,
      body.clientId?.trim() || undefined,
    );
    if (!translation || !safeFastSources.has(translation.source)) {
      logEvent("info", "audio_session_prefetch_skipped", {
        requestId,
        audioSessionId,
        reason: translation ? "unsafe_text_source" : "no_fast_match",
        textSource: translation?.source,
        asrLatencyMs,
      });
      return withRequestId(
        Response.json({
          eligible: false,
          reason: translation ? "unsafe_text_source" : "no_fast_match",
          asrLatencyMs,
        }),
        requestId,
      );
    }

    const previewLatencyMs = Math.round(performance.now() - startedAt);
    const candidate = saveBatchPrefetchCandidate({
      previousPrefetchId: body.previousPrefetchId,
      audioSessionId,
      context: body.context,
      childAge: body.childAge ?? 6,
      sourceText,
      translation,
      // The platform voice can speak this safe, stable translation
      // immediately. Keep TTS and remote-cache latency off the preview path.
      audioUrl: null,
      audioSource: null,
      snapshot: {
        ...body.pcm16Wav,
        chunkCount: body.pcm16Wav.chunkCount,
      } as Pcm16WavMetadata & { chunkCount: number },
      previewLatencyMs,
      asrLatencyMs,
    });
    if (candidate.stabilityCount >= 2) {
      after(async () => {
        const warmStartedAt = performance.now();
        try {
          const audioResult = await synthesizeEnglishAudio(
            translation.englishText,
          );
          logEvent("info", "audio_session_prefetch_audio_warmed", {
            requestId,
            audioSessionId,
            prefetchId: candidate.id,
            audioSource: audioResult.source,
            latencyMs: Math.round(performance.now() - warmStartedAt),
          });
        } catch (error) {
          // This is only a warm-up. Finalization can still return the normal
          // streaming TTS URL when the background fill fails.
          logEvent("warn", "audio_session_prefetch_audio_warm_failed", {
            requestId,
            audioSessionId,
            prefetchId: candidate.id,
            error,
          });
        }
      });
    }
    logEvent("info", "audio_session_prefetch_ready", {
      requestId,
      audioSessionId,
      chunkCount: candidate.snapshot.chunkCount,
      stabilityCount: candidate.stabilityCount,
      textSource: candidate.translation.source,
      audioSource: candidate.audioSource,
      audioDeferred: true,
      asrLatencyMs,
      previewLatencyMs,
    });
    return withRequestId(
      Response.json({
        eligible: true,
        prefetchId: candidate.id,
        stabilityCount: candidate.stabilityCount,
        sourceText: candidate.sourceText,
        englishText: candidate.translation.englishText,
        textSource: candidate.translation.source,
        audioUrl: candidate.audioUrl,
        audioSource: candidate.audioSource,
        audioDeferred: true,
        snapshotChunkCount: candidate.snapshot.chunkCount,
        asrLatencyMs,
        previewLatencyMs,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "audio_session_prefetch_failed", {
      requestId,
      audioSessionId,
      error,
    });
    const responseError =
      error instanceof AudioUploadError
        ? new AppError(
            "AUDIO_SESSION_INVALID",
            error.message,
            error.status,
            error.details,
          )
        : error;
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}
