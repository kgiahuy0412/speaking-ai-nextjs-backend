type HotAudioChunk = {
  sha256: string;
  bytes: Buffer;
};

type HotAudioSession = {
  expiresAt: number;
  updatedAt: number;
  totalBytes: number;
  chunks: Map<number, HotAudioChunk>;
};

type HotAudioCacheGlobalState = typeof globalThis & {
  __aiSpeakingAudioSessionHotCache?: Map<string, HotAudioSession>;
  __aiSpeakingAudioSessionHotCacheBytes?: number;
};

const state = globalThis as HotAudioCacheGlobalState;
const sessions = state.__aiSpeakingAudioSessionHotCache ??= new Map();
state.__aiSpeakingAudioSessionHotCacheBytes ??= 0;

const defaultMaxBytes = 64 * 1024 * 1024;
const maxSessionBytes = 16 * 1024 * 1024;

function getMaxBytes() {
  const configured = Number(process.env.AUDIO_SESSION_HOT_CACHE_MAX_BYTES);
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : defaultMaxBytes;
}

function removeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  state.__aiSpeakingAudioSessionHotCacheBytes = Math.max(
    0,
    (state.__aiSpeakingAudioSessionHotCacheBytes ?? 0) - session.totalBytes,
  );
  sessions.delete(sessionId);
  return true;
}

function touchSession(sessionId: string, session: HotAudioSession, now: number) {
  session.updatedAt = now;
  sessions.delete(sessionId);
  sessions.set(sessionId, session);
}

function enforceBudget() {
  const maxBytes = getMaxBytes();
  while (
    sessions.size > 0 &&
    (state.__aiSpeakingAudioSessionHotCacheBytes ?? 0) > maxBytes
  ) {
    const oldestSessionId = sessions.keys().next().value as string | undefined;
    if (!oldestSessionId) break;
    removeSession(oldestSessionId);
  }
}

export function pruneHotAudioSessions(now = Date.now()) {
  let deleted = 0;
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) {
      if (removeSession(sessionId)) deleted += 1;
    }
  }
  enforceBudget();
  return deleted;
}

export function rememberHotAudioChunk(input: {
  sessionId: string;
  sequence: number;
  sha256: string;
  bytes: Buffer;
  expiresAt: number;
}) {
  const maxBytes = getMaxBytes();
  if (
    maxBytes === 0 ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > maxSessionBytes ||
    input.expiresAt <= Date.now()
  ) {
    return false;
  }

  const now = Date.now();
  pruneHotAudioSessions(now);
  let session = sessions.get(input.sessionId);
  if (!session) {
    session = {
      expiresAt: input.expiresAt,
      updatedAt: now,
      totalBytes: 0,
      chunks: new Map(),
    };
    sessions.set(input.sessionId, session);
  }

  const existing = session.chunks.get(input.sequence);
  if (existing) {
    if (existing.sha256 !== input.sha256) {
      // The durable store remains authoritative. Drop the whole shadow entry
      // rather than risk combining chunks from conflicting upload attempts.
      removeSession(input.sessionId);
      return false;
    }
    session.expiresAt = Math.max(session.expiresAt, input.expiresAt);
    touchSession(input.sessionId, session, now);
    return true;
  }

  if (session.totalBytes + input.bytes.byteLength > maxSessionBytes) {
    removeSession(input.sessionId);
    return false;
  }

  const retainedBytes = Buffer.from(input.bytes);
  session.chunks.set(input.sequence, {
    sha256: input.sha256,
    bytes: retainedBytes,
  });
  session.totalBytes += retainedBytes.byteLength;
  session.expiresAt = Math.max(session.expiresAt, input.expiresAt);
  state.__aiSpeakingAudioSessionHotCacheBytes =
    (state.__aiSpeakingAudioSessionHotCacheBytes ?? 0) + retainedBytes.byteLength;
  touchSession(input.sessionId, session, now);
  enforceBudget();
  return sessions.has(input.sessionId);
}

function readPrefixBuffers(
  session: HotAudioSession,
  chunkCount: number,
): Buffer[] | null {
  const buffers: Buffer[] = [];
  for (let sequence = 0; sequence < chunkCount; sequence += 1) {
    const chunk = session.chunks.get(sequence);
    if (!chunk) return null;
    buffers.push(chunk.bytes);
  }
  return buffers;
}

export function readHotAudioPrefix(input: {
  sessionId: string;
  chunkCount: number;
  pcmByteLength: number;
  allowTrailingChunks?: boolean;
}) {
  const now = Date.now();
  pruneHotAudioSessions(now);
  const session = sessions.get(input.sessionId);
  if (!session) return null;

  const buffers = readPrefixBuffers(session, input.chunkCount);
  if (!buffers) return null;
  const prefixBytes = buffers.reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  if (prefixBytes !== input.pcmByteLength) return null;
  if (
    !input.allowTrailingChunks &&
    (session.chunks.size !== input.chunkCount ||
      session.totalBytes !== input.pcmByteLength)
  ) {
    return null;
  }

  touchSession(input.sessionId, session, now);
  return Buffer.concat(buffers, prefixBytes);
}

export function readHotAudioTail(input: {
  sessionId: string;
  snapshotChunkCount: number;
  snapshotPcmByteLength: number;
  finalChunkCount: number;
  finalPcmByteLength: number;
}) {
  const now = Date.now();
  pruneHotAudioSessions(now);
  const session = sessions.get(input.sessionId);
  if (
    !session ||
    session.chunks.size !== input.finalChunkCount ||
    session.totalBytes !== input.finalPcmByteLength
  ) {
    return null;
  }

  const allBuffers = readPrefixBuffers(session, input.finalChunkCount);
  if (!allBuffers) return null;
  const prefixBytes = allBuffers
    .slice(0, input.snapshotChunkCount)
    .reduce((total, buffer) => total + buffer.byteLength, 0);
  if (prefixBytes !== input.snapshotPcmByteLength) return null;

  const tailBuffers = allBuffers.slice(input.snapshotChunkCount);
  const tailByteLength =
    input.finalPcmByteLength - input.snapshotPcmByteLength;
  const actualTailBytes = tailBuffers.reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  if (actualTailBytes !== tailByteLength) return null;

  touchSession(input.sessionId, session, now);
  return {
    tail: Buffer.concat(tailBuffers, tailByteLength),
    extraChunkCount: tailBuffers.length,
  };
}

export function deleteHotAudioSession(sessionId: string) {
  return removeSession(sessionId);
}

export function getHotAudioCacheStatsForTesting() {
  return {
    sessionCount: sessions.size,
    totalBytes: state.__aiSpeakingAudioSessionHotCacheBytes ?? 0,
  };
}

export function resetHotAudioCacheForTesting() {
  sessions.clear();
  state.__aiSpeakingAudioSessionHotCacheBytes = 0;
}
