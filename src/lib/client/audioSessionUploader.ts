"use client";

type FetchLike = typeof fetch;

type AudioSessionCapabilities = {
  chunkChecksumSha256?: boolean;
  missingChunkRecovery?: boolean;
  scopedUploadToken?: boolean;
  uploadProtocolVersion?: number;
  chunkStorageBackend?: "local" | "postgres" | "r2";
};

type AudioSessionResponse = {
  audioSessionId: string;
  uploadToken?: string;
  capabilities?: AudioSessionCapabilities;
};

export type AudioSessionUploadStats = {
  audioSessionId: string;
  uploadedAudioBytes: number;
  transportChunkCount: number;
  maxConcurrentChunkUploads: number;
  sourceChunkIntervalMs: number;
  firstChunkAckMs?: number;
  chunkUploadP50Ms?: number;
  chunkUploadP95Ms?: number;
  chunkRetryCount: number;
  sessionCreateMs: number;
  uploadDrainAfterStopMs: number;
  batchUploadSessionMs: number;
  chunkChecksumSha256: boolean;
  missingChunkRecovery: boolean;
  uploadProtocolVersion: number;
  scopedUploadToken: boolean;
  retryStrategy: "single_retry_same_sequence";
  chunkStorageBackend?: "local" | "postgres" | "r2";
};

type BrowserAudioSessionUploaderOptions = {
  mimeType: string;
  requestedSampleRate: number;
  sourceChunkIntervalMs?: number;
  maxDurationMs?: number;
  maxConcurrentUploads?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
};

const defaultChunkIntervalMs = 500;
const defaultMaxConcurrentUploads = 2;

function delay(ms: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return Math.round(sorted[index]);
}

async function sha256Hex(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function getResponseError(response: Response) {
  const payload = await response.json().catch(() => null);
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return `Request failed with status ${response.status}`;
}

export function supportsProgressiveEncodedAudioUpload(mimeType: string) {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === "audio/webm" || normalized === "audio/ogg";
}

export class BrowserAudioSessionUploader {
  readonly sourceChunkIntervalMs: number;
  readonly maxConcurrentUploads: number;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly sessionPromise: Promise<AudioSessionResponse>;
  private readonly activeUploads = new Set<Promise<void>>();
  private uploadSchedule = Promise.resolve();
  private sequence = 0;
  private uploadedAudioBytes = 0;
  private retryCount = 0;
  private firstChunkAckMs: number | undefined;
  private uploadFailure: unknown;
  private readonly uploadLatencies: number[] = [];
  private sessionCreateMs = 0;

  constructor(options: BrowserAudioSessionUploaderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.sourceChunkIntervalMs =
      Math.max(50, options.sourceChunkIntervalMs ?? defaultChunkIntervalMs);
    this.maxConcurrentUploads = Math.max(
      1,
      options.maxConcurrentUploads ?? defaultMaxConcurrentUploads,
    );
    this.sessionPromise = this.createSession(options);
    // A session is created eagerly so the first audio chunk does not wait for
    // an extra round trip. Keep a handler attached until drain/discard awaits it.
    void this.sessionPromise.catch(() => undefined);
  }

  get queuedChunkCount() {
    return this.sequence;
  }

  private async createSession(options: BrowserAudioSessionUploaderOptions) {
    const startedAt = this.now();
    const response = await this.fetchImpl("/api/audio-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: 2,
        audio: {
          encoding: "encoded_audio",
          requestedSampleRate: options.requestedSampleRate,
          channelCount: 1,
          bitsPerSample: 16,
          sourceChunkDurationMs: this.sourceChunkIntervalMs,
          maxDurationMs: options.maxDurationMs ?? 45_000,
          mimeType: options.mimeType,
        },
      }),
    });
    this.sessionCreateMs = Math.round(this.now() - startedAt);
    if (!response.ok) {
      throw new Error(await getResponseError(response));
    }
    const session = (await response.json()) as AudioSessionResponse;
    if (!session.audioSessionId) {
      throw new Error("Backend không trả về audio session hợp lệ.");
    }
    return session;
  }

  enqueue(blob: Blob) {
    if (blob.size === 0) return;
    const sequence = this.sequence;
    this.sequence += 1;

    this.uploadSchedule = this.uploadSchedule
      .then(async () => {
        while (this.activeUploads.size >= this.maxConcurrentUploads) {
          await Promise.race(
            [...this.activeUploads].map((upload) =>
              upload.catch(() => undefined),
            ),
          );
        }
        if (this.uploadFailure) return;

        const upload = this.uploadWithRetry(sequence, blob).catch((error) => {
          this.uploadFailure ??= error;
          throw error;
        });
        this.activeUploads.add(upload);
        void upload.then(
          () => this.activeUploads.delete(upload),
          () => this.activeUploads.delete(upload),
        );
      })
      .catch((error) => {
        this.uploadFailure ??= error;
      });
  }

  private async uploadWithRetry(sequence: number, blob: Blob) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.uploadChunk(sequence, blob);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          this.retryCount += 1;
          await delay(80);
        }
      }
    }
    throw lastError;
  }

  private async uploadChunk(sequence: number, blob: Blob) {
    const session = await this.sessionPromise;
    const startedAt = this.now();
    const checksum = await sha256Hex(blob);
    const formData = new FormData();
    formData.append("sequence", String(sequence));
    formData.append("audio", blob, `chunk-${sequence}.part`);
    const headers: Record<string, string> = {
      "Idempotency-Key": `chunk:${session.audioSessionId}:${sequence}`,
      "X-Chunk-Sha256": checksum,
    };
    if (session.uploadToken) {
      headers.Authorization = `Bearer ${session.uploadToken}`;
    }
    const response = await this.fetchImpl(
      `/api/audio-sessions/${encodeURIComponent(session.audioSessionId)}/chunks`,
      { method: "POST", headers, body: formData },
    );
    if (!response.ok) {
      throw new Error(await getResponseError(response));
    }
    const latencyMs = this.now() - startedAt;
    this.uploadLatencies.push(latencyMs);
    this.uploadedAudioBytes += blob.size;
    this.firstChunkAckMs ??= Math.round(this.now() - this.startedAt);
  }

  async drain(stoppedAt: number): Promise<AudioSessionUploadStats> {
    await this.uploadSchedule;
    await Promise.allSettled([...this.activeUploads]);
    if (this.uploadFailure) throw this.uploadFailure;
    if (this.sequence === 0) {
      throw new Error("Audio session không có chunk để hoàn tất.");
    }
    const session = await this.sessionPromise;
    const capabilities = session.capabilities ?? {};
    return {
      audioSessionId: session.audioSessionId,
      uploadedAudioBytes: this.uploadedAudioBytes,
      transportChunkCount: this.sequence,
      maxConcurrentChunkUploads: this.maxConcurrentUploads,
      sourceChunkIntervalMs: this.sourceChunkIntervalMs,
      firstChunkAckMs: this.firstChunkAckMs,
      chunkUploadP50Ms: percentile(this.uploadLatencies, 0.5),
      chunkUploadP95Ms: percentile(this.uploadLatencies, 0.95),
      chunkRetryCount: this.retryCount,
      sessionCreateMs: this.sessionCreateMs,
      uploadDrainAfterStopMs: Math.max(0, Math.round(this.now() - stoppedAt)),
      batchUploadSessionMs: Math.round(this.now() - this.startedAt),
      chunkChecksumSha256: capabilities.chunkChecksumSha256 !== false,
      missingChunkRecovery: capabilities.missingChunkRecovery === true,
      uploadProtocolVersion: capabilities.uploadProtocolVersion ?? 1,
      scopedUploadToken: Boolean(session.uploadToken),
      retryStrategy: "single_retry_same_sequence",
      chunkStorageBackend: capabilities.chunkStorageBackend,
    };
  }

  async finalize(payload: Record<string, unknown>) {
    const session = await this.sessionPromise;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (session.uploadToken) {
      headers.Authorization = `Bearer ${session.uploadToken}`;
    }
    return this.fetchImpl(
      `/api/audio-sessions/${encodeURIComponent(session.audioSessionId)}/finalize`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
    );
  }

  async discard() {
    const session = await this.sessionPromise.catch(() => null);
    if (!session) return;
    const headers: Record<string, string> = {
      "X-Discard-Reason": "web_progressive_fallback",
    };
    if (session.uploadToken) {
      headers.Authorization = `Bearer ${session.uploadToken}`;
    }
    await this.fetchImpl(
      `/api/audio-sessions/${encodeURIComponent(session.audioSessionId)}/chunks`,
      { method: "DELETE", headers, keepalive: true },
    ).catch(() => undefined);
  }
}
