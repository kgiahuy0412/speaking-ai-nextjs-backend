import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isPostgresStorageEnabled, queryDatabase } from "@/lib/db";
import { getAudioUploadLimits } from "@/lib/storage/config";

const sessionIdPattern = /^audio_[a-z0-9-]+$/;
const metadataFileName = "session.json";
export const postgresAudioChunkUpsertQuery = `WITH target AS (
         SELECT session_id, status, expires_at, total_bytes, chunk_count
           FROM audio_upload_sessions
          WHERE session_id = $1
          FOR UPDATE
       ), upserted AS (
         INSERT INTO audio_upload_chunks
           (session_id, sequence, sha256, size_bytes, content_base64)
         SELECT session_id, $2, $3, $4::integer, $7
           FROM target
          WHERE status = 'uploading'
            AND expires_at > NOW()
            AND (
              EXISTS (
                SELECT 1
                  FROM audio_upload_chunks
                 WHERE session_id = $1 AND sequence = $2
              )
              OR (
                total_bytes + $4::integer <= $5
                AND chunk_count < $6
              )
            )
         ON CONFLICT (session_id, sequence) DO UPDATE
           SET sha256 = audio_upload_chunks.sha256
         RETURNING session_id, sha256, (xmax = 0) AS inserted
       ), updated AS (
         UPDATE audio_upload_sessions AS sessions
            SET total_bytes = sessions.total_bytes + $4::integer,
                chunk_count = sessions.chunk_count + 1,
                updated_at = NOW()
           FROM upserted
          WHERE sessions.session_id = upserted.session_id
            AND upserted.inserted
         RETURNING sessions.total_bytes, sessions.chunk_count
       )
       SELECT target.status,
              target.expires_at,
              COALESCE(
                (SELECT total_bytes FROM updated),
                target.total_bytes
              ) AS total_bytes,
              COALESCE(
                (SELECT chunk_count FROM updated),
                target.chunk_count
              ) AS chunk_count,
              COALESCE(
                (SELECT inserted FROM upserted),
                FALSE
              ) AS inserted,
              (SELECT sha256 FROM upserted) AS existing_sha256
         FROM target`;
const allowedMimeTypes = new Map([
  ["audio/mp4", "speech.m4a"],
  ["audio/m4a", "speech.m4a"],
  ["audio/wav", "speech.wav"],
  ["audio/wave", "speech.wav"],
  ["audio/x-wav", "speech.wav"],
  ["audio/mpeg", "speech.mp3"],
  ["audio/ogg", "speech.ogg"],
  ["audio/webm", "speech.webm"],
]);

type UploadStatus = "uploading" | "finalizing" | "finalized";

type LocalSessionMetadata = {
  sessionId: string;
  status: UploadStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  finalizeLeaseUntil?: string;
  totalBytes: number;
  chunkCount: number;
  requestHash?: string;
  result?: unknown;
};

type DatabaseSessionRow = {
  status: UploadStatus;
  expires_at: string | Date;
  finalize_lease_until: string | Date | null;
  total_bytes: string | number;
  chunk_count: number;
  request_hash: string | null;
  result: unknown;
};

export type FinalizeClaim =
  | { state: "claimed" }
  | { state: "in_progress" }
  | { state: "completed"; result: unknown };

export type Pcm16WavMetadata = {
  sampleRate: number;
  channelCount: number;
  bitsPerSample: 16;
  pcmByteLength: number;
};

export class AudioUploadError extends Error {
  constructor(
    public readonly code:
      | "SESSION_NOT_FOUND"
      | "SESSION_EXPIRED"
      | "SESSION_BUSY"
      | "SESSION_FINALIZED"
      | "CHUNK_TOO_LARGE"
      | "SESSION_TOO_LARGE"
      | "TOO_MANY_CHUNKS"
      | "CHUNK_CONFLICT"
      | "MISSING_CHUNKS"
      | "UNSUPPORTED_AUDIO_TYPE"
      | "INVALID_SEQUENCE"
      | "EMPTY_CHUNK"
      | "INVALID_PCM_METADATA"
      | "IDEMPOTENCY_CONFLICT",
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AudioUploadError";
  }
}

type AudioSessionGlobalState = typeof globalThis & {
  __aiSpeakingAudioSessionMutationQueue?: Promise<void>;
  __aiSpeakingAudioSessionLastCleanupAt?: number;
};

const audioSessionGlobal = globalThis as AudioSessionGlobalState;

function getSessionsRoot() {
  return path.join(process.cwd(), "data", "audio-sessions");
}

function validateSessionId(sessionId: string) {
  if (!sessionIdPattern.test(sessionId)) {
    throw new AudioUploadError(
      "SESSION_NOT_FOUND",
      "Audio session không hợp lệ.",
      404,
    );
  }
}

function getSessionDir(sessionId: string) {
  validateSessionId(sessionId);
  return path.join(getSessionsRoot(), sessionId);
}

function getMetadataPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), metadataFileName);
}

function chunkFileName(sequence: number) {
  return `${sequence.toString().padStart(6, "0")}.part`;
}

function normalizeMimeType(mimeType: string) {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function getAudioFilename(mimeType: string) {
  const filename = allowedMimeTypes.get(normalizeMimeType(mimeType));

  if (!filename) {
    throw new AudioUploadError(
      "UNSUPPORTED_AUDIO_TYPE",
      "Định dạng audio không được hỗ trợ.",
      415,
      { mimeType },
    );
  }

  return filename;
}

function validatePcm16WavMetadata(
  value: Pcm16WavMetadata,
): Pcm16WavMetadata {
  const validSampleRate =
    Number.isInteger(value.sampleRate) &&
    value.sampleRate >= 8_000 &&
    value.sampleRate <= 96_000;
  const validChannelCount =
    Number.isInteger(value.channelCount) &&
    value.channelCount >= 1 &&
    value.channelCount <= 2;
  const validPcmLength =
    Number.isInteger(value.pcmByteLength) &&
    value.pcmByteLength > 0 &&
    value.pcmByteLength <= getAudioUploadLimits().maxSessionBytes;

  if (
    !validSampleRate ||
    !validChannelCount ||
    value.bitsPerSample !== 16 ||
    !validPcmLength ||
    value.pcmByteLength % (value.channelCount * 2) !== 0
  ) {
    throw new AudioUploadError(
      "INVALID_PCM_METADATA",
      "Thông tin PCM để hoàn tất WAV không hợp lệ.",
      400,
    );
  }

  return value;
}

function buildPcm16WavHeader(metadata: Pcm16WavMetadata) {
  const header = Buffer.alloc(44);
  const bytesPerSample = metadata.bitsPerSample / 8;
  const byteRate =
    metadata.sampleRate * metadata.channelCount * bytesPerSample;
  const blockAlign = metadata.channelCount * bytesPerSample;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + metadata.pcmByteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(metadata.channelCount, 22);
  header.writeUInt32LE(metadata.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(metadata.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(metadata.pcmByteLength, 40);
  return header;
}

function hashBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function enqueueLocalMutation<T>(operation: () => Promise<T>) {
  const queue =
    audioSessionGlobal.__aiSpeakingAudioSessionMutationQueue ??
    Promise.resolve();
  const result = queue.then(operation, operation);
  audioSessionGlobal.__aiSpeakingAudioSessionMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isFileNotFound(error: unknown) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readLocalMetadata(sessionId: string) {
  try {
    return JSON.parse(
      await readFile(getMetadataPath(sessionId), "utf8"),
    ) as LocalSessionMetadata;
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new AudioUploadError(
        "SESSION_NOT_FOUND",
        "Audio session không tồn tại hoặc đã được dọn dẹp.",
        404,
      );
    }

    throw error;
  }
}

async function writeLocalMetadata(metadata: LocalSessionMetadata) {
  const sessionDir = getSessionDir(metadata.sessionId);
  const destination = getMetadataPath(metadata.sessionId);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await mkdir(sessionDir, { recursive: true });

  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertSessionActive(
  session: Pick<LocalSessionMetadata, "expiresAt" | "status">,
) {
  if (Date.parse(session.expiresAt) <= Date.now()) {
    throw new AudioUploadError(
      "SESSION_EXPIRED",
      "Audio session đã hết hạn. Vui lòng ghi âm lại.",
      410,
    );
  }

  if (session.status === "finalizing") {
    throw new AudioUploadError(
      "SESSION_BUSY",
      "Audio session đang được hoàn tất.",
      409,
    );
  }

  if (session.status === "finalized") {
    throw new AudioUploadError(
      "SESSION_FINALIZED",
      "Audio session đã được hoàn tất.",
      409,
    );
  }
}

async function getDatabaseSession(sessionId: string) {
  const rows = await queryDatabase<DatabaseSessionRow>(
    `SELECT status, expires_at, finalize_lease_until, total_bytes,
            chunk_count, request_hash, result
       FROM audio_upload_sessions
      WHERE session_id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

function databaseExpiry(session: DatabaseSessionRow) {
  return new Date(session.expires_at).getTime();
}

function databaseLease(session: DatabaseSessionRow) {
  return session.finalize_lease_until
    ? new Date(session.finalize_lease_until).getTime()
    : 0;
}

export async function cleanupExpiredAudioSessions(force = false) {
  const now = Date.now();
  const lastCleanup =
    audioSessionGlobal.__aiSpeakingAudioSessionLastCleanupAt ?? 0;

  if (!force && now - lastCleanup < 60_000) {
    return 0;
  }

  audioSessionGlobal.__aiSpeakingAudioSessionLastCleanupAt = now;

  if (isPostgresStorageEnabled()) {
    const rows = await queryDatabase<{ session_id: string }>(
      `DELETE FROM audio_upload_sessions
        WHERE expires_at <= NOW()
        RETURNING session_id`,
    );
    return rows.length;
  }

  const root = getSessionsRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !sessionIdPattern.test(entry.name)) {
      continue;
    }

    const sessionDir = path.join(root, entry.name);
    let expiresAt = 0;

    try {
      const metadata = await readLocalMetadata(entry.name);
      expiresAt = Date.parse(metadata.expiresAt);
    } catch (error) {
      if (!(error instanceof AudioUploadError)) {
        throw error;
      }
      expiresAt = (await stat(sessionDir)).mtimeMs + 60_000;
    }

    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      await rm(sessionDir, { recursive: true, force: true });
      deleted += 1;
    }
  }

  return deleted;
}

export async function createAudioUploadSession() {
  await cleanupExpiredAudioSessions();
  const sessionId = `audio_${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + getAudioUploadLimits().sessionTtlSeconds * 1000,
  );

  if (isPostgresStorageEnabled()) {
    await queryDatabase(
      `INSERT INTO audio_upload_sessions
        (session_id, status, created_at, updated_at, expires_at)
       VALUES ($1, 'uploading', $2::timestamptz, $2::timestamptz, $3::timestamptz)`,
      [sessionId, now.toISOString(), expiresAt.toISOString()],
    );
    return sessionId;
  }

  await writeLocalMetadata({
    sessionId,
    status: "uploading",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    totalBytes: 0,
    chunkCount: 0,
  });
  return sessionId;
}

function validateChunk(sequence: number, buffer: Buffer) {
  const limits = getAudioUploadLimits();

  if (
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    sequence >= limits.maxChunks
  ) {
    throw new AudioUploadError(
      "INVALID_SEQUENCE",
      "Số thứ tự audio chunk không hợp lệ.",
      400,
      { sequence, maxChunks: limits.maxChunks },
    );
  }

  if (buffer.byteLength === 0) {
    throw new AudioUploadError(
      "EMPTY_CHUNK",
      "Audio chunk không được để trống.",
      400,
    );
  }

  if (buffer.byteLength > limits.maxChunkBytes) {
    throw new AudioUploadError(
      "CHUNK_TOO_LARGE",
      "Audio chunk vượt quá dung lượng cho phép.",
      413,
      { sizeBytes: buffer.byteLength, maxChunkBytes: limits.maxChunkBytes },
    );
  }
}

export async function saveAudioSessionChunk(
  sessionId: string,
  sequence: number,
  chunk: File,
) {
  validateSessionId(sessionId);
  const buffer = Buffer.from(await chunk.arrayBuffer());
  validateChunk(sequence, buffer);
  const sha256 = hashBuffer(buffer);
  const limits = getAudioUploadLimits();

  if (isPostgresStorageEnabled()) {
    const rows = await queryDatabase<{
      status: UploadStatus;
      expires_at: string | Date;
      total_bytes: string | number;
      chunk_count: number;
      inserted: boolean;
      existing_sha256: string | null;
    }>(
      postgresAudioChunkUpsertQuery,
      [
        sessionId,
        sequence,
        sha256,
        buffer.byteLength,
        limits.maxSessionBytes,
        limits.maxChunks,
        buffer.toString("base64"),
      ],
    );
    const session = rows[0];

    if (!session) {
      throw new AudioUploadError(
        "SESSION_NOT_FOUND",
        "Audio session không tồn tại.",
        404,
      );
    }
    assertSessionActive({
      status: session.status,
      expiresAt: new Date(session.expires_at).toISOString(),
    });

    if (session.inserted) {
      return {
        duplicate: false,
        totalBytes: Number(session.total_bytes),
        chunkCount: session.chunk_count,
      };
    }

    if (session.existing_sha256 === sha256) {
      return {
        duplicate: true,
        totalBytes: Number(session.total_bytes),
        chunkCount: session.chunk_count,
      };
    }

    if (session.existing_sha256) {
      throw new AudioUploadError(
        "CHUNK_CONFLICT",
        "Chunk đã tồn tại nhưng nội dung không giống lần upload trước.",
        409,
        { sequence },
      );
    }

    if (Number(session.total_bytes) + buffer.byteLength > limits.maxSessionBytes) {
      throw new AudioUploadError(
        "SESSION_TOO_LARGE",
        "Tổng dung lượng audio session vượt quá giới hạn.",
        413,
        { maxSessionBytes: limits.maxSessionBytes },
      );
    }

    throw new AudioUploadError(
      "TOO_MANY_CHUNKS",
      "Audio session có quá nhiều chunk.",
      413,
      { maxChunks: limits.maxChunks },
    );
  }

  return enqueueLocalMutation(async () => {
    const metadata = await readLocalMetadata(sessionId);
    assertSessionActive(metadata);
    const chunkPath = path.join(getSessionDir(sessionId), chunkFileName(sequence));

    try {
      const existing = await readFile(chunkPath);

      if (hashBuffer(existing) === sha256) {
        return {
          duplicate: true,
          totalBytes: metadata.totalBytes,
          chunkCount: metadata.chunkCount,
        };
      }

      throw new AudioUploadError(
        "CHUNK_CONFLICT",
        "Chunk đã tồn tại nhưng nội dung không giống lần upload trước.",
        409,
        { sequence },
      );
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }

    if (metadata.totalBytes + buffer.byteLength > limits.maxSessionBytes) {
      throw new AudioUploadError(
        "SESSION_TOO_LARGE",
        "Tổng dung lượng audio session vượt quá giới hạn.",
        413,
        { maxSessionBytes: limits.maxSessionBytes },
      );
    }

    if (metadata.chunkCount >= limits.maxChunks) {
      throw new AudioUploadError(
        "TOO_MANY_CHUNKS",
        "Audio session có quá nhiều chunk.",
        413,
        { maxChunks: limits.maxChunks },
      );
    }

    const temporary = `${chunkPath}.${crypto.randomUUID()}.tmp`;

    try {
      await writeFile(temporary, buffer);
      await rename(temporary, chunkPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }

    const nextMetadata: LocalSessionMetadata = {
      ...metadata,
      updatedAt: new Date().toISOString(),
      totalBytes: metadata.totalBytes + buffer.byteLength,
      chunkCount: metadata.chunkCount + 1,
    };
    await writeLocalMetadata(nextMetadata);
    return {
      duplicate: false,
      totalBytes: nextMetadata.totalBytes,
      chunkCount: nextMetadata.chunkCount,
    };
  });
}

function validateChunkSequence(sequences: number[]) {
  if (sequences.length === 0) {
    throw new AudioUploadError(
      "MISSING_CHUNKS",
      "Audio session chưa có chunk nào.",
      400,
    );
  }

  const highest = sequences.at(-1) ?? -1;
  const sequenceSet = new Set(sequences);
  const missing: number[] = [];

  for (let sequence = 0; sequence <= highest; sequence += 1) {
    if (!sequenceSet.has(sequence)) {
      missing.push(sequence);
    }
  }

  if (missing.length > 0) {
    throw new AudioUploadError(
      "MISSING_CHUNKS",
      `Audio session thiếu chunk: ${missing.slice(0, 20).join(", ")}.`,
      409,
      { missingSequences: missing.slice(0, 100) },
    );
  }
}

export async function finalizeAudioUploadSession(
  sessionId: string,
  mimeType = "audio/webm",
  pcm16Wav?: Pcm16WavMetadata,
) {
  validateSessionId(sessionId);
  const filename = getAudioFilename(mimeType);
  const normalizedMimeType = normalizeMimeType(mimeType);
  const pcmMetadata = pcm16Wav
    ? validatePcm16WavMetadata(pcm16Wav)
    : undefined;
  if (pcmMetadata && normalizedMimeType !== "audio/wav") {
    throw new AudioUploadError(
      "INVALID_PCM_METADATA",
      "Metadata PCM chỉ được dùng với audio/wav.",
      400,
    );
  }
  let buffers: Buffer[];

  if (isPostgresStorageEnabled()) {
    const session = await getDatabaseSession(sessionId);

    if (!session) {
      throw new AudioUploadError(
        "SESSION_NOT_FOUND",
        "Audio session không tồn tại.",
        404,
      );
    }

    const rows = await queryDatabase<{
      sequence: number;
      content_base64: string;
    }>(
      `SELECT sequence, content_base64
         FROM audio_upload_chunks
        WHERE session_id = $1
        ORDER BY sequence ASC`,
      [sessionId],
    );
    validateChunkSequence(rows.map((row) => row.sequence));
    buffers = rows.map((row) => Buffer.from(row.content_base64, "base64"));
  } else {
    const metadata = await readLocalMetadata(sessionId);

    if (Date.parse(metadata.expiresAt) <= Date.now()) {
      throw new AudioUploadError(
        "SESSION_EXPIRED",
        "Audio session đã hết hạn. Vui lòng ghi âm lại.",
        410,
      );
    }

    const sessionDir = getSessionDir(sessionId);
    const chunkNames = (await readdir(sessionDir))
      .filter((name) => /^\d{6}\.part$/.test(name))
      .sort();
    const sequences = chunkNames.map((name) => Number(name.slice(0, 6)));
    validateChunkSequence(sequences);
    buffers = await Promise.all(
      chunkNames.map((name) => readFile(path.join(sessionDir, name))),
    );
  }

  const pcmOrAudio = Buffer.concat(buffers);

  if (pcmOrAudio.byteLength > getAudioUploadLimits().maxSessionBytes) {
    throw new AudioUploadError(
      "SESSION_TOO_LARGE",
      "Tổng dung lượng audio session vượt quá giới hạn.",
      413,
    );
  }

  if (
    pcmMetadata &&
    pcmOrAudio.byteLength !== pcmMetadata.pcmByteLength
  ) {
    throw new AudioUploadError(
      "INVALID_PCM_METADATA",
      "Số byte PCM không khớp dữ liệu đã upload.",
      409,
      {
        expectedBytes: pcmMetadata.pcmByteLength,
        actualBytes: pcmOrAudio.byteLength,
      },
    );
  }

  const audio = pcmMetadata
    ? Buffer.concat([buildPcm16WavHeader(pcmMetadata), pcmOrAudio])
    : pcmOrAudio;

  return new File([audio], filename, {
    type: normalizedMimeType,
  });
}

export async function claimAudioSessionFinalize(
  sessionId: string,
  requestHash: string,
): Promise<FinalizeClaim> {
  validateSessionId(sessionId);
  const limits = getAudioUploadLimits();
  const now = Date.now();
  const leaseUntil = new Date(now + limits.finalizeLeaseSeconds * 1000);

  if (isPostgresStorageEnabled()) {
    const session = await getDatabaseSession(sessionId);

    if (!session) {
      throw new AudioUploadError(
        "SESSION_NOT_FOUND",
        "Audio session không tồn tại.",
        404,
      );
    }

    if (databaseExpiry(session) <= now) {
      throw new AudioUploadError(
        "SESSION_EXPIRED",
        "Audio session đã hết hạn. Vui lòng ghi âm lại.",
        410,
      );
    }

    if (session.status === "finalized") {
      if (session.request_hash !== requestHash) {
        throw new AudioUploadError(
          "IDEMPOTENCY_CONFLICT",
          "Finalize đã hoàn tất với nội dung yêu cầu khác.",
          409,
        );
      }
      return { state: "completed", result: session.result };
    }

    if (session.status === "finalizing" && databaseLease(session) > now) {
      if (session.request_hash && session.request_hash !== requestHash) {
        throw new AudioUploadError(
          "IDEMPOTENCY_CONFLICT",
          "Finalize đang chạy với nội dung yêu cầu khác.",
          409,
        );
      }
      return { state: "in_progress" };
    }

    const rows = await queryDatabase<{ session_id: string }>(
      `UPDATE audio_upload_sessions
          SET status = 'finalizing', request_hash = $2,
              finalize_lease_until = $3::timestamptz, updated_at = NOW()
        WHERE session_id = $1
          AND status <> 'finalized'
          AND (status = 'uploading' OR finalize_lease_until <= NOW())
        RETURNING session_id`,
      [sessionId, requestHash, leaseUntil.toISOString()],
    );
    return rows.length > 0 ? { state: "claimed" } : { state: "in_progress" };
  }

  return enqueueLocalMutation(async () => {
    const metadata = await readLocalMetadata(sessionId);

    if (Date.parse(metadata.expiresAt) <= now) {
      throw new AudioUploadError(
        "SESSION_EXPIRED",
        "Audio session đã hết hạn. Vui lòng ghi âm lại.",
        410,
      );
    }

    if (metadata.status === "finalized") {
      if (metadata.requestHash !== requestHash) {
        throw new AudioUploadError(
          "IDEMPOTENCY_CONFLICT",
          "Finalize đã hoàn tất với nội dung yêu cầu khác.",
          409,
        );
      }
      return { state: "completed", result: metadata.result };
    }

    if (
      metadata.status === "finalizing" &&
      Date.parse(metadata.finalizeLeaseUntil ?? "") > now
    ) {
      if (metadata.requestHash && metadata.requestHash !== requestHash) {
        throw new AudioUploadError(
          "IDEMPOTENCY_CONFLICT",
          "Finalize đang chạy với nội dung yêu cầu khác.",
          409,
        );
      }
      return { state: "in_progress" };
    }

    await writeLocalMetadata({
      ...metadata,
      status: "finalizing",
      requestHash,
      finalizeLeaseUntil: leaseUntil.toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { state: "claimed" };
  });
}

export async function completeAudioSessionFinalize(
  sessionId: string,
  requestHash: string,
  result: unknown,
) {
  const expiresAt = new Date(
    Date.now() + getAudioUploadLimits().finalizedResultTtlSeconds * 1000,
  ).toISOString();

  if (isPostgresStorageEnabled()) {
    const rows = await queryDatabase<{ session_id: string }>(
      `UPDATE audio_upload_sessions
          SET status = 'finalized', result = $3::jsonb,
              expires_at = $4::timestamptz, finalize_lease_until = NULL,
              updated_at = NOW()
        WHERE session_id = $1 AND request_hash = $2
        RETURNING session_id`,
      [sessionId, requestHash, JSON.stringify(result), expiresAt],
    );

    if (rows.length === 0) {
      throw new AudioUploadError(
        "IDEMPOTENCY_CONFLICT",
        "Không thể lưu kết quả finalize vì khóa yêu cầu không khớp.",
        409,
      );
    }

    await queryDatabase(`DELETE FROM audio_upload_chunks WHERE session_id = $1`, [
      sessionId,
    ]);
    return;
  }

  await enqueueLocalMutation(async () => {
    const metadata = await readLocalMetadata(sessionId);

    if (metadata.requestHash !== requestHash) {
      throw new AudioUploadError(
        "IDEMPOTENCY_CONFLICT",
        "Không thể lưu kết quả finalize vì khóa yêu cầu không khớp.",
        409,
      );
    }

    await writeLocalMetadata({
      ...metadata,
      status: "finalized",
      result,
      expiresAt,
      finalizeLeaseUntil: undefined,
      updatedAt: new Date().toISOString(),
    });
    const sessionDir = getSessionDir(sessionId);
    const names = await readdir(sessionDir);
    await Promise.all(
      names
        .filter((name) => name.endsWith(".part"))
        .map((name) => rm(path.join(sessionDir, name), { force: true })),
    );
  });
}

export async function releaseAudioSessionFinalize(
  sessionId: string,
  requestHash: string,
) {
  if (isPostgresStorageEnabled()) {
    await queryDatabase(
      `UPDATE audio_upload_sessions
          SET status = 'uploading', request_hash = NULL,
              finalize_lease_until = NULL, updated_at = NOW()
        WHERE session_id = $1 AND status = 'finalizing' AND request_hash = $2`,
      [sessionId, requestHash],
    );
    return;
  }

  await enqueueLocalMutation(async () => {
    const metadata = await readLocalMetadata(sessionId);

    if (metadata.status === "finalizing" && metadata.requestHash === requestHash) {
      await writeLocalMetadata({
        ...metadata,
        status: "uploading",
        requestHash: undefined,
        finalizeLeaseUntil: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }).catch((error) => {
    if (!(error instanceof AudioUploadError)) {
      throw error;
    }
  });
}

export async function discardAudioUploadSession(sessionId: string) {
  validateSessionId(sessionId);

  if (isPostgresStorageEnabled()) {
    await queryDatabase(
      `DELETE FROM audio_upload_sessions WHERE session_id = $1`,
      [sessionId],
    );
    return;
  }

  await rm(getSessionDir(sessionId), { recursive: true, force: true });
}
