import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import {
  authorizeAudioSessionRequest,
  consumeAudioUploadRateLimit,
  validateScopedChunkHeaders,
} from "@/lib/storage/audioSessionSecurity";
import {
  AudioUploadError,
  discardAudioUploadSession,
  saveAudioSessionChunk,
} from "@/lib/storage/audioSessions";
import { getAudioUploadLimits } from "@/lib/storage/config";
import type { ApiErrorCode } from "@/types/conversation";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ audioSessionId: string }>;
};

function publicAudioUploadError(error: AudioUploadError) {
  const code: ApiErrorCode =
    error.code === "CHUNK_CONFLICT"
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

function rateLimitedResponse(requestId: string, retryAfter: number) {
  return withRequestId(
    Response.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Audio session gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
          requestId,
        },
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    ),
    requestId,
  );
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const { audioSessionId } = await context.params;

  try {
    const claims = authorizeAudioSessionRequest(request, audioSessionId);
    const retryAfter = consumeAudioUploadRateLimit(
      request,
      "session",
      audioSessionId,
    );
    if (retryAfter !== null) {
      return rateLimitedResponse(requestId, retryAfter);
    }
    const contentLength = Number(request.headers.get("content-length"));
    const maxRequestBytes = getAudioUploadLimits().maxChunkBytes + 256 * 1024;

    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      throw new AudioUploadError(
        "CHUNK_TOO_LARGE",
        "Audio chunk vượt quá dung lượng cho phép.",
        413,
      );
    }

    const formData = await request.formData();
    const chunk = formData.get("audio");
    const sequence = Number(formData.get("sequence"));

    if (!(chunk instanceof File)) {
      throw new AudioUploadError(
        "EMPTY_CHUNK",
        "Audio chunk không hợp lệ.",
        400,
      );
    }
    if (
      claims &&
      (chunk.size > claims.maxChunkBytes ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence >= claims.maxChunks)
    ) {
      throw new AppError(
        "AUDIO_UPLOAD_LIMIT",
        "Audio chunk vượt quá giới hạn của upload token.",
        413,
      );
    }
    const expectedSha256 = validateScopedChunkHeaders(
      request,
      audioSessionId,
      sequence,
      claims !== null,
    );
    const result = await saveAudioSessionChunk(
      audioSessionId,
      sequence,
      chunk,
      expectedSha256,
    );
    return withRequestId(
      Response.json({ uploaded: true, sequence, ...result }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "audio_chunk_upload_failed", {
      requestId,
      audioSessionId,
      error,
    });
    const responseError =
      error instanceof AudioUploadError ? publicAudioUploadError(error) : error;
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const { audioSessionId } = await context.params;

  try {
    authorizeAudioSessionRequest(request, audioSessionId);
    const retryAfter = consumeAudioUploadRateLimit(
      request,
      "session",
      audioSessionId,
    );
    if (retryAfter !== null) {
      return rateLimitedResponse(requestId, retryAfter);
    }
    const rawDiscardReason =
      request.headers.get("x-discard-reason")?.trim().toLowerCase() ?? "";
    const discardReason = /^[a-z0-9_]{1,40}$/.test(rawDiscardReason)
      ? rawDiscardReason
      : "unspecified";
    await discardAudioUploadSession(audioSessionId);
    logEvent("info", "audio_session_discarded", {
      requestId,
      audioSessionId,
      discardReason,
    });
    return withRequestId(Response.json({ discarded: true }), requestId);
  } catch (error) {
    const responseError =
      error instanceof AudioUploadError ? publicAudioUploadError(error) : error;
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}
