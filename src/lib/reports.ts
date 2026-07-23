import type {
  AsrMode,
  AudioSource,
  ConversationHistoryEntry,
  LatencyReport,
  PracticeContext,
  ProcessingMode,
  TextSource,
} from "@/types/conversation";

const contexts: PracticeContext[] = ["home", "school", "outside"];
const modes: Array<ProcessingMode | "old"> = ["rule", "ai", "fallback", "old"];
const textSources: Array<TextSource | "old"> = [
  "phrase_rule",
  "keyword_rule",
  "promoted_rule",
  "semantic_cache",
  "text_cache",
  "cloudflare",
  "openai",
  "fallback",
  "old",
];
const audioSources: Array<AudioSource | "old"> = [
  "cache",
  "openai_tts",
  "old",
];
const asrModes: Array<AsrMode | "old"> = [
  "text",
  "batch_chunks",
  "browser_streaming",
  "android_streaming",
  "openai_realtime",
  "ble_offline_intent",
  "old",
];
const minimumAsrBenchmarkSamples = 10;
const minimumLatencyAlertSamples = 10;
const fastPathTextSources = new Set<TextSource | "old">([
  "phrase_rule",
  "keyword_rule",
  "promoted_rule",
  "semantic_cache",
  "text_cache",
]);

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return Math.round(
    values.reduce((total, value) => total + value, 0) / values.length,
  );
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1),
  );

  return sortedValues[index];
}

function buildLatencyStats(items: ConversationHistoryEntry[]) {
  const values = items.map((entry) => entry.latency.timeToFirstAudioMs);

  return {
    count: items.length,
    averageFirstAudioMs: average(values),
    p50FirstAudioMs: percentile(values, 50),
    p95FirstAudioMs: percentile(values, 95),
  };
}

function rate(count: number, total: number) {
  if (total === 0) {
    return 0;
  }

  return Math.round((count / total) * 100);
}

function getProcessingMode(entry: ConversationHistoryEntry) {
  return (
    (entry as Partial<ConversationHistoryEntry>).processingMode ?? "old"
  ) as ProcessingMode | "old";
}

function getTextSource(entry: ConversationHistoryEntry) {
  const input = entry as Partial<ConversationHistoryEntry>;

  if (input.textSource) {
    return input.textSource as TextSource | "old";
  }

  if (entry.matchedRule?.startsWith("keyword:")) {
    return "keyword_rule";
  }

  if (input.processingMode === "rule") {
    return "phrase_rule";
  }

  if (input.processingMode === "ai") {
    return "openai";
  }

  if (input.processingMode === "fallback") {
    return "fallback";
  }

  return "old";
}

function getAudioSource(entry: ConversationHistoryEntry) {
  const input = entry as Partial<ConversationHistoryEntry>;

  return (input.audioSource ?? "old") as AudioSource | "old";
}

function getAsrMode(entry: ConversationHistoryEntry) {
  return (
    (entry as Partial<ConversationHistoryEntry>).asrMode ?? "old"
  ) as AsrMode | "old";
}

function buildAsrModeStats(
  mode: AsrMode | "old",
  conversations: ConversationHistoryEntry[],
) {
  const items = conversations.filter((entry) => getAsrMode(entry) === mode);
  const reviewedItems = items.filter(
    (entry) => typeof entry.qualityApproved === "boolean",
  );
  const firstDeltas = items
    .map(
      (entry) =>
        entry.latency.asrFirstDeltaMs ??
        entry.benchmark?.asrFirstDeltaMs,
    )
    .filter((value): value is number => typeof value === "number");
  const finalAfterStop = items
    .map(
      (entry) =>
        entry.latency.asrFinalAfterStopMs ??
        entry.benchmark?.asrFinalAfterStopMs,
    )
    .filter((value): value is number => typeof value === "number");

  return {
    source: mode,
    ...buildLatencyStats(items),
    reviewed: reviewedItems.length,
    qualityApprovedRate: rate(
      reviewedItems.filter((entry) => entry.qualityApproved).length,
      reviewedItems.length,
    ),
    p50AsrFirstDeltaMs: percentile(firstDeltas, 50),
    p95AsrFirstDeltaMs: percentile(firstDeltas, 95),
    p50AsrFinalAfterStopMs: percentile(finalAfterStop, 50),
    p95AsrFinalAfterStopMs: percentile(finalAfterStop, 95),
  };
}

function getMeasuredFirstAudio(entry: ConversationHistoryEntry) {
  const measured =
    entry.latency.audioStartedAfterStopMs ??
    entry.latency.browserAudioStartedMs ??
    entry.latency.timeToFirstAudioMs;

  return measured >= 20 ? measured : null;
}

function getLatencyP95ThresholdMs() {
  const configured = Number(process.env.LATENCY_P95_ALERT_MS ?? 2500);
  return Number.isFinite(configured) && configured >= 500
    ? Math.round(configured)
    : 2500;
}

function buildFastPathAsrStats(
  mode: Extract<AsrMode, "batch_chunks" | "browser_streaming">,
  conversations: ConversationHistoryEntry[],
) {
  const items = conversations.filter(
    (entry) =>
      getAsrMode(entry) === mode &&
      fastPathTextSources.has(getTextSource(entry)) &&
      getAudioSource(entry) === "cache" &&
      getMeasuredFirstAudio(entry) !== null,
  );
  const reviewed = items.filter(
    (entry) => typeof entry.qualityApproved === "boolean",
  );
  const latencyValues = items
    .map(getMeasuredFirstAudio)
    .filter((value): value is number => value !== null);

  return {
    count: items.length,
    reviewed: reviewed.length,
    qualityApprovedRate: rate(
      reviewed.filter((entry) => entry.qualityApproved).length,
      reviewed.length,
    ),
    p95FirstAudioMs: percentile(latencyValues, 95),
  };
}

function buildStreamingAsrDecision(
  conversations: ConversationHistoryEntry[],
) {
  const batch = buildFastPathAsrStats("batch_chunks", conversations);
  const streaming = buildFastPathAsrStats(
    "browser_streaming",
    conversations,
  );

  if (batch.count === 0 || streaming.count === 0) {
    return {
      recommended: false,
      reason:
        "Cần đủ hai nhóm Batch và Streaming trên câu rule/cache để so sánh.",
      minimumSamplesPerMode: minimumAsrBenchmarkSamples,
      p95ImprovementRate: 0,
    };
  }

  const enoughLatencySamples =
    batch.count >= minimumAsrBenchmarkSamples &&
    streaming.count >= minimumAsrBenchmarkSamples;
  const enoughQualityReviews =
    batch.reviewed >= minimumAsrBenchmarkSamples &&
    streaming.reviewed >= minimumAsrBenchmarkSamples;
  const p95ImprovementRate =
    batch.p95FirstAudioMs > 0
      ? Math.round(
          ((batch.p95FirstAudioMs - streaming.p95FirstAudioMs) /
            batch.p95FirstAudioMs) *
            100,
        )
      : 0;
  const qualityIsAcceptable =
    streaming.qualityApprovedRate >= batch.qualityApprovedRate - 5;
  const recommended =
    enoughLatencySamples &&
    enoughQualityReviews &&
    p95ImprovementRate >= 20 &&
    qualityIsAcceptable;

  let reason =
    "Streaming fast path chưa đạt ngưỡng giảm P95 20% và chất lượng không kém quá 5 điểm.";

  if (!enoughLatencySamples) {
    reason = `Cần ít nhất ${minimumAsrBenchmarkSamples} lượt mỗi mode.`;
  } else if (!enoughQualityReviews) {
    reason = `Cần duyệt chất lượng ít nhất ${minimumAsrBenchmarkSamples} lượt mỗi mode.`;
  } else if (recommended) {
    reason = `Streaming rule/cache giảm P95 ${p95ImprovementRate}% (${batch.p95FirstAudioMs} ms xuống ${streaming.p95FirstAudioMs} ms) và giữ được chất lượng.`;
  }

  return {
    recommended,
    reason,
    minimumSamplesPerMode: minimumAsrBenchmarkSamples,
    p95ImprovementRate,
  };
}

function buildBreakdown<T extends string>(
  values: T[],
  conversations: ConversationHistoryEntry[],
  getValue: (entry: ConversationHistoryEntry) => T,
) {
  return values
    .map((value) => {
      const items = conversations.filter((entry) => getValue(entry) === value);

      return {
        source: value,
        ...buildLatencyStats(items),
      };
    })
    .filter((item) => item.count > 0);
}

function buildDynamicBreakdown(
  conversations: ConversationHistoryEntry[],
  getValue: (entry: ConversationHistoryEntry) => string,
) {
  const values = [...new Set(conversations.map(getValue))];
  return buildBreakdown(values, conversations, getValue);
}

function getUtteranceLength(entry: ConversationHistoryEntry) {
  const durationMs = entry.benchmark?.utteranceDurationMs;

  if (typeof durationMs !== "number") {
    return "unknown";
  }

  if (durationMs <= 2500) {
    return "short_0_2.5s";
  }

  if (durationMs <= 5000) {
    return "medium_2.5_5s";
  }

  return "long_over_5s";
}

export function buildLatencyReport(
  conversations: ConversationHistoryEntry[],
): LatencyReport {
  const firstAudioValues = conversations.map(
    getMeasuredFirstAudio,
  ).filter((value): value is number => value !== null);
  const p95FirstAudioMs = percentile(firstAudioValues, 95);
  const p95ThresholdMs = getLatencyP95ThresholdMs();
  const alerts: LatencyReport["alerts"] =
    firstAudioValues.length >= minimumLatencyAlertSamples &&
    p95FirstAudioMs > p95ThresholdMs
      ? [
          {
            code: "LATENCY_P95_HIGH",
            severity: "warning",
            metric: "audio_started_after_stop_ms",
            actualMs: p95FirstAudioMs,
            thresholdMs: p95ThresholdMs,
            sampleCount: firstAudioValues.length,
            message: `P95 từ lúc dừng nói đến khi audio bắt đầu phát là ${p95FirstAudioMs} ms, vượt ngưỡng ${p95ThresholdMs} ms.`,
          },
        ]
      : [];
  const easyItems = conversations.filter((entry) =>
    ["phrase_rule", "keyword_rule", "promoted_rule", "semantic_cache"].includes(
      getTextSource(entry),
    ),
  );
  const aiItems = conversations.filter(
    (entry) =>
      ["cloudflare", "openai", "text_cache"].includes(
        getTextSource(entry),
      ),
  );
  const openAiTextItems = conversations.filter(
    (entry) => getTextSource(entry) === "openai",
  );
  const cachedAudioItems = conversations.filter(
    (entry) => getAudioSource(entry) === "cache",
  );
  const openAiTextCalls = openAiTextItems.length;
  const openAiTtsCalls = conversations.filter(
    (entry) => getAudioSource(entry) === "openai_tts",
  ).length;
  const asrModeBreakdown = asrModes
    .map((mode) => buildAsrModeStats(mode, conversations))
    .filter((item) => item.count > 0);

  return {
    totalTurns: conversations.length,
    measuredTurns: firstAudioValues.length,
    averageFirstAudioMs: average(firstAudioValues),
    p50FirstAudioMs: percentile(firstAudioValues, 50),
    p95FirstAudioMs,
    fastestFirstAudioMs:
      firstAudioValues.length > 0 ? Math.min(...firstAudioValues) : 0,
    slowestFirstAudioMs:
      firstAudioValues.length > 0 ? Math.max(...firstAudioValues) : 0,
    underTwoSecondsRate: rate(
      conversations.filter((entry) => entry.latency.timeToFirstAudioMs <= 2000)
        .length,
      conversations.length,
    ),
    underThreeSecondsRate: rate(
      conversations.filter((entry) => entry.latency.timeToFirstAudioMs <= 3000)
        .length,
      conversations.length,
    ),
    alerts,
    kpi: {
      easyUnderOneSecondRate: rate(
        easyItems.filter((entry) => entry.latency.timeToFirstAudioMs <= 1000)
          .length,
        easyItems.length,
      ),
      easyPassed: easyItems.filter(
        (entry) => entry.latency.timeToFirstAudioMs <= 1000,
      ).length,
      easyTotal: easyItems.length,
      aiUnderTwoSecondsRate: rate(
        aiItems.filter((entry) => entry.latency.timeToFirstAudioMs <= 2000)
          .length,
        aiItems.length,
      ),
      aiPassed: aiItems.filter(
        (entry) => entry.latency.timeToFirstAudioMs <= 2000,
      ).length,
      aiTotal: aiItems.length,
      cachedAudioUnderOneSecondRate: rate(
        cachedAudioItems.filter(
          (entry) => entry.latency.timeToFirstAudioMs <= 1000,
        ).length,
        cachedAudioItems.length,
      ),
      cachedAudioPassed: cachedAudioItems.filter(
        (entry) => entry.latency.timeToFirstAudioMs <= 1000,
      ).length,
      cachedAudioTotal: cachedAudioItems.length,
      openAiTextCallRate: rate(openAiTextCalls, conversations.length),
      openAiTextCalls,
      openAiTtsCallRate: rate(openAiTtsCalls, conversations.length),
      openAiTtsCalls,
    },
    modeBreakdown: modes
      .map((mode) => {
        const items = conversations.filter(
          (entry) => getProcessingMode(entry) === mode,
        );

        return {
          mode,
          ...buildLatencyStats(items),
        };
      })
      .filter((item) => item.count > 0),
    textSourceBreakdown: buildBreakdown(
      textSources,
      conversations,
      getTextSource,
    ),
    audioSourceBreakdown: buildBreakdown(
      audioSources,
      conversations,
      getAudioSource,
    ),
    contextBreakdown: contexts
      .map((context) => {
        const items = conversations.filter((entry) => entry.context === context);

        return {
          context,
          ...buildLatencyStats(items),
        };
      })
      .filter((item) => item.count > 0),
    asrModeBreakdown,
    streamingAsrDecision: buildStreamingAsrDecision(conversations),
    benchmarkBreakdown: {
      device: buildDynamicBreakdown(
        conversations,
        (entry) => entry.benchmark?.device ?? "unknown",
      ),
      browser: buildDynamicBreakdown(
        conversations,
        (entry) => entry.benchmark?.browser ?? "unknown",
      ),
      network: buildDynamicBreakdown(
        conversations,
        (entry) => entry.benchmark?.network ?? "unknown",
      ),
      utteranceLength: buildDynamicBreakdown(
        conversations,
        getUtteranceLength,
      ),
    },
    slowestTurns: [...conversations]
      .sort(
        (a, b) =>
          b.latency.timeToFirstAudioMs - a.latency.timeToFirstAudioMs,
      )
      .slice(0, 5)
      .map((entry) => ({
        conversationId: entry.conversationId,
        context: entry.context,
        vietnameseText: entry.vietnameseText,
        englishText: entry.englishText,
        processingMode: getProcessingMode(entry),
        textSource: getTextSource(entry),
        audioSource: getAudioSource(entry),
        asrMode: getAsrMode(entry),
        firstAudioMs: entry.latency.timeToFirstAudioMs,
        asrMs: entry.latency.asrMs,
        llmMs: entry.latency.llmMs,
        ttsMs: entry.latency.ttsMs,
        createdAt: entry.createdAt,
      })),
    generatedAt: new Date().toISOString(),
  };
}
