import type { EnglishGenerationResult } from "./llm";
import { normalizeVietnameseForExactMatch } from "./exactRules";
import type { PracticeContext } from "@/types/conversation";

export type BatchPrefetchPcmSnapshot = {
  sampleRate: number;
  channelCount: number;
  bitsPerSample: 16;
  pcmByteLength: number;
  chunkCount: number;
};

export type BatchPrefetchCandidate = {
  id: string;
  audioSessionId: string;
  context: PracticeContext;
  childAge: number;
  sourceText: string;
  translation: EnglishGenerationResult;
  audioUrl: string;
  audioSource: "cache" | "cloudflare_tts";
  snapshot: BatchPrefetchPcmSnapshot;
  terminalSnapshot: boolean;
  /** Transcript/pipeline was prepared by the Web-only Worker pilot. */
  workerPilot?: boolean;
  stabilityCount: number;
  createdAt: number;
  previewLatencyMs: number;
  asrLatencyMs: number;
};

type BatchPrefetchAttempt = {
  count: number;
  lastStartedAt: number;
  expiresAt: number;
};

type BatchPrefetchInFlight = {
  token: string;
  startedAt: number;
  expiresAt: number;
  settled: boolean;
  promise: Promise<BatchPrefetchCandidate | null>;
  resolve: (candidate: BatchPrefetchCandidate | null) => void;
};

type BatchPrefetchCandidateWaiter = {
  token: string;
  excludedIds: Set<string>;
  settled: boolean;
  expiresAt: number;
  resolve: (update: BatchPrefetchCandidateUpdate | null) => void;
};

export type BatchPrefetchCandidateUpdate = {
  candidate: BatchPrefetchCandidate;
  state: "latest" | "joined";
};

export type BatchPrefetchWaitResult = {
  candidate: BatchPrefetchCandidate | null;
  state: "latest" | "joined" | "none" | "timeout";
  waitedMs: number;
};

type BatchPrefetchGlobalState = typeof globalThis & {
  __aiSpeakingBatchPrefetchCandidates?: Map<string, BatchPrefetchCandidate>;
  __aiSpeakingBatchPrefetchAttempts?: Map<string, BatchPrefetchAttempt>;
  __aiSpeakingBatchPrefetchLatestBySession?: Map<string, string>;
  __aiSpeakingBatchPrefetchInFlight?: Map<string, BatchPrefetchInFlight>;
  __aiSpeakingBatchPrefetchCandidateWaiters?: Map<
    string,
    Set<BatchPrefetchCandidateWaiter>
  >;
};

const state = globalThis as BatchPrefetchGlobalState;
const candidates = state.__aiSpeakingBatchPrefetchCandidates ??= new Map();
const attempts = state.__aiSpeakingBatchPrefetchAttempts ??= new Map();
const latestCandidateBySession =
  state.__aiSpeakingBatchPrefetchLatestBySession ??= new Map();
const inFlight = state.__aiSpeakingBatchPrefetchInFlight ??= new Map();
const candidateWaiters =
  state.__aiSpeakingBatchPrefetchCandidateWaiters ??= new Map();
const candidateTtlMs = 20_000;
const attemptTtlMs = 60_000;
const inFlightTtlMs = 35_000;
const maxCandidates = 128;
const maxAttemptsPerSession = 5;
const minimumAttemptIntervalMs = 700;

function prune(now = Date.now()) {
  for (const [id, candidate] of candidates) {
    if (candidate.createdAt + candidateTtlMs <= now) {
      candidates.delete(id);
      if (latestCandidateBySession.get(candidate.audioSessionId) === id) {
        latestCandidateBySession.delete(candidate.audioSessionId);
      }
    }
  }
  for (const [sessionId, attempt] of attempts) {
    if (attempt.expiresAt <= now) {
      attempts.delete(sessionId);
    }
  }
  for (const [sessionId, operation] of inFlight) {
    if (operation.expiresAt <= now) {
      operation.settled = true;
      operation.resolve(null);
      inFlight.delete(sessionId);
    }
  }
  for (const [sessionId, waiters] of candidateWaiters) {
    for (const waiter of waiters) {
      if (waiter.expiresAt <= now) {
        waiter.settled = true;
        waiter.resolve(null);
        waiters.delete(waiter);
      }
    }
    if (waiters.size === 0) candidateWaiters.delete(sessionId);
  }
  while (candidates.size > maxCandidates) {
    const oldest = candidates.keys().next().value;
    if (oldest === undefined) break;
    const candidate = candidates.get(oldest);
    candidates.delete(oldest);
    if (
      candidate &&
      latestCandidateBySession.get(candidate.audioSessionId) === oldest
    ) {
      latestCandidateBySession.delete(candidate.audioSessionId);
    }
  }
}

/**
 * Registers work already owned and awaited by the preview route. This is only
 * an in-process fast path: finalize falls back immediately when it lands on a
 * different instance or no preview is running.
 */
export function beginBatchPrefetchOperation(audioSessionId: string) {
  const now = Date.now();
  prune(now);
  const token = crypto.randomUUID();
  let resolve!: (candidate: BatchPrefetchCandidate | null) => void;
  const promise = new Promise<BatchPrefetchCandidate | null>((settle) => {
    resolve = settle;
  });
  const operation: BatchPrefetchInFlight = {
    token,
    startedAt: now,
    expiresAt: now + inFlightTtlMs,
    settled: false,
    promise,
    resolve,
  };
  inFlight.set(audioSessionId, operation);

  return {
    token,
    finish(candidate: BatchPrefetchCandidate | null = null) {
      if (operation.settled) return;
      operation.settled = true;
      operation.resolve(candidate);
      if (inFlight.get(audioSessionId)?.token === token) {
        inFlight.delete(audioSessionId);
      }
    },
  };
}

export function reserveBatchPrefetchAttempt(
  audioSessionId: string,
  terminal = false,
) {
  const now = Date.now();
  prune(now);
  const current = attempts.get(audioSessionId);
  if (
    current &&
    (current.count >= maxAttemptsPerSession ||
      (!terminal && now - current.lastStartedAt < minimumAttemptIntervalMs))
  ) {
    return false;
  }
  attempts.set(audioSessionId, {
    count: (current?.count ?? 0) + 1,
    lastStartedAt: now,
    expiresAt: now + attemptTtlMs,
  });
  return true;
}

export function saveBatchPrefetchCandidate(input: Omit<
  BatchPrefetchCandidate,
  "id" | "createdAt" | "stabilityCount"
> & { previousPrefetchId?: string }) {
  const now = Date.now();
  prune(now);
  const { previousPrefetchId, ...candidateInput } = input;
  const previous = previousPrefetchId
    ? candidates.get(previousPrefetchId)
    : undefined;
  const stableWithPrevious = Boolean(
    previous &&
      previous.audioSessionId === input.audioSessionId &&
      previous.context === input.context &&
      previous.childAge === input.childAge &&
      previous.snapshot.chunkCount < candidateInput.snapshot.chunkCount &&
      previous.snapshot.pcmByteLength <
        candidateInput.snapshot.pcmByteLength &&
      previous.translation.source === candidateInput.translation.source &&
      previous.translation.englishText ===
        candidateInput.translation.englishText &&
      normalizeVietnameseForExactMatch(previous.sourceText) ===
        normalizeVietnameseForExactMatch(candidateInput.sourceText),
  );
  const candidate: BatchPrefetchCandidate = {
    ...candidateInput,
    id: crypto.randomUUID(),
    createdAt: now,
    stabilityCount: stableWithPrevious
      ? Math.min(3, (previous?.stabilityCount ?? 1) + 1)
      : 1,
  };
  candidates.set(candidate.id, candidate);
  latestCandidateBySession.set(candidate.audioSessionId, candidate.id);
  const waiters = candidateWaiters.get(candidate.audioSessionId);
  if (waiters) {
    for (const waiter of waiters) {
      if (!waiter.settled && !waiter.excludedIds.has(candidate.id)) {
        waiter.settled = true;
        waiter.resolve({ candidate, state: "joined" });
        waiters.delete(waiter);
      }
    }
    if (waiters.size === 0) {
      candidateWaiters.delete(candidate.audioSessionId);
    }
  }
  prune(now);
  return candidate;
}

export function getBatchPrefetchCandidate(
  id: string | undefined,
  audioSessionId: string,
) {
  if (!id) return null;
  prune();
  const candidate = candidates.get(id);
  return candidate?.audioSessionId === audioSessionId ? candidate : null;
}

export function getLatestBatchPrefetchCandidate(audioSessionId: string) {
  prune();
  const id = latestCandidateBySession.get(audioSessionId);
  if (!id) return null;
  const candidate = candidates.get(id);
  if (!candidate || candidate.audioSessionId !== audioSessionId) {
    latestCandidateBySession.delete(audioSessionId);
    return null;
  }
  return candidate;
}

/**
 * Waits for the next candidate without imposing a latency timeout. The caller
 * owns cancellation, normally when authoritative ASR or the main pipeline
 * wins the race. This also observes terminal previews that are registered
 * after an older preview finishes.
 */
export function waitForNextBatchPrefetchCandidate(
  audioSessionId: string,
  excludedCandidateIds: Iterable<string> = [],
) {
  const excludedIds = new Set(excludedCandidateIds);
  const latest = getLatestBatchPrefetchCandidate(audioSessionId);
  if (latest && !excludedIds.has(latest.id)) {
    return {
      promise: Promise.resolve<BatchPrefetchCandidateUpdate | null>({
        candidate: latest,
        state: "latest",
      }),
      cancel() {},
    };
  }

  const token = crypto.randomUUID();
  let resolve!: (update: BatchPrefetchCandidateUpdate | null) => void;
  const promise = new Promise<BatchPrefetchCandidateUpdate | null>((settle) => {
    resolve = settle;
  });
  const waiter: BatchPrefetchCandidateWaiter = {
    token,
    excludedIds,
    settled: false,
    expiresAt: Date.now() + inFlightTtlMs,
    resolve,
  };
  const waiters = candidateWaiters.get(audioSessionId) ?? new Set();
  waiters.add(waiter);
  candidateWaiters.set(audioSessionId, waiters);

  return {
    promise,
    cancel() {
      if (waiter.settled) return;
      waiter.settled = true;
      waiter.resolve(null);
      const current = candidateWaiters.get(audioSessionId);
      current?.delete(waiter);
      if (current?.size === 0) candidateWaiters.delete(audioSessionId);
    },
  };
}

export async function waitForBatchPrefetchCandidate(
  audioSessionId: string,
  timeoutMs: number,
  excludeCandidateId?: string,
): Promise<BatchPrefetchWaitResult> {
  const startedAt = performance.now();
  const latest = getLatestBatchPrefetchCandidate(audioSessionId);
  if (latest && latest.id !== excludeCandidateId) {
    return { candidate: latest, state: "latest", waitedMs: 0 };
  }

  const operation = inFlight.get(audioSessionId);
  if (!operation || timeoutMs <= 0) {
    return { candidate: null, state: "none", waitedMs: 0 };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("batch-prefetch-timeout");
  const outcome = await Promise.race([
    operation.promise,
    new Promise<typeof timedOut>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(timedOut), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  const waitedMs = Math.round(performance.now() - startedAt);
  if (outcome === timedOut) {
    return { candidate: null, state: "timeout", waitedMs };
  }

  const candidate =
    outcome && outcome.id !== excludeCandidateId
      ? outcome
      : getLatestBatchPrefetchCandidate(audioSessionId);
  return {
    candidate:
      candidate && candidate.id !== excludeCandidateId ? candidate : null,
    state: "joined",
    waitedMs,
  };
}

export function removeBatchPrefetchCandidate(id: string | undefined) {
  if (!id) return;
  const candidate = candidates.get(id);
  candidates.delete(id);
  if (
    candidate &&
    latestCandidateBySession.get(candidate.audioSessionId) === id
  ) {
    latestCandidateBySession.delete(candidate.audioSessionId);
  }
}

export function resetBatchPrefetchForTesting() {
  for (const operation of inFlight.values()) {
    if (!operation.settled) {
      operation.settled = true;
      operation.resolve(null);
    }
  }
  for (const waiters of candidateWaiters.values()) {
    for (const waiter of waiters) {
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.resolve(null);
      }
    }
  }
  candidates.clear();
  attempts.clear();
  latestCandidateBySession.clear();
  inFlight.clear();
  candidateWaiters.clear();
}
