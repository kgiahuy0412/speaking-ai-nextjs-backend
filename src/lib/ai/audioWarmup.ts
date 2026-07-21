import { createHash } from "node:crypto";
import type { PracticeContext } from "@/types/conversation";
import { nowMs } from "@/lib/latency";
import { getRuleAudioTexts } from "./phraseRules";
import { getPromotedRuleAudioTexts } from "./promotedRules";
import { getSemanticIntentAudioTexts } from "./semanticIntents";
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
  items: AudioWarmupItem[];
};

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
) {
  const targetContexts = context === "all" ? contexts : [context];
  const textGroups = await Promise.all(
    targetContexts.map(async (targetContext) => [
      ...getRuleAudioTexts(targetContext),
      ...getSemanticIntentAudioTexts(targetContext),
      ...(await getPromotedRuleAudioTexts(targetContext, clientId)),
    ]),
  );

  return [...new Set(textGroups.flat().map((text) => text.trim()))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
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
) {
  const texts = await getWarmupTexts(context, clientId);
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
) {
  return warmAudioCache(context, clientId);
}

export function warmAllRuleAudioCaches(clientId?: string) {
  return warmAudioCache("all", clientId);
}
