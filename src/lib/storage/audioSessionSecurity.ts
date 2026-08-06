import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/appError";
import {
  getAudioUploadLimits,
  getAudioUploadSecurityConfig,
} from "@/lib/storage/config";

const scopedSessionPrefix = "audio_v2-";
const sha256Pattern = /^[a-f0-9]{64}$/;
const workerPipelineClockSkewSeconds = 30;

export type AudioSessionCreateConfig = {
  protocolVersion: 2;
  encoding: "pcm_s16le" | "encoded_audio";
  requestedSampleRate: number;
  channelCount: 1;
  bitsPerSample: 16;
  sourceChunkDurationMs: number;
  maxDurationMs: number;
};

export type AudioSessionTokenClaims = AudioSessionCreateConfig & {
  sessionId: string;
  expiresAt: number;
  maxChunkBytes: number;
  maxSessionBytes: number;
  maxChunks: number;
};

type RateLimitBucket = {
  startedAt: number;
  count: number;
};

type AudioUploadSecurityGlobal = typeof globalThis & {
  __aiSpeakingAudioUploadRateLimits?: Map<string, RateLimitBucket>;
};

const securityGlobal = globalThis as AudioUploadSecurityGlobal;

function parseInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new AppError(
      "BAD_REQUEST",
      "Cấu hình audio session không hợp lệ.",
      400,
    );
  }
  return Number(value);
}

export function parseAudioSessionCreateConfig(
  value: unknown,
): AudioSessionCreateConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (body.protocolVersion !== 2) {
    return null;
  }
  const audio =
    body.audio && typeof body.audio === "object"
      ? (body.audio as Record<string, unknown>)
      : {};
  const encoding = audio.encoding ?? "pcm_s16le";
  if (encoding !== "pcm_s16le" && encoding !== "encoded_audio") {
    throw new AppError(
      "BAD_REQUEST",
      "Định dạng audio session không được hỗ trợ.",
      400,
    );
  }
  const channelCount = parseInteger(audio.channelCount, 1, 1, 1);
  const bitsPerSample = parseInteger(audio.bitsPerSample, 16, 16, 16);
  return {
    protocolVersion: 2,
    encoding,
    requestedSampleRate: parseInteger(
      audio.requestedSampleRate,
      24_000,
      8_000,
      96_000,
    ),
    channelCount: channelCount as 1,
    bitsPerSample: bitsPerSample as 16,
    sourceChunkDurationMs: parseInteger(
      audio.sourceChunkDurationMs,
      200,
      50,
      2_000,
    ),
    maxDurationMs: parseInteger(audio.maxDurationMs, 12_000, 450, 60_000),
  };
}

function encodeBase64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function isScopedAudioSessionId(sessionId: string) {
  return sessionId.startsWith(scopedSessionPrefix);
}

export function issueAudioSessionToken(
  sessionId: string,
  config: AudioSessionCreateConfig,
) {
  const security = getAudioUploadSecurityConfig();
  if (!security.tokenSecret) {
    throw new AppError(
      "BAD_REQUEST",
      "Máy chủ chưa cấu hình scoped audio upload token.",
      503,
    );
  }
  const limits = getAudioUploadLimits();
  const claims: AudioSessionTokenClaims = {
    ...config,
    sessionId,
    expiresAt: Math.floor(Date.now() / 1000) + limits.sessionTtlSeconds,
    maxChunkBytes: limits.maxChunkBytes,
    maxSessionBytes: limits.maxSessionBytes,
    maxChunks: limits.maxChunks,
  };
  const payload = encodeBase64Url(JSON.stringify(claims));
  return {
    token: `${payload}.${signPayload(payload, security.tokenSecret)}`,
    claims,
  };
}

function unauthorized(message: string, status = 401): never {
  throw new AppError("AUDIO_SESSION_UNAUTHORIZED", message, status);
}

export function authorizeAudioSessionRequest(
  request: Request,
  sessionId: string,
): AudioSessionTokenClaims | null {
  if (!isScopedAudioSessionId(sessionId)) {
    return null;
  }
  const secret = getAudioUploadSecurityConfig().tokenSecret;
  if (!secret) {
    unauthorized("Máy chủ không thể xác thực audio session.", 503);
  }
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const [payload = "", suppliedSignature = "", extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) {
    unauthorized("Audio session thiếu upload token hợp lệ.");
  }
  const expectedSignature = signPayload(payload, secret);
  const expectedBytes = Buffer.from(expectedSignature);
  const suppliedBytes = Buffer.from(suppliedSignature);
  if (
    expectedBytes.byteLength !== suppliedBytes.byteLength ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    unauthorized("Audio session có upload token không hợp lệ.");
  }

  let claims: AudioSessionTokenClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as AudioSessionTokenClaims;
  } catch {
    unauthorized("Audio session có upload token không hợp lệ.");
  }
  if (claims.sessionId !== sessionId || claims.protocolVersion !== 2) {
    unauthorized("Upload token không thuộc audio session này.", 403);
  }
  if (
    !Number.isFinite(claims.expiresAt) ||
    claims.expiresAt <= Date.now() / 1000
  ) {
    throw new AppError(
      "AUDIO_SESSION_EXPIRED",
      "Audio session đã hết hạn. Vui lòng ghi âm lại.",
      410,
    );
  }
  return claims;
}

/**
 * Proves that a speculative transcript came from the Worker, not from a Web
 * client that merely holds the scoped upload token. Both services already own
 * AUDIO_UPLOAD_TOKEN_SECRET; the browser never receives this HMAC key.
 */
export function authorizeWorkerAudioSessionPipeline(
  request: Request,
  input: {
    audioSessionId: string;
    snapshotChunkCount: number;
    sourceText: string;
  },
) {
  const secret = getAudioUploadSecurityConfig().tokenSecret;
  if (!secret) {
    unauthorized("Máy chủ không thể xác thực Worker pipeline.", 503);
  }
  const rawTimestamp =
    request.headers.get("x-worker-pipeline-timestamp")?.trim() ?? "";
  const timestamp = Number(rawTimestamp);
  if (
    !/^\d+$/.test(rawTimestamp) ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestamp) >
      workerPipelineClockSkewSeconds
  ) {
    unauthorized("Worker pipeline có timestamp không hợp lệ.", 403);
  }
  const suppliedSignature =
    request.headers.get("x-worker-pipeline-signature")?.trim() ?? "";
  const payload = JSON.stringify([
    input.audioSessionId,
    input.snapshotChunkCount,
    timestamp,
    input.sourceText,
  ]);
  const expectedSignature = signPayload(payload, secret);
  const expectedBytes = Buffer.from(expectedSignature);
  const suppliedBytes = Buffer.from(suppliedSignature);
  if (
    !suppliedSignature ||
    expectedBytes.byteLength !== suppliedBytes.byteLength ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    unauthorized("Worker pipeline có chữ ký không hợp lệ.", 403);
  }
}

export function validateScopedChunkHeaders(
  request: Request,
  sessionId: string,
  sequence: number,
  scoped: boolean,
) {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  const checksum =
    request.headers.get("x-chunk-sha256")?.trim().toLowerCase() ?? "";
  if (scoped && idempotencyKey !== `chunk:${sessionId}:${sequence}`) {
    throw new AppError(
      "AUDIO_CHUNK_IDEMPOTENCY_INVALID",
      "Khóa idempotency của audio chunk không hợp lệ.",
      400,
    );
  }
  if (scoped && !sha256Pattern.test(checksum)) {
    throw new AppError(
      "AUDIO_CHUNK_CHECKSUM_INVALID",
      "Audio chunk thiếu checksum SHA-256 hợp lệ.",
      400,
    );
  }
  return sha256Pattern.test(checksum) ? checksum : undefined;
}

function requestClientKey(request: Request) {
  return (
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export function consumeAudioUploadRateLimit(
  request: Request,
  scope: "create" | "session",
  sessionId?: string,
) {
  const security = getAudioUploadSecurityConfig();
  const limit =
    scope === "create"
      ? security.createRequestsPerMinute
      : security.sessionRequestsPerMinute;
  const key =
    scope === "create"
      ? `create:${requestClientKey(request)}`
      : `session:${sessionId ?? "unknown"}`;
  const now = Date.now();
  const windowMs = 60_000;
  const buckets =
    securityGlobal.__aiSpeakingAudioUploadRateLimits ??= new Map();
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    buckets.set(key, { startedAt: now, count: 1 });
    return null;
  }
  current.count += 1;
  if (current.count <= limit) {
    return null;
  }
  if (buckets.size > 5_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) {
        buckets.delete(bucketKey);
      }
    }
  }
  return Math.max(
    1,
    Math.ceil((windowMs - (now - current.startedAt)) / 1000),
  );
}
