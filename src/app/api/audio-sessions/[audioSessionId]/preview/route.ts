import { transcribeVietnamese } from "@/lib/ai/asr";
import {
  beginBatchPrefetchOperation,
  reserveBatchPrefetchAttempt,
  saveBatchPrefetchCandidate,
} from "@/lib/ai/batchPrefetch";
import {
  generateEnglishSentence,
  resolveFastEnglishSentence,
} from "@/lib/ai/llm";
import { prepareEnglishAudio } from "@/lib/ai/tts";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";
import {
  type AudioAssemblySource,
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
  terminal?: boolean;
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
  let prefetchOperation:
    | ReturnType<typeof beginBatchPrefetchOperation>
    | undefined;

  try {
    authorizeAudioSessionRequest(request, audioSessionId);
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
    if (!reserveBatchPrefetchAttempt(audioSessionId, body.terminal === true)) {
      return withRequestId(
        Response.json({ eligible: false, reason: "prefetch_throttled" }),
        requestId,
      );
    }

    prefetchOperation = beginBatchPrefetchOperation(audioSessionId);

    let assemblySource: AudioAssemblySource | undefined;
    const audio = await finalizeAudioUploadSession(
      audioSessionId,
      "audio/wav",
      body.pcm16Wav,
      {
        allowTrailingChunks: true,
        onAssemblySource: (source) => {
          assemblySource = source;
        },
      },
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
    const translationStartedAt = performance.now();
    let translation = await resolveFastEnglishSentence(
      sourceText,
      body.context,
      body.childAge ?? 6,
      body.clientId?.trim() || undefined,
    );
    const speculativeAi = !translation;
    if (!translation) {
      // ASR has already produced a usable transcript while the child is still
      // speaking. Start the same controlled translation used by finalize now,
      // skipping the fast lookup we just completed.
      translation = await generateEnglishSentence(
        sourceText,
        body.context,
        body.childAge ?? 6,
        body.clientId?.trim() || undefined,
        requestId,
        true,
        true,
      );
    }
    const translationLatencyMs = Math.round(
      performance.now() - translationStartedAt,
    );
    const unsafeTranslation =
      translation.mode === "fallback" ||
      (!speculativeAi && !safeFastSources.has(translation.source));
    if (unsafeTranslation) {
      logEvent("info", "audio_session_prefetch_skipped", {
        requestId,
        audioSessionId,
        reason:
          translation.mode === "fallback"
            ? "speculative_translation_fallback"
            : "unsafe_text_source",
        textSource: translation.source,
        speculativeAi,
        asrLatencyMs,
        translationLatencyMs,
        assemblySource,
      });
      return withRequestId(
        Response.json({
          eligible: false,
          reason:
            translation.mode === "fallback"
              ? "speculative_translation_fallback"
              : "unsafe_text_source",
          asrLatencyMs,
          translationLatencyMs,
        }),
        requestId,
      );
    }

    // Return a cached URL or a signed streaming miss URL immediately. Safari
    // preloads this URL while recording is still active, so an uncached TTS
    // request runs speculatively instead of blocking this preview response.
    const audioResult = await prepareEnglishAudio(translation.englishText);
    if (
      audioResult.source !== "cache" &&
      audioResult.source !== "cloudflare_tts"
    ) {
      throw new AppError(
        "TTS_FAILED",
        "Batch prefetch chỉ chấp nhận Cloudflare TTS hoặc audio cache.",
        503,
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
      audioUrl: audioResult.audioUrl,
      audioSource: audioResult.source,
      snapshot: {
        ...body.pcm16Wav,
        chunkCount: body.pcm16Wav.chunkCount,
      } as Pcm16WavMetadata & { chunkCount: number },
      terminalSnapshot: body.terminal === true,
      previewLatencyMs,
      asrLatencyMs,
    });
    prefetchOperation.finish(candidate);
    logEvent("info", "audio_session_prefetch_ready", {
      requestId,
      audioSessionId,
      chunkCount: candidate.snapshot.chunkCount,
      terminalSnapshot: candidate.terminalSnapshot,
      stabilityCount: candidate.stabilityCount,
      textSource: candidate.translation.source,
      audioSource: candidate.audioSource,
      speculativeAi,
      assemblySource,
      asrLatencyMs,
      translationLatencyMs,
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
        snapshotChunkCount: candidate.snapshot.chunkCount,
        terminalSnapshot: candidate.terminalSnapshot,
        asrLatencyMs,
        translationLatencyMs,
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
  } finally {
    prefetchOperation?.finish(null);
  }
}
