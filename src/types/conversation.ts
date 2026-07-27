export type PracticeContext = "home" | "school" | "outside";

export type TargetLanguage = "en";

export type AsrMode =
  | "text"
  | "batch_chunks"
  | "browser_streaming"
  | "android_streaming"
  | "openai_realtime"
  | "ble_offline_intent";

export type BenchmarkMetadata = {
  browser?: string;
  device?: "mobile" | "desktop";
  network?: string;
  utteranceDurationMs?: number;
  vadSilenceMs?: number;
  requestedAsrMode?: Exclude<AsrMode, "text">;
  streamingFallbackReason?: string;
  audioInputLabel?: string;
  bluetoothAudioInput?: boolean;
  initialNoiseRms?: number;
  asrConfidence?: number;
  asrFirstDeltaMs?: number;
  asrFinalAfterStopMs?: number;
  batchTransport?: string;
  chunkIntervalMs?: number;
  audioChunkCount?: number;
  uploadedAudioBytes?: number;
  recordingSampleRate?: number;
  sessionCreateMs?: number;
  uploadDrainAfterStopMs?: number;
  wavHeaderStrategy?: "uploaded_chunk" | "finalize_metadata";
};

export type ConversationRequest = {
  requestId?: string;
  clientId?: string;
  sessionId?: string;
  context: PracticeContext;
  childAge?: number;
  targetLanguage: TargetLanguage;
  sourceText?: string;
  audioFile?: File;
  asrMode?: AsrMode;
  benchmark?: BenchmarkMetadata;
};

export type ConversationLatency = {
  asrMs: number;
  llmMs: number;
  ttsMs: number;
  timeToFirstAudioMs: number;
  asrFirstDeltaMs?: number;
  asrFinalAfterStopMs?: number;
  uploadDrainAfterStopMs?: number;
  audioLoadMs?: number;
  audioFromDeviceCache?: boolean;
  /** @deprecated Use audioLoadMs. Kept for older history records. */
  ttsFirstByteMs?: number;
  browserAudioStartedMs?: number;
  audioStartedAfterStopMs?: number;
};

export type ProcessingMode = "rule" | "ai" | "fallback";

export type TextProvider = "cloudflare" | "openai";

export type TextSource =
  | "phrase_rule"
  | "keyword_rule"
  | "promoted_rule"
  | "semantic_cache"
  | "text_cache"
  | "cloudflare"
  | "openai"
  | "cloudflare"
  | "fallback";

export type AudioSource = "cache" | "openai_tts" | "cloudflare_tts";

export type ConversationReviewStatus =
  | "unreviewed"
  | "approved"
  | "rejected"
  | "needs_review";

export type ConversationAiReview = {
  verdict: "approved" | "rejected" | "needs_review";
  confidence: number;
  reason: string;
  suggestedEnglish?: string;
  model: string;
  reviewedAt: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type ConversationResponse = {
  requestId?: string;
  clientId?: string;
  conversationId: string;
  sessionId: string;
  context: PracticeContext;
  vietnameseText: string;
  englishText: string;
  audioUrl: string | null;
  promptVersion: string;
  processingMode: ProcessingMode;
  matchedRule?: string;
  textSource: TextSource;
  textProvider?: TextProvider;
  textModel?: string;
  textFallbackUsed?: boolean;
  textFallbackReason?: string;
  audioSource: AudioSource;
  asrMode: AsrMode;
  benchmark?: BenchmarkMetadata;
  latency: ConversationLatency;
};

export type ConversationHistoryEntry = ConversationResponse & {
  createdAt: string;
  inputMode: "text" | "audio";
  qualityApproved?: boolean;
  reviewStatus?: ConversationReviewStatus;
  reviewedAt?: string;
  reviewedBy?: "admin" | "practice";
  reviewNote?: string;
  originalEnglishText?: string;
  aiReview?: ConversationAiReview;
  promotedToRule?: boolean;
  learningStatus?:
    | "already_rule"
    | "cached"
    | "observing"
    | "promoted"
    | "rejected"
    | "conflict"
    | "not_eligible";
  learningReason?:
    | "positive_feedback"
    | "negative_feedback"
    | "repeated_use"
    | "manual";
  learningUseCount?: number;
};

export type ConversationHistoryPatch = {
  conversationId: string;
  clientId?: string;
  englishText?: string;
  originalEnglishText?: string;
  audioUrl?: string | null;
  audioSource?: AudioSource;
  latency?: Partial<ConversationLatency>;
  qualityApproved?: boolean;
  reviewStatus?: ConversationReviewStatus;
  reviewedAt?: string;
  reviewedBy?: ConversationHistoryEntry["reviewedBy"];
  reviewNote?: string;
  aiReview?: ConversationAiReview;
  promotedToRule?: boolean;
  learningStatus?: ConversationHistoryEntry["learningStatus"];
  learningReason?: ConversationHistoryEntry["learningReason"];
  learningUseCount?: number;
};

export type LatencyBreakdownItem<T extends string> = {
  source: T;
  count: number;
  averageFirstAudioMs: number;
  p50FirstAudioMs: number;
  p95FirstAudioMs: number;
};

export type LatencyReport = {
  totalTurns: number;
  measuredTurns: number;
  averageFirstAudioMs: number;
  p50FirstAudioMs: number;
  p95FirstAudioMs: number;
  fastestFirstAudioMs: number;
  slowestFirstAudioMs: number;
  underTwoSecondsRate: number;
  underThreeSecondsRate: number;
  alerts: Array<{
    code: "LATENCY_P95_HIGH";
    severity: "warning";
    metric: "audio_started_after_stop_ms";
    actualMs: number;
    thresholdMs: number;
    sampleCount: number;
    message: string;
  }>;
  kpi: {
    easyUnderOneSecondRate: number;
    easyPassed: number;
    easyTotal: number;
    aiUnderTwoSecondsRate: number;
    aiPassed: number;
    aiTotal: number;
    cachedAudioUnderOneSecondRate: number;
    cachedAudioPassed: number;
    cachedAudioTotal: number;
    openAiTextCallRate: number;
    openAiTextCalls: number;
    openAiTtsCallRate: number;
    openAiTtsCalls: number;
  };
  modeBreakdown: Array<{
    mode: ProcessingMode | "old";
    count: number;
    averageFirstAudioMs: number;
    p50FirstAudioMs: number;
    p95FirstAudioMs: number;
  }>;
  textSourceBreakdown: Array<{
    source: TextSource | "old";
    count: number;
    averageFirstAudioMs: number;
    p50FirstAudioMs: number;
    p95FirstAudioMs: number;
  }>;
  audioSourceBreakdown: Array<{
    source: AudioSource | "old";
    count: number;
    averageFirstAudioMs: number;
    p50FirstAudioMs: number;
    p95FirstAudioMs: number;
  }>;
  contextBreakdown: Array<{
    context: PracticeContext;
    count: number;
    averageFirstAudioMs: number;
    p50FirstAudioMs: number;
    p95FirstAudioMs: number;
  }>;
  asrModeBreakdown: Array<LatencyBreakdownItem<AsrMode | "old"> & {
    reviewed: number;
    qualityApprovedRate: number;
    p50AsrFirstDeltaMs: number;
    p95AsrFirstDeltaMs: number;
    p50AsrFinalAfterStopMs: number;
    p95AsrFinalAfterStopMs: number;
  }>;
  streamingAsrDecision: {
    recommended: boolean;
    reason: string;
    minimumSamplesPerMode: number;
    p95ImprovementRate: number;
  };
  benchmarkBreakdown: {
    device: Array<LatencyBreakdownItem<string>>;
    browser: Array<LatencyBreakdownItem<string>>;
    network: Array<LatencyBreakdownItem<string>>;
    utteranceLength: Array<LatencyBreakdownItem<string>>;
  };
  slowestTurns: Array<{
    conversationId: string;
    context: PracticeContext;
    vietnameseText: string;
    englishText: string;
    processingMode: ProcessingMode | "old";
    textSource: TextSource | "old";
    audioSource: AudioSource | "old";
    asrMode: AsrMode | "old";
    firstAudioMs: number;
    asrMs: number;
    llmMs: number;
    ttsMs: number;
    createdAt: string;
  }>;
  generatedAt: string;
};

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "AUDIO_TOO_SHORT"
  | "AUDIO_TOO_LONG"
  | "ASR_FAILED"
  | "ASR_LOW_CONFIDENCE"
  | "LLM_FAILED"
  | "TTS_FAILED"
  | "UNSAFE_CONTENT"
  | "RATE_LIMITED";

export type ApiErrorResponse = {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
  };
};
