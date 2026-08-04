import { createHash } from "node:crypto";
import { runConversationPipeline } from "@/lib/ai/pipeline";
import { scheduleConversationPostResponseTasks } from "@/lib/ai/postResponseTasks";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  AudioUploadError,
  claimAudioSessionFinalize,
  completeAudioSessionFinalize,
  finalizeAudioUploadSession,
  releaseAudioSessionFinalize,
  type Pcm16WavMetadata,
} from "@/lib/storage/audioSessions";
import {
  authorizeAudioSessionRequest,
  consumeAudioUploadRateLimit,
} from "@/lib/storage/audioSessionSecurity";
import type {
  ApiErrorCode,
  AsrMode,
  BenchmarkMetadata,
  PracticeContext,
} from "@/types/conversation";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ audioSessionId: string }>;
};

type FinalizeRequest = {
  clientId?: string;
  context?: PracticeContext;
  childAge?: number;
  sessionId?: string;
  sourceText?: string;
  asrMode?: AsrMode;
  mimeType?: string;
  pcm16Wav?: Pcm16WavMetadata;
  benchmark?: BenchmarkMetadata;
};

const validContexts = new Set<PracticeContext>([
  "home",
  "school",
  "outside",
]);

function publicAudioUploadError(error: AudioUploadError) {
  const code: ApiErrorCode =
    error.code === "MISSING_CHUNKS"
      ? "AUDIO_CHUNKS_MISSING"
      : error.code === "CHUNK_CONFLICT"
        ? "AUDIO_CHUNK_CONFLICT"
        : error.code === "CHUNK_CHECKSUM_MISMATCH"
          ? "AUDIO_CHUNK_CHECKSUM_MISMATCH"
          : error.code === "SESSION_EXPIRED"
            ? "AUDIO_SESSION_EXPIRED"
            : error.code === "CHUNK_TOO_LARGE" ||
                error.code === "SESSION_TOO_LARGE" ||
                error.code === "TOO_MANY_CHUNKS"
              ? "AUDIO_UPLOAD_LIMIT"
              : "AUDIO_SESSION_INVALID";
  return new AppError(code, error.message, error.status, error.details);
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const { audioSessionId } = await context.params;
  let requestHash = "";
  let finalizeClaimed = false;
  let claimMs = 0;
  let assembleMs = 0;
  let pipelineMs = 0;
  let completeMs = 0;

  try {
    const uploadClaims = authorizeAudioSessionRequest(request, audioSessionId);
    const retryAfter = consumeAudioUploadRateLimit(
      request,
      "session",
      audioSessionId,
    );
    if (retryAfter !== null) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "RATE_LIMITED",
              message:
                "Audio session gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
              requestId,
            },
          },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        ),
        requestId,
      );
    }
    const rawBody = await request.text();
    requestHash = createHash("sha256").update(rawBody).digest("hex");
    const body = JSON.parse(rawBody) as FinalizeRequest;
    if (
      uploadClaims &&
      ((uploadClaims.encoding === "pcm_s16le" && !body.pcm16Wav) ||
        (uploadClaims.encoding === "encoded_audio" && body.pcm16Wav))
    ) {
      throw new AppError(
        "AUDIO_SESSION_INVALID",
        "Kiểu finalize không khớp cấu hình audio session.",
        400,
      );
    }
    if (uploadClaims && body.pcm16Wav) {
      const pcm = body.pcm16Wav;
      const durationMs =
        (pcm.pcmByteLength /
          (pcm.sampleRate * pcm.channelCount * (pcm.bitsPerSample / 8))) *
        1_000;
      if (
        pcm.channelCount !== uploadClaims.channelCount ||
        pcm.bitsPerSample !== uploadClaims.bitsPerSample ||
        !Number.isFinite(durationMs) ||
        durationMs >
          uploadClaims.maxDurationMs + uploadClaims.sourceChunkDurationMs ||
        (pcm.chunkCount !== undefined &&
          (!Number.isInteger(pcm.chunkCount) ||
            pcm.chunkCount <= 0 ||
            pcm.chunkCount > uploadClaims.maxChunks))
      ) {
        throw new AppError(
          "AUDIO_SESSION_INVALID",
          "Metadata PCM không khớp upload token của audio session.",
          400,
        );
      }
    }

    const claimStartedAt = performance.now();
    const claim = await claimAudioSessionFinalize(audioSessionId, requestHash);
    claimMs = Math.round(performance.now() - claimStartedAt);

    if (claim.state === "completed") {
      logEvent("info", "audio_session_finalize_replayed", {
        requestId,
        audioSessionId,
      });
      return withRequestId(Response.json(claim.result), requestId);
    }

    if (claim.state === "in_progress") {
      throw new AppError(
        "RATE_LIMITED",
        "Audio session đang được xử lý. Vui lòng thử lại sau.",
        409,
      );
    }

    finalizeClaimed = true;

    if (!body.context || !validContexts.has(body.context)) {
      throw new AppError("BAD_REQUEST", "Vui lòng chọn ngữ cảnh hợp lệ.");
    }

    const requestedAsrMode =
      body.asrMode === "browser_streaming"
        ? "browser_streaming"
        : "batch_chunks";
    const asrMode =
      requestedAsrMode === "browser_streaming" && body.sourceText?.trim()
        ? "browser_streaming"
        : "batch_chunks";
    let audioFile: File | undefined;

    if (!(asrMode === "browser_streaming" && body.sourceText?.trim())) {
      const assembleStartedAt = performance.now();
      audioFile = await finalizeAudioUploadSession(
        audioSessionId,
        body.mimeType,
        body.pcm16Wav,
      );
      assembleMs = Math.round(performance.now() - assembleStartedAt);
    }

    const pipelineStartedAt = performance.now();
    const result = await runConversationPipeline(
      {
        requestId,
        clientId: body.clientId?.trim() || undefined,
        context: body.context,
        childAge: body.childAge ?? 6,
        targetLanguage: "en",
        sessionId: body.sessionId,
        sourceText: body.sourceText?.trim(),
        audioFile,
        asrMode,
        benchmark: body.benchmark,
      },
      { deferTextCacheWrite: true },
    );
    pipelineMs = Math.round(performance.now() - pipelineStartedAt);

    const responsePayload = { ...result, learning: null };
    const completeStartedAt = performance.now();
    await completeAudioSessionFinalize(
      audioSessionId,
      requestHash,
      responsePayload,
    );
    completeMs = Math.round(performance.now() - completeStartedAt);
    logEvent("info", "audio_session_finalize_completed", {
      requestId,
      audioSessionId,
      timing: {
        claimMs,
        assembleMs,
        pipelineMs,
        completeMs,
        totalMs: Math.round(performance.now() - startedAt),
      },
    });
    scheduleConversationPostResponseTasks(result, "audio");
    return withRequestId(Response.json(responsePayload), requestId);
  } catch (error) {
    if (finalizeClaimed && requestHash) {
      await releaseAudioSessionFinalize(audioSessionId, requestHash).catch(
        (releaseError) => {
          logEvent("error", "audio_session_finalize_release_failed", {
            requestId,
            audioSessionId,
            releaseError,
          });
        },
      );
    }

    logEvent("warn", "audio_session_finalize_failed", {
      requestId,
      audioSessionId,
      error,
    });
    const responseError =
      error instanceof AudioUploadError
        ? publicAudioUploadError(error)
        : error;
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}
