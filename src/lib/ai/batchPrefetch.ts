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
  audioUrl: string | null;
  audioSource: "cache" | "cloudflare_tts" | null;
  snapshot: BatchPrefetchPcmSnapshot;
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

type BatchPrefetchGlobalState = typeof globalThis & {
  __aiSpeakingBatchPrefetchCandidates?: Map<string, BatchPrefetchCandidate>;
  __aiSpeakingBatchPrefetchAttempts?: Map<string, BatchPrefetchAttempt>;
};

const state = globalThis as BatchPrefetchGlobalState;
const candidates = state.__aiSpeakingBatchPrefetchCandidates ??= new Map();
const attempts = state.__aiSpeakingBatchPrefetchAttempts ??= new Map();
const candidateTtlMs = 20_000;
const attemptTtlMs = 60_000;
const maxCandidates = 128;
const maxAttemptsPerSession = 5;
const minimumAttemptIntervalMs = 700;

function prune(now = Date.now()) {
  for (const [id, candidate] of candidates) {
    if (candidate.createdAt + candidateTtlMs <= now) {
      candidates.delete(id);
    }
  }
  for (const [sessionId, attempt] of attempts) {
    if (attempt.expiresAt <= now) {
      attempts.delete(sessionId);
    }
  }
  while (candidates.size > maxCandidates) {
    const oldest = candidates.keys().next().value;
    if (oldest === undefined) break;
    candidates.delete(oldest);
  }
}

export function reserveBatchPrefetchAttempt(audioSessionId: string) {
  const now = Date.now();
  prune(now);
  const current = attempts.get(audioSessionId);
  if (
    current &&
    (current.count >= maxAttemptsPerSession ||
      now - current.lastStartedAt < minimumAttemptIntervalMs)
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

export function removeBatchPrefetchCandidate(id: string | undefined) {
  if (id) candidates.delete(id);
}
