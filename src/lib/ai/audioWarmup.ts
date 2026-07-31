import { createHash } from "node:crypto";
import type { PracticeContext } from "@/types/conversation";
import { nowMs } from "@/lib/latency";
import { getPromotedRuleAudioTexts } from "./promotedRules";
import { getReviewedExactRuleAudioTexts } from "./exactRules";
import {
  getEnglishAudioCacheUrl,
  getTtsProfile,
  synthesizeEnglishAudio,
} from "./tts";

const contexts: PracticeContext[] = ["home", "school", "outside"];
const inFlightWarmups = new Map<string, Promise<AudioWarmupResult>>();
const completedWarmups = new Map<
  PracticeContext | "all",
  {
    fingerprint: string;
    completedAt: number;
    result: AudioWarmupResult;
  }
>();

export type AudioWarmupItem = {
  englishText: string;
  audioUrl: string | null;
  status: "cached" | "generated" | "failed";
  latencyMs: number;
  errorMessage?: string;
};

export type AudioWarmupResult = {
  context: PracticeContext | "all";
  total: number;
  cached: number;
  generated: number;
  failed: number;
  latencyMs: number;
  reused: boolean;
  fingerprint: string;
  cacheHitRate: number;
  items: AudioWarmupItem[];
};

export type AudioWarmupOptions = {
  limit?: number;
};

const maximumAutomaticWarmupRules = 300;

export function getAudioWarmupRuleLimit(requestedLimit?: number) {
  const configured = Number(process.env.AUDIO_WARMUP_RULE_LIMIT ?? 200);
  const fallback = Number.isFinite(configured) ? configured : 200;
  const candidate = requestedLimit ?? fallback;
  return Math.min(
    maximumAutomaticWarmupRules,
    Math.max(1, Math.round(candidate)),
  );
}

function getWarmupConcurrency() {
  const configured = Number(process.env.AUDIO_WARMUP_CONCURRENCY ?? 2);

  if (!Number.isFinite(configured)) {
    return 2;
  }

  return Math.min(4, Math.max(1, Math.round(configured)));
}

function getWarmupSnapshotTtlMs() {
  const configured = Number(process.env.AUDIO_WARMUP_SNAPSHOT_TTL_MS ?? 300_000);

  return Number.isFinite(configured) && configured >= 0
    ? configured
    : 300_000;
}

async function getWarmupTexts(
  context: PracticeContext | "all",
  clientId?: string,
  requestedLimit?: number,
) {
  const targetContexts = context === "all" ? contexts : [context];
  const promotedTextGroups = await Promise.all(
    targetContexts.map((targetContext) =>
      getPromotedRuleAudioTexts(targetContext, clientId),
    ),
  );
  const limit = getAudioWarmupRuleLimit(requestedLimit);

  // Preserve reviewed order: hand-reviewed rules first, followed by the
  // official corpus order, then device-specific promoted rules.
  return [
    ...new Set(
      [...getReviewedExactRuleAudioTexts(), ...promotedTextGroups.flat()]
        .map((text) => text.trim())
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function getWarmupFingerprint(texts: string[]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        texts,
        ...getTtsProfile(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function reuseCompletedWarmup(
  context: PracticeContext | "all",
  fingerprint: string,
) {
  const completed = completedWarmups.get(context);

  if (
    !completed ||
    completed.fingerprint !== fingerprint ||
    Date.now() - completed.completedAt > getWarmupSnapshotTtlMs()
  ) {
    return null;
  }

  return {
    ...completed.result,
    cached: completed.result.total,
    generated: 0,
    failed: 0,
    latencyMs: 0,
    reused: true,
    cacheHitRate: 1,
    items: completed.result.items.map((item) => ({
      ...item,
      status: "cached" as const,
      latencyMs: 0,
      errorMessage: undefined,
    })),
  } satisfies AudioWarmupResult;
}

async function warmAudioTexts(
  context: PracticeContext | "all",
  texts: string[],
  fingerprint: string,
): Promise<AudioWarmupResult> {
  const startedAt = nowMs();
  const items = new Array<AudioWarmupItem>(texts.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < texts.length) {
      const index = nextIndex;
      nextIndex += 1;
      const englishText = texts[index];
      const itemStartedAt = nowMs();
      const existingUrl = await getEnglishAudioCacheUrl(englishText);

      if (existingUrl) {
        items[index] = {
          englishText,
          audioUrl: existingUrl,
          status: "cached",
          latencyMs: Math.round(nowMs() - itemStartedAt),
        };
        continue;
      }

      try {
        const audioUrl = await synthesizeEnglishAudio(englishText);

        items[index] = {
          englishText,
          audioUrl: audioUrl.audioUrl,
          status: audioUrl.source === "cache" ? "cached" : "generated",
          latencyMs: Math.round(nowMs() - itemStartedAt),
        };
      } catch (error) {
        items[index] = {
          englishText,
          audioUrl: null,
          status: "failed",
          latencyMs: Math.round(nowMs() - itemStartedAt),
          errorMessage:
            error instanceof Error ? error.message : "Không tạo được audio.",
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(getWarmupConcurrency(), Math.max(1, texts.length)) },
      () => worker(),
    ),
  );

  const result = {
    context,
    total: items.length,
    cached: items.filter((item) => item.status === "cached").length,
    generated: items.filter((item) => item.status === "generated").length,
    failed: items.filter((item) => item.status === "failed").length,
    latencyMs: Math.round(nowMs() - startedAt),
    reused: false,
    fingerprint,
    cacheHitRate:
      items.length === 0
        ? 1
        : items.filter((item) => item.status === "cached").length / items.length,
    items,
  } satisfies AudioWarmupResult;

  if (result.failed === 0) {
    completedWarmups.set(context, {
      fingerprint,
      completedAt: Date.now(),
      result,
    });
  }

  return result;
}

async function warmAudioCache(
  context: PracticeContext | "all",
  clientId?: string,
  options: AudioWarmupOptions = {},
) {
  const texts = await getWarmupTexts(context, clientId, options.limit);
  const fingerprint = getWarmupFingerprint(texts);
  const completed = reuseCompletedWarmup(context, fingerprint);

  if (completed) {
    return completed;
  }

  const jobKey = `${context}:${fingerprint}`;
  const activeJob = inFlightWarmups.get(jobKey);

  if (activeJob) {
    return activeJob;
  }

  const job = warmAudioTexts(context, texts, fingerprint);
  inFlightWarmups.set(jobKey, job);

  try {
    return await job;
  } finally {
    inFlightWarmups.delete(jobKey);
  }
}

export function warmRuleAudioCache(
  context: PracticeContext,
  clientId?: string,
  options?: AudioWarmupOptions,
) {
  return warmAudioCache(context, clientId, options);
}

export function warmAllRuleAudioCaches(
  clientId?: string,
  options?: AudioWarmupOptions,
) {
  return warmAudioCache("all", clientId, options);
}
