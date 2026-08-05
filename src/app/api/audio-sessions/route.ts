import { AppError, toErrorResponse } from "@/lib/errors";
import { getRequestId, logEvent, withRequestId } from "@/lib/observability";
import {
  consumeAudioUploadRateLimit,
  issueAudioSessionToken,
  parseAudioSessionCreateConfig,
} from "@/lib/storage/audioSessionSecurity";
import { createAudioUploadSession } from "@/lib/storage/audioSessions";
import {
  getAudioSessionChunkStorageBackend,
  getAudioUploadLimits,
  getAudioUploadSecurityConfig,
} from "@/lib/storage/config";

export const runtime = "nodejs";

async function readOptionalJson(request: Request) {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return null;
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new AppError("BAD_REQUEST", "Yêu cầu tạo audio session không hợp lệ.");
  }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const retryAfter = consumeAudioUploadRateLimit(request, "create");
  if (retryAfter !== null) {
    return withRequestId(
      Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Đã tạo quá nhiều audio session. Vui lòng thử lại sau.",
            requestId,
          },
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      ),
      requestId,
    );
  }

  try {
    const requestedConfig = parseAudioSessionCreateConfig(
      await readOptionalJson(request),
    );
    const security = getAudioUploadSecurityConfig();
    if (security.invalidTokenSecret) {
      throw new AppError(
        "AUDIO_SESSION_INVALID",
        "AUDIO_UPLOAD_TOKEN_SECRET phải có tối thiểu 32 ký tự.",
        503,
      );
    }
    if (security.requireScopedToken && !security.scopedTokensEnabled) {
      throw new AppError(
        "AUDIO_SESSION_INVALID",
        "Máy chủ yêu cầu scoped upload token nhưng chưa cấu hình secret.",
        503,
      );
    }
    if (security.requireScopedToken && !requestedConfig) {
      throw new AppError(
        "AUDIO_SESSION_UNAUTHORIZED",
        "Phiên bản ứng dụng này cần được cập nhật để upload audio an toàn.",
        426,
      );
    }

    const scoped = Boolean(requestedConfig && security.scopedTokensEnabled);
    const chunkStorageBackend = getAudioSessionChunkStorageBackend();
    const audioSessionId = await createAudioUploadSession({ scoped });
    const issued =
      scoped && requestedConfig
        ? issueAudioSessionToken(audioSessionId, requestedConfig)
        : null;
    const limits = getAudioUploadLimits();
    logEvent("info", "audio_session_created", {
      requestId,
      audioSessionId,
      protocolVersion: scoped ? 2 : 1,
      scopedUploadToken: scoped,
      chunkStorageBackend,
    });
    return withRequestId(
      Response.json({
        audioSessionId,
        ...(issued
          ? {
              uploadToken: issued.token,
              expiresAt: new Date(issued.claims.expiresAt * 1000).toISOString(),
            }
          : {}),
        capabilities: {
          pcm16WavFinalize: true,
          chunkChecksumSha256: true,
          missingChunkRecovery: true,
          scopedUploadToken: scoped,
          uploadProtocolVersion: scoped ? 2 : 1,
          chunkStorageBackend,
          sessionTtlSeconds: limits.sessionTtlSeconds,
        },
      }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "audio_session_create_failed", { requestId, error });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
