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
import {
  getAudioSessionChunkStorageBackend,
  getAudioUploadLimits,
  type AudioSessionChunkStorageBackend,
} from "@/lib/storage/config";
import {
  deleteAudioSessionChunkObjects,
  putAudioSessionChunkObject,
  readAudioSessionChunkObject,
} from "@/lib/storage/audioSessionR2";
import {
  deleteHotAudioSession,
  pruneHotAudioSessions,
  readHotAudioPrefix,
  readHotAudioTail,
  rememberHotAudioChunk,
} from "@/lib/storage/audioSessionHotCache";

const sessionIdPattern = /^audio_[a-z0-9-]+$/;
const metadataFileName = "session.json";
export const postgresAudioChunkUpsertQuery = `WITH target AS (
         SELECT session_id, status, expires_at, total_bytes, chunk_count,
                chunk_storage_backend
           FROM audio_upload_sessions
          WHERE session_id = $1
          FOR UPDATE
       ), upserted AS (
         INSERT INTO audio_upload_chunks
           (session_id, sequence, sha256, size_bytes, content_base64,
            object_key, storage_backend)
         SELECT session_id, $2, $3, $4::integer, $7, $8, $9
           FROM target
          WHERE status = 'uploading'
            AND expires_at > NOW()
            AND chunk_storage_backend = $9
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
         RETURNING session_id, sha256, object_key, storage_backend,
                   (xmax = 0) AS inserted
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
              (SELECT sha256 FROM upserted) AS existing_sha256,
              target.chunk_storage_backend
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
  chunkStorageBackend?: AudioSessionChunkStorageBackend;
  requestHash?: string;
  result?: unknown;
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
  chunkCount?: number;
};

export type AudioSessionPrefetchTailResult = {
  eligible: boolean;
  reason:
    | "tail_silent"
    | "snapshot_mismatch"
    | "session_mismatch"
    | "tail_too_long"
    | "tail_contains_speech";
  extraChunkCount: number;
  tailDurationMs: number;
  tailRms: number;
  activeFrameRatio?: number;
  longestSpeechRunMs?: number;
  noiseFloorRms?: number;
  speechThresholdRms?: number;
  assemblySource?: AudioAssemblySource;
};

export type AudioAssemblySource = "memory" | "postgres" | "r2" | "local";

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
      | "CHUNK_CHECKSUM_MISMATCH"
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

function getAudioSessionIdPrefix(
  scoped: boolean,
  chunkStorageBackend: AudioSessionChunkStorageBackend,
) {
  if (chunkStorageBackend === "r2") {
    return scoped ? "audio_v2-r2-" : "audio_r2-";
  }
  return scoped ? "audio_v2-" : "audio_";
}

function isR2AudioSessionId(sessionId: string) {
  return sessionId.startsWith("audio_r2-") || sessionId.startsWith("audio_v2-r2-");
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
  const validChunkCount =
    value.chunkCount === undefined ||
    (Number.isInteger(value.chunkCount) &&
      value.chunkCount > 0 &&
      value.chunkCount <= getAudioUploadLimits().maxChunks);

  if (
    !validSampleRate ||
    !validChannelCount ||
    value.bitsPerSample !== 16 ||
    !validPcmLength ||
    !validChunkCount ||
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

export async function cleanupExpiredAudioSessions(force = false) {
  const now = Date.now();
  pruneHotAudioSessions(now);
  const lastCleanup =
    audioSessionGlobal.__aiSpeakingAudioSessionLastCleanupAt ?? 0;

  if (!force && now - lastCleanup < 60_000) {
    return 0;
  }

  audioSessionGlobal.__aiSpeakingAudioSessionLastCleanupAt = now;

  if (isPostgresStorageEnabled()) {
    const rows = await queryDatabase<{
      session_id: string;
      object_key: string | null;
      storage_backend: AudioSessionChunkStorageBackend | null;
    }>(
      `WITH expired AS MATERIALIZED (
         SELECT session_id
           FROM audio_upload_sessions
          WHERE expires_at <= NOW()
       ), deleted_chunks AS (
         DELETE FROM audio_upload_chunks AS chunks
          USING expired
          WHERE chunks.session_id = expired.session_id
         RETURNING chunks.session_id, chunks.object_key, chunks.storage_backend
       ), deleted_sessions AS (
         DELETE FROM audio_upload_sessions AS sessions
          USING expired
          WHERE sessions.session_id = expired.session_id
            AND (SELECT COUNT(*) FROM deleted_chunks) >= 0
         RETURNING sessions.session_id
       )
       SELECT sessions.session_id, chunks.object_key, chunks.storage_backend
         FROM deleted_sessions AS sessions
         LEFT JOIN deleted_chunks AS chunks
           ON chunks.session_id = sessions.session_id`,
    );
    await deleteAudioSessionChunkObjects(
      rows
        .filter((row) => row.storage_backend === "r2")
        .map((row) => row.object_key ?? ""),
    );
    const deletedSessionIds = new Set(rows.map((row) => row.session_id));
    for (const sessionId of deletedSessionIds) {
      deleteHotAudioSession(sessionId);
    }
    return deletedSessionIds.size;
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

export async function createAudioUploadSession(options?: { scoped?: boolean }) {
  await cleanupExpiredAudioSessions();
  const chunkStorageBackend = getAudioSessionChunkStorageBackend();
  const sessionId = `${getAudioSessionIdPrefix(
    options?.scoped === true,
    chunkStorageBackend,
  )}${crypto.randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + getAudioUploadLimits().sessionTtlSeconds * 1000,
  );

  if (isPostgresStorageEnabled()) {
    await queryDatabase(
      `INSERT INTO audio_upload_sessions
        (session_id, status, created_at, updated_at, expires_at,
         chunk_storage_backend)
       VALUES ($1, 'uploading', $2::timestamptz, $2::timestamptz,
               $3::timestamptz, $4)`,
      [
        sessionId,
        now.toISOString(),
        expiresAt.toISOString(),
        chunkStorageBackend,
      ],
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
    chunkStorageBackend: "local",
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
  expectedSha256?: string,
) {
  validateSessionId(sessionId);
  const buffer = Buffer.from(await chunk.arrayBuffer());
  validateChunk(sequence, buffer);
  const sha256 = hashBuffer(buffer);
  if (expectedSha256 && expectedSha256 !== sha256) {
    throw new AudioUploadError(
      "CHUNK_CHECKSUM_MISMATCH",
      "Checksum SHA-256 của audio chunk không khớp nội dung upload.",
      400,
      { sequence, expectedSha256, actualSha256: sha256 },
    );
  }
  const limits = getAudioUploadLimits();

  if (isPostgresStorageEnabled()) {
    const chunkStorageBackend: AudioSessionChunkStorageBackend =
      isR2AudioSessionId(sessionId) ? "r2" : "postgres";
    const r2Object =
      chunkStorageBackend === "r2"
        ? await putAudioSessionChunkObject(
            sessionId,
            sequence,
            sha256,
            buffer,
          )
        : null;

    try {
      const rows = await queryDatabase<{
        status: UploadStatus;
        expires_at: string | Date;
        total_bytes: string | number;
        chunk_count: number;
        inserted: boolean;
        existing_sha256: string | null;
        chunk_storage_backend: AudioSessionChunkStorageBackend;
      }>(postgresAudioChunkUpsertQuery, [
        sessionId,
        sequence,
        sha256,
        buffer.byteLength,
        limits.maxSessionBytes,
        limits.maxChunks,
        chunkStorageBackend === "postgres"
          ? buffer.toString("base64")
          : null,
        r2Object?.key ?? null,
        chunkStorageBackend,
      ]);
      const session = rows[0];

      if (!session) {
        throw new AudioUploadError(
          "SESSION_NOT_FOUND",
          "Audio session không tồn tại.",
          404,
        );
      }
      if (session.chunk_storage_backend !== chunkStorageBackend) {
        throw new AudioUploadError(
          "SESSION_NOT_FOUND",
          "Cấu hình lưu chunk của audio session không còn hợp lệ.",
          409,
        );
      }
      assertSessionActive({
        status: session.status,
        expiresAt: new Date(session.expires_at).toISOString(),
      });

      if (session.inserted) {
        rememberHotAudioChunk({
          sessionId,
          sequence,
          sha256,
          bytes: buffer,
          expiresAt: new Date(session.expires_at).getTime(),
        });
        return {
          duplicate: false,
          sha256,
          totalBytes: Number(session.total_bytes),
          chunkCount: session.chunk_count,
        };
      }

      if (session.existing_sha256 === sha256) {
        rememberHotAudioChunk({
          sessionId,
          sequence,
          sha256,
          bytes: buffer,
          expiresAt: new Date(session.expires_at).getTime(),
        });
        return {
          duplicate: true,
          sha256,
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

      if (
        Number(session.total_bytes) + buffer.byteLength >
        limits.maxSessionBytes
      ) {
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
    } catch (error) {
      if (r2Object?.created) {
        await deleteAudioSessionChunkObjects([r2Object.key]).catch(
          () => undefined,
        );
      }
      throw error;
    }
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
          sha256,
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
      sha256,
      totalBytes: nextMetadata.totalBytes,
      chunkCount: nextMetadata.chunkCount,
    };
  });
}

function validateChunkSequence(sequences: number[], expectedChunkCount?: number) {
  if (sequences.length === 0) {
    throw new AudioUploadError(
      "MISSING_CHUNKS",
      "Audio session chưa có chunk nào.",
      400,
    );
  }

  const highest =
    expectedChunkCount === undefined
      ? (sequences.at(-1) ?? -1)
      : expectedChunkCount - 1;
  const unexpected =
    expectedChunkCount === undefined
      ? []
      : sequences.filter((sequence) => sequence >= expectedChunkCount);
  if (unexpected.length > 0) {
    throw new AudioUploadError(
      "INVALID_PCM_METADATA",
      "Audio session có sequence vượt ngoài metadata finalize.",
      409,
      { unexpectedSequences: unexpected.slice(0, 100) },
    );
  }
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
  options: {
    allowTrailingChunks?: boolean;
    onAssemblySource?: (source: AudioAssemblySource) => void;
  } = {},
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
  const snapshotChunkCount = options.allowTrailingChunks
    ? pcmMetadata?.chunkCount
    : undefined;
  let buffers: Buffer[];
  const hotPcm =
    isPostgresStorageEnabled() && pcmMetadata?.chunkCount !== undefined
      ? readHotAudioPrefix({
          sessionId,
          chunkCount: pcmMetadata.chunkCount,
          pcmByteLength: pcmMetadata.pcmByteLength,
          allowTrailingChunks: options.allowTrailingChunks,
        })
      : null;

  if (hotPcm) {
    buffers = [hotPcm];
    options.onAssemblySource?.("memory");
  } else if (isPostgresStorageEnabled()) {
    const rows = await queryDatabase<{
      status: UploadStatus;
      expires_at: string | Date;
      chunk_storage_backend: AudioSessionChunkStorageBackend;
      sequence: number | null;
      content_base64: string | null;
      object_key: string | null;
      storage_backend: AudioSessionChunkStorageBackend | null;
    }>(
      `SELECT sessions.status, sessions.expires_at,
              sessions.chunk_storage_backend,
              chunks.sequence, chunks.content_base64,
              chunks.object_key, chunks.storage_backend
         FROM audio_upload_sessions AS sessions
         LEFT JOIN audio_upload_chunks AS chunks
           ON chunks.session_id = sessions.session_id
        WHERE sessions.session_id = $1
        ORDER BY chunks.sequence ASC`,
      [sessionId],
    );
    const session = rows[0];

    if (!session) {
      throw new AudioUploadError(
        "SESSION_NOT_FOUND",
        "Audio session không tồn tại.",
        404,
      );
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new AudioUploadError(
        "SESSION_EXPIRED",
        "Audio session đã hết hạn. Vui lòng ghi âm lại.",
        410,
      );
    }
    options.onAssemblySource?.(session.chunk_storage_backend);
    const allChunkRows = rows.filter(
      (row): row is typeof row & { sequence: number } =>
        row.sequence !== null,
    );
    const chunkRows =
      snapshotChunkCount !== undefined
        ? allChunkRows.filter((row) => row.sequence < snapshotChunkCount)
        : allChunkRows;
    validateChunkSequence(
      chunkRows.map((row) => row.sequence),
      pcmMetadata?.chunkCount,
    );
    buffers = await Promise.all(
      chunkRows.map(async (row) => {
        const storageBackend =
          row.storage_backend ?? session.chunk_storage_backend;
        if (storageBackend === "r2") {
          if (!row.object_key) {
            throw new AudioUploadError(
              "MISSING_CHUNKS",
              `Chunk ${row.sequence} thiếu R2 object key.`,
              409,
              { missingSequences: [row.sequence] },
            );
          }
          return readAudioSessionChunkObject(row.object_key);
        }
        if (!row.content_base64) {
          throw new AudioUploadError(
            "MISSING_CHUNKS",
            `Chunk ${row.sequence} không có dữ liệu.`,
            409,
            { missingSequences: [row.sequence] },
          );
        }
        return Buffer.from(row.content_base64, "base64");
      }),
    );
  } else {
    options.onAssemblySource?.("local");
    const metadata = await readLocalMetadata(sessionId);

    if (Date.parse(metadata.expiresAt) <= Date.now()) {
      throw new AudioUploadError(
        "SESSION_EXPIRED",
        "Audio session đã hết hạn. Vui lòng ghi âm lại.",
        410,
      );
    }

    const sessionDir = getSessionDir(sessionId);
    const allChunkNames = (await readdir(sessionDir))
      .filter((name) => /^\d{6}\.part$/.test(name))
      .sort();
    const chunkNames =
      snapshotChunkCount !== undefined
        ? allChunkNames.filter(
            (name) => Number(name.slice(0, 6)) < snapshotChunkCount,
          )
        : allChunkNames;
    const sequences = chunkNames.map((name) => Number(name.slice(0, 6)));
    validateChunkSequence(sequences, pcmMetadata?.chunkCount);
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

export function analyzePcm16Silence(
  pcm: Buffer,
  noiseRms?: number,
  sampleRate = 16_000,
  channelCount = 1,
) {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    return {
      silent: false,
      rms: 1,
      activeSampleRatio: 1,
      activeFrameRatio: 1,
      longestSpeechRunMs: 0,
      noiseFloorRms: 0,
      speechThresholdRms: 0,
    };
  }

  const sampleCount = pcm.byteLength / 2;
  let squaredTotal = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    const value = pcm.readInt16LE(offset) / 32_768;
    squaredTotal += value * value;
  }
  const rms = Math.sqrt(squaredTotal / sampleCount);

  // A whole-buffer RMS gate rejects valid previews in a noisy room because a
  // fan or road noise can keep the complete tail above a fixed threshold. Use
  // 20 ms frames instead and look for a sustained speech-shaped energy burst.
  const safeSampleRate = Math.max(8_000, Math.min(96_000, sampleRate));
  const safeChannelCount = Math.max(1, Math.min(2, channelCount));
  const frameDurationMs = 20;
  const frameSampleCount = Math.max(
    safeChannelCount,
    Math.round((safeSampleRate * safeChannelCount * frameDurationMs) / 1_000),
  );
  const frames: Array<{ rms: number; peak: number }> = [];
  for (let startSample = 0; startSample < sampleCount; startSample += frameSampleCount) {
    const endSample = Math.min(sampleCount, startSample + frameSampleCount);
    let frameSquaredTotal = 0;
    let peak = 0;
    for (let index = startSample; index < endSample; index += 1) {
      const value = pcm.readInt16LE(index * 2) / 32_768;
      frameSquaredTotal += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    frames.push({
      rms: Math.sqrt(frameSquaredTotal / Math.max(1, endSample - startSample)),
      peak,
    });
  }

  const sortedFrameRms = frames.map((frame) => frame.rms).sort((a, b) => a - b);
  const lowerQuartileIndex = Math.min(
    sortedFrameRms.length - 1,
    Math.floor(sortedFrameRms.length * 0.25),
  );
  const observedNoiseFloor = sortedFrameRms[Math.max(0, lowerQuartileIndex)] ?? 0;
  const suppliedNoiseFloor =
    Number.isFinite(noiseRms) && (noiseRms ?? 0) > 0 ? noiseRms! : undefined;
  // The first client amplitude can already contain speech, so never let it
  // raise the adaptive floor above what the quiet tail frames demonstrate.
  const noiseFloorRms = Math.max(
    0.003,
    Math.min(
      0.08,
      suppliedNoiseFloor === undefined
        ? observedNoiseFloor
        : Math.min(suppliedNoiseFloor, observedNoiseFloor || suppliedNoiseFloor),
    ),
  );
  const speechThresholdRms = Math.max(
    0.022,
    Math.min(0.12, noiseFloorRms * 1.75 + 0.008),
  );
  const peakThreshold = Math.max(0.07, speechThresholdRms * 1.45);

  let activeFrames = 0;
  let currentSpeechRun = 0;
  let longestSpeechRun = 0;
  for (const frame of frames) {
    const active =
      frame.rms >= speechThresholdRms && frame.peak >= peakThreshold;
    if (active) {
      activeFrames += 1;
      currentSpeechRun += 1;
      longestSpeechRun = Math.max(longestSpeechRun, currentSpeechRun);
    } else {
      currentSpeechRun = 0;
    }
  }
  const activeFrameRatio = activeFrames / Math.max(1, frames.length);
  const longestSpeechRunMs = longestSpeechRun * frameDurationMs;
  const containsSpeech =
    longestSpeechRunMs >= 80 ||
    (activeFrameRatio >= 0.18 && longestSpeechRunMs >= 40);

  return {
    silent: !containsSpeech,
    rms,
    activeSampleRatio: activeFrameRatio,
    activeFrameRatio,
    longestSpeechRunMs,
    noiseFloorRms,
    speechThresholdRms,
  };
}

export async function validateAudioSessionPrefetchTail(
  sessionId: string,
  snapshot: Pcm16WavMetadata & { chunkCount: number },
  finalMetadata: Pcm16WavMetadata & { chunkCount: number },
  noiseRms?: number,
): Promise<AudioSessionPrefetchTailResult> {
  validateSessionId(sessionId);
  validatePcm16WavMetadata(snapshot);
  validatePcm16WavMetadata(finalMetadata);
  const configsMatch =
    snapshot.sampleRate === finalMetadata.sampleRate &&
    snapshot.channelCount === finalMetadata.channelCount &&
    snapshot.bitsPerSample === finalMetadata.bitsPerSample &&
    snapshot.chunkCount <= finalMetadata.chunkCount &&
    snapshot.pcmByteLength <= finalMetadata.pcmByteLength;
  if (!configsMatch) {
    return {
      eligible: false,
      reason: "snapshot_mismatch",
      extraChunkCount: 0,
      tailDurationMs: 0,
      tailRms: 0,
    };
  }

  let sessionChunkCount = 0;
  let sessionTotalBytes = 0;
  let tailBuffers: Buffer[] = [];
  let extraChunkCount = 0;
  let assemblySource: AudioAssemblySource | undefined;
  const hotTail = isPostgresStorageEnabled()
    ? readHotAudioTail({
        sessionId,
        snapshotChunkCount: snapshot.chunkCount,
        snapshotPcmByteLength: snapshot.pcmByteLength,
        finalChunkCount: finalMetadata.chunkCount,
        finalPcmByteLength: finalMetadata.pcmByteLength,
      })
    : null;
  if (hotTail) {
    sessionChunkCount = finalMetadata.chunkCount;
    sessionTotalBytes = finalMetadata.pcmByteLength;
    tailBuffers = [hotTail.tail];
    extraChunkCount = hotTail.extraChunkCount;
    assemblySource = "memory";
  } else if (isPostgresStorageEnabled()) {
    const rows = await queryDatabase<{
      status: UploadStatus;
      expires_at: string | Date;
      total_bytes: string | number;
      chunk_count: number;
      chunk_storage_backend: AudioSessionChunkStorageBackend;
      sequence: number | null;
      content_base64: string | null;
      object_key: string | null;
      storage_backend: AudioSessionChunkStorageBackend | null;
    }>(
      `SELECT sessions.status, sessions.expires_at, sessions.total_bytes,
              sessions.chunk_count, sessions.chunk_storage_backend,
              chunks.sequence, chunks.content_base64,
              chunks.object_key, chunks.storage_backend
         FROM audio_upload_sessions AS sessions
         LEFT JOIN audio_upload_chunks AS chunks
           ON chunks.session_id = sessions.session_id
          AND chunks.sequence >= $2
        WHERE sessions.session_id = $1
        ORDER BY chunks.sequence ASC`,
      [sessionId, snapshot.chunkCount],
    );
    const session = rows[0];
    if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
      return {
        eligible: false,
        reason: "session_mismatch",
        extraChunkCount: 0,
        tailDurationMs: 0,
        tailRms: 0,
      };
    }
    sessionChunkCount = session.chunk_count;
    sessionTotalBytes = Number(session.total_bytes);
    assemblySource = session.chunk_storage_backend;
    const chunks = rows.filter(
      (row): row is typeof row & { sequence: number } => row.sequence !== null,
    );
    const expectedTailSequences = Array.from(
      { length: finalMetadata.chunkCount - snapshot.chunkCount },
      (_, index) => snapshot.chunkCount + index,
    );
    if (
      chunks.length !== expectedTailSequences.length ||
      chunks.some((row, index) => row.sequence !== expectedTailSequences[index])
    ) {
      return {
        eligible: false,
        reason: "session_mismatch",
        extraChunkCount: chunks.length,
        tailDurationMs: 0,
        tailRms: 0,
      };
    }
    extraChunkCount = chunks.length;
    tailBuffers = await Promise.all(
      chunks.map(async (row) => {
        const backend = row.storage_backend ?? session.chunk_storage_backend;
        if (backend === "r2" && row.object_key) {
          return readAudioSessionChunkObject(row.object_key);
        }
        return row.content_base64
          ? Buffer.from(row.content_base64, "base64")
          : Buffer.alloc(0);
      }),
    );
  } else {
    assemblySource = "local";
    const metadata = await readLocalMetadata(sessionId);
    sessionChunkCount = metadata.chunkCount;
    sessionTotalBytes = metadata.totalBytes;
    extraChunkCount = finalMetadata.chunkCount - snapshot.chunkCount;
    tailBuffers = await Promise.all(
      Array.from(
        { length: finalMetadata.chunkCount - snapshot.chunkCount },
        (_, index) =>
          readFile(
            path.join(
              getSessionDir(sessionId),
              chunkFileName(snapshot.chunkCount + index),
            ),
          ),
      ),
    );
  }

  if (
    sessionChunkCount !== finalMetadata.chunkCount ||
    sessionTotalBytes !== finalMetadata.pcmByteLength
  ) {
    return {
      eligible: false,
      reason: "session_mismatch",
      extraChunkCount: Math.max(0, sessionChunkCount - snapshot.chunkCount),
      tailDurationMs: 0,
      tailRms: 0,
      assemblySource,
    };
  }
  const tail = Buffer.concat(tailBuffers);
  const expectedTailBytes =
    finalMetadata.pcmByteLength - snapshot.pcmByteLength;
  if (tail.byteLength !== expectedTailBytes) {
    return {
      eligible: false,
      reason: "session_mismatch",
      extraChunkCount,
      tailDurationMs: 0,
      tailRms: 0,
      assemblySource,
    };
  }
  const bytesPerSecond =
    finalMetadata.sampleRate * finalMetadata.channelCount * 2;
  const tailDurationMs = Math.round((tail.byteLength / bytesPerSecond) * 1_000);
  if (tailDurationMs > 1_600) {
    return {
      eligible: false,
      reason: "tail_too_long",
      extraChunkCount,
      tailDurationMs,
      tailRms: 0,
      assemblySource,
    };
  }
  if (tail.byteLength === 0) {
    return {
      eligible: true,
      reason: "tail_silent",
      extraChunkCount: 0,
      tailDurationMs: 0,
      tailRms: 0,
      assemblySource,
    };
  }
  const analysis = analyzePcm16Silence(
    tail,
    noiseRms,
    finalMetadata.sampleRate,
    finalMetadata.channelCount,
  );
  return {
    eligible: analysis.silent,
    reason: analysis.silent ? "tail_silent" : "tail_contains_speech",
    extraChunkCount,
    tailDurationMs,
    tailRms: analysis.rms,
    activeFrameRatio: analysis.activeFrameRatio,
    longestSpeechRunMs: analysis.longestSpeechRunMs,
    noiseFloorRms: analysis.noiseFloorRms,
    speechThresholdRms: analysis.speechThresholdRms,
    assemblySource,
  };
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
    const rows = await queryDatabase<{
      state:
        | "not_found"
        | "expired"
        | "conflict"
        | "completed"
        | "in_progress"
        | "claimed";
      result: unknown;
    }>(
      `WITH current AS MATERIALIZED (
         SELECT status, expires_at, finalize_lease_until,
                request_hash, result
           FROM audio_upload_sessions
          WHERE session_id = $1
       ), claimed AS (
         UPDATE audio_upload_sessions
            SET status = 'finalizing', request_hash = $2,
                finalize_lease_until = $3::timestamptz, updated_at = NOW()
          WHERE session_id = $1
            AND expires_at > NOW()
            AND status <> 'finalized'
            AND (status = 'uploading' OR finalize_lease_until <= NOW())
         RETURNING session_id
       )
       SELECT CASE
                WHEN NOT EXISTS (SELECT 1 FROM current)
                  THEN 'not_found'
                WHEN (SELECT expires_at FROM current) <= NOW()
                  THEN 'expired'
                WHEN (SELECT status FROM current) = 'finalized'
                  AND (SELECT request_hash FROM current) IS DISTINCT FROM $2
                  THEN 'conflict'
                WHEN (SELECT status FROM current) = 'finalized'
                  THEN 'completed'
                WHEN (SELECT status FROM current) = 'finalizing'
                  AND (SELECT finalize_lease_until FROM current) > NOW()
                  AND (SELECT request_hash FROM current) IS NOT NULL
                  AND (SELECT request_hash FROM current) IS DISTINCT FROM $2
                  THEN 'conflict'
                WHEN (SELECT status FROM current) = 'finalizing'
                  AND (SELECT finalize_lease_until FROM current) > NOW()
                  THEN 'in_progress'
                WHEN EXISTS (SELECT 1 FROM claimed)
                  THEN 'claimed'
                ELSE 'in_progress'
              END AS state,
              (SELECT result FROM current) AS result`,
      [sessionId, requestHash, leaseUntil.toISOString()],
    );
    const claim = rows[0];

    if (!claim || claim.state === "not_found") {
      throw new AudioUploadError(
        "SESSION_NOT_FOUND",
        "Audio session không tồn tại.",
        404,
      );
    }
    if (claim.state === "expired") {
      throw new AudioUploadError(
        "SESSION_EXPIRED",
        "Audio session đã hết hạn. Vui lòng ghi âm lại.",
        410,
      );
    }
    if (claim.state === "conflict") {
      throw new AudioUploadError(
        "IDEMPOTENCY_CONFLICT",
        "Finalize đang chạy hoặc đã hoàn tất với nội dung yêu cầu khác.",
        409,
      );
    }
    if (claim.state === "completed") {
      return { state: "completed", result: claim.result };
    }
    return claim.state === "claimed"
      ? { state: "claimed" }
      : { state: "in_progress" };
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
    const rows = await queryDatabase<{
      finalized_count: number | string;
      deleted_chunks: Array<{
        objectKey: string | null;
        storageBackend: AudioSessionChunkStorageBackend;
      }>;
    }>(
      `WITH finalized AS (
         UPDATE audio_upload_sessions
            SET status = 'finalized', result = $3::jsonb,
                expires_at = $4::timestamptz, finalize_lease_until = NULL,
                updated_at = NOW()
         WHERE session_id = $1 AND request_hash = $2
         RETURNING session_id
       )
       SELECT (SELECT COUNT(*) FROM finalized)::integer AS finalized_count,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'objectKey', chunks.object_key,
                    'storageBackend', chunks.storage_backend
                  )
                ) FILTER (WHERE chunks.session_id IS NOT NULL),
                '[]'::jsonb
              ) AS deleted_chunks
         FROM finalized
         LEFT JOIN audio_upload_chunks AS chunks
           ON chunks.session_id = finalized.session_id`,
      [sessionId, requestHash, JSON.stringify(result), expiresAt],
    );

    const completion = rows[0];
    if (!completion || Number(completion.finalized_count) === 0) {
      throw new AudioUploadError(
        "IDEMPOTENCY_CONFLICT",
        "Không thể lưu kết quả finalize vì khóa yêu cầu không khớp.",
        409,
      );
    }
    deleteHotAudioSession(sessionId);
    await deleteAudioSessionChunkObjects(
      completion.deleted_chunks
        .filter((chunk) => chunk.storageBackend === "r2")
        .map((chunk) => chunk.objectKey ?? ""),
    );
    await queryDatabase(
      `DELETE FROM audio_upload_chunks
        WHERE session_id = $1`,
      [sessionId],
    );
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
    const rows = await queryDatabase<{
      deleted_chunks: Array<{
        objectKey: string | null;
        storageBackend: AudioSessionChunkStorageBackend;
      }>;
    }>(
      `WITH deleted_chunks AS (
         DELETE FROM audio_upload_chunks
          WHERE session_id = $1
         RETURNING object_key, storage_backend
       ), deleted_session AS (
         DELETE FROM audio_upload_sessions
          WHERE session_id = $1
            AND (SELECT COUNT(*) FROM deleted_chunks) >= 0
         RETURNING session_id
       )
       SELECT COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'objectKey', object_key,
                    'storageBackend', storage_backend
                  )
                ),
                '[]'::jsonb
              ) AS deleted_chunks
         FROM deleted_chunks`,
      [sessionId],
    );
    await deleteAudioSessionChunkObjects(
      (rows[0]?.deleted_chunks ?? [])
        .filter((chunk) => chunk.storageBackend === "r2")
        .map((chunk) => chunk.objectKey ?? ""),
    );
    deleteHotAudioSession(sessionId);
    return;
  }

  await enqueueLocalMutation(() =>
    rm(getSessionDir(sessionId), { recursive: true, force: true }),
  );
}
