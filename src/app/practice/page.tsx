"use client";

import { useEffect, useRef, useState } from "react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { AudioWarmupPanel } from "@/components/AudioWarmupPanel";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ConversationHistoryPanel } from "@/components/ConversationHistoryPanel";
import { ContextSelector } from "@/components/ContextSelector";
import { DeviceReadinessPanel } from "@/components/DeviceReadinessPanel";
import { LatencyReportPanel } from "@/components/LatencyReportPanel";
import { LatencyPanel } from "@/components/LatencyPanel";
import { MvpTestPlanPanel } from "@/components/MvpTestPlanPanel";
import { RecorderButton } from "@/components/RecorderButton";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { useUiLocale } from "@/components/UiLocaleProvider";
import { useConversationRecorder } from "@/hooks/useConversationRecorder";
import { useDeviceReadiness } from "@/hooks/useDeviceReadiness";
import type {
  AsrMode,
  ConversationHistoryEntry,
  ConversationResponse,
  LatencyReport,
  PracticeContext,
} from "@/types/conversation";

type AudioWarmupResult = {
  context: PracticeContext | "all";
  total: number;
  cached: number;
  generated: number;
  failed: number;
  latencyMs: number;
};

const sampleByContext: Record<PracticeContext, string> = {
  home: "Con muốn uống nước",
  school: "Con cần bút chì",
  outside: "Con bị lạc",
};

async function getResponseError(response: Response) {
  const data = await response.json().catch(() => null);

  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    data.error &&
    typeof data.error === "object" &&
    "message" in data.error &&
    typeof data.error.message === "string"
  ) {
    return data.error.message;
  }

  return `Request failed with status ${response.status}`;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = 30_000,
) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export default function PracticePage() {
  const { pick } = useUiLocale();
  const [context, setContext] = useState<PracticeContext>("home");
  const [asrMode, setAsrMode] =
    useState<Exclude<AsrMode, "text">>("batch_chunks");
  const [vadSilenceMs, setVadSilenceMs] = useState(700);
  const [result, setResult] = useState<ConversationResponse | null>(null);
  const [history, setHistory] = useState<ConversationHistoryEntry[]>([]);
  const [report, setReport] = useState<LatencyReport | null>(null);
  const [warmupResult, setWarmupResult] = useState<AudioWarmupResult | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isWarmingAudio, setIsWarmingAudio] = useState(false);
  const [isResettingHistory, setIsResettingHistory] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const playbackBaselineRef = useRef<number | null>(null);
  const firstByteElapsedRef = useRef<number | undefined>(undefined);
  const firstByteReportedRef = useRef("");
  const playbackReportedRef = useRef("");
  const asrModeManuallySelectedRef = useRef(false);
  const readiness = useDeviceReadiness();

  async function refreshTestData() {
    const [historyResponse, reportResponse] = await Promise.all([
      fetch("/api/history", { cache: "no-store" }),
      fetch("/api/reports", { cache: "no-store" }),
    ]);

    if (historyResponse.ok) {
      const historyData = (await historyResponse.json()) as {
        conversations: ConversationHistoryEntry[];
      };
      setHistory(historyData.conversations);
    }

    if (reportResponse.ok) {
      const reportData = (await reportResponse.json()) as {
        report: LatencyReport;
      };
      setReport(reportData.report);
    }
  }

  const recorder = useConversationRecorder({
    context,
    asrMode,
    vadSilenceMs,
    onResult: (nextResult, stoppedAt) => {
      performance.clearResourceTimings();
      playbackBaselineRef.current = stoppedAt;
      firstByteReportedRef.current = "";
      playbackReportedRef.current = "";
      firstByteElapsedRef.current = undefined;
      setResult(nextResult);
      void refreshTestData();
    },
    onError: (message) => setErrorMessage(message || null),
  });
  const isBusy = isLoading || recorder.isSubmitting;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshTestData();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!readiness.isChecking && !asrModeManuallySelectedRef.current) {
      setAsrMode(readiness.recommendedMode);
    }
  }, [readiness.isChecking, readiness.recommendedMode]);

  function changeContext(nextContext: PracticeContext) {
    setContext(nextContext);
    setWarmupResult(null);
  }

  function chooseAsrMode(nextMode: Exclude<AsrMode, "text">) {
    asrModeManuallySelectedRef.current = true;
    setAsrMode(nextMode);
  }

  async function submitTextConversation(sourceText: string) {
    performance.clearResourceTimings();
    playbackBaselineRef.current = performance.now();
    firstByteReportedRef.current = "";
    playbackReportedRef.current = "";
    firstByteElapsedRef.current = undefined;
    const response = await fetchWithTimeout("/api/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context,
        childAge: 6,
        targetLanguage: "en",
        sourceText,
      }),
    });

    if (!response.ok) {
      throw new Error(await getResponseError(response));
    }

    const data = (await response.json()) as ConversationResponse;
    setResult(data);
    await refreshTestData();
  }

  async function submitMockConversation() {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      await submitTextConversation(sampleByContext[context]);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : pick("Không gửi được câu mẫu.", "无法发送示例句。"),
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function warmupRuleAudio(targetContext: PracticeContext | "all") {
    setIsWarmingAudio(true);
    setErrorMessage(null);

    try {
      const response = await fetchWithTimeout(
        "/api/cache/warmup",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context: targetContext }),
        },
        180_000,
      );

      if (!response.ok) {
        throw new Error(await getResponseError(response));
      }

      const data = (await response.json()) as { result: AudioWarmupResult };
      setWarmupResult(data.result);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : pick("Không pre-cache được audio.", "无法预缓存音频。"),
      );
    } finally {
      setIsWarmingAudio(false);
    }
  }

  async function resetBenchmarkHistory() {
    if (
      !window.confirm(
        pick(
          "Xóa lịch sử thử nghiệm local để benchmark lại? Audio cache vẫn được giữ.",
          "要清除本地测试记录并重新进行基准测试吗？音频缓存会保留。",
        ),
      )
    ) {
      return;
    }

    setIsResettingHistory(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/history", { method: "DELETE" });

      if (!response.ok) {
        throw new Error(await getResponseError(response));
      }

      setResult(null);
      await refreshTestData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : pick("Không xóa được lịch sử.", "无法清除记录。"),
      );
    } finally {
      setIsResettingHistory(false);
    }
  }

  async function submitTestPlanSentence(sentence: string) {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      await submitTextConversation(sentence);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : pick("Không gửi được câu thử nghiệm.", "无法发送测试句。"),
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function patchCurrentLatency(
    latency: Partial<ConversationResponse["latency"]>,
  ) {
    if (!result) {
      return;
    }

    setResult((current) =>
      current
        ? { ...current, latency: { ...current.latency, ...latency } }
        : current,
    );
    await fetch("/api/history", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: result.conversationId,
        latency,
      }),
    });
  }

  function reportTtsFirstByte(responseStartAt: number) {
    if (
      !result ||
      firstByteReportedRef.current === result.conversationId ||
      playbackBaselineRef.current === null
    ) {
      return;
    }

    firstByteReportedRef.current = result.conversationId;
    const ttsFirstByteMs = Math.round(
      responseStartAt - playbackBaselineRef.current,
    );
    firstByteElapsedRef.current = ttsFirstByteMs;
    void patchCurrentLatency({ ttsFirstByteMs });
  }

  function reportAudioStarted() {
    if (
      !result ||
      playbackReportedRef.current === result.conversationId ||
      playbackBaselineRef.current === null
    ) {
      return;
    }

    playbackReportedRef.current = result.conversationId;
    const elapsedMs = Math.round(
      performance.now() - playbackBaselineRef.current,
    );
    void patchCurrentLatency({
      ttsFirstByteMs: firstByteElapsedRef.current,
      browserAudioStartedMs: elapsedMs,
      timeToFirstAudioMs: elapsedMs,
      audioStartedAfterStopMs:
        result.asrMode === "text" ? undefined : elapsedMs,
    }).then(refreshTestData);
  }

  async function reviewConversation(
    conversationId: string,
    qualityApproved: boolean,
  ) {
    await fetch("/api/history", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, qualityApproved }),
    });
    await refreshTestData();
  }

  async function promoteConversation(conversationId: string) {
    const response = await fetch("/api/rules/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });

    if (!response.ok) {
      setErrorMessage(await getResponseError(response));
      return;
    }

    await refreshTestData();
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-950">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold uppercase text-blue-700">
              {pick("Benchmark MVP", "MVP 基准测试")}
            </p>
            <h1 className="text-3xl font-semibold">
              {pick("Nói tiếng Việt sang tiếng Anh", "越南语转英语口语")}
            </h1>
          </div>
          <LanguageToggle />
        </header>

        <DeviceReadinessPanel
          readiness={readiness}
          selectedMode={asrMode}
          effectiveMode={
            recorder.isRecording ||
            recorder.isSubmitting ||
            recorder.fallbackReason
              ? recorder.effectiveAsrMode
              : undefined
          }
          fallbackReason={recorder.fallbackReason}
          audioInputLabel={recorder.audioInputLabel}
          isBluetoothInput={recorder.isBluetoothInput}
          initialNoiseRms={recorder.initialNoiseRms}
          onRefresh={readiness.refresh}
        />

        <section className="rounded-md border border-slate-200 bg-white p-5">
          <p className="mb-3 text-sm font-semibold text-slate-800">
            {pick("Chọn ngữ cảnh", "选择场景")}
          </p>
          <ContextSelector value={context} onChange={changeContext} />

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-800">
                {pick("Benchmark ASR", "ASR 基准测试")}
              </legend>
              <div className="inline-flex rounded-md border border-slate-300 p-1">
                {(
                  [
                    ["batch_chunks", pick("Batch chunks", "分块批处理")],
                    ["browser_streaming", pick("Streaming", "流式识别")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => chooseAsrMode(value)}
                    disabled={recorder.isRecording || recorder.isSubmitting}
                    className={`rounded px-3 py-2 text-sm font-semibold ${
                      asrMode === value
                        ? "bg-slate-950 text-white"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-800">
                {pick("VAD local", "本地 VAD")}
              </legend>
              <div className="inline-flex rounded-md border border-slate-300 p-1">
                {[500, 700, 900].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setVadSilenceMs(value)}
                    disabled={recorder.isRecording || recorder.isSubmitting}
                    className={`rounded px-3 py-2 text-sm font-semibold ${
                      vadSilenceMs === value
                        ? "bg-blue-700 text-white"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {value} ms
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="mt-5">
            <RecorderButton
              isLoading={isBusy}
              isRecording={recorder.isRecording}
              onRecordToggle={recorder.toggleRecording}
              onSampleSubmit={submitMockConversation}
            />
          </div>

          {recorder.isRecording ? (
            <p className="mt-3 text-sm text-slate-600">
              {recorder.speechDetected
                ? pick(
                    `Đã nghe giọng nói, VAD ${vadSilenceMs} ms đang hoạt động.`,
                    `已检测到语音，VAD ${vadSilenceMs} 毫秒正在工作。`,
                  )
                : pick("Đang chờ giọng nói…", "正在等待语音…")}
              {recorder.interimTranscript
                ? pick(
                    ` Bản chép tạm: ${recorder.interimTranscript}`,
                    ` 临时转写：${recorder.interimTranscript}`,
                  )
                : ""}
            </p>
          ) : null}

          {errorMessage ? (
            <p className="mt-3 text-sm font-medium text-red-600">
              {errorMessage}
            </p>
          ) : null}
        </section>

        <AudioWarmupPanel
          context={context}
          isWarming={isWarmingAudio}
          result={warmupResult}
          onWarmup={() => warmupRuleAudio(context)}
          onWarmupAll={() => warmupRuleAudio("all")}
        />

        <MvpTestPlanPanel
          context={context}
          isLoading={isBusy || isWarmingAudio}
          onSubmitSentence={submitTestPlanSentence}
        />

        <TranscriptPanel
          vietnameseText={result?.vietnameseText}
          englishText={result?.englishText}
        />

        <LatencyPanel latency={result?.latency} />

        <AudioPlayer
          audioUrl={result?.audioUrl}
          englishText={result?.englishText}
          onFirstByte={reportTtsFirstByte}
          onPlaybackStarted={reportAudioStarted}
        />

        <LatencyReportPanel
          report={report}
          isResetting={isResettingHistory}
          onResetHistory={resetBenchmarkHistory}
        />

        <ConversationHistoryPanel
          conversations={history}
          onReview={reviewConversation}
          onPromote={promoteConversation}
        />
      </div>
    </main>
  );
}
