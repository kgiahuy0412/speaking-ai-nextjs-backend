"use client";

import { useUiLocale, type UiLocale } from "@/components/UiLocaleProvider";
import type { LatencyReport } from "@/types/conversation";

type LatencyReportPanelProps = {
  report: LatencyReport | null;
  isResetting?: boolean;
  onResetHistory?: () => void;
};

function formatPercent(value: number) {
  return `${value}%`;
}

function formatMs(value: number) {
  return `${value}ms`;
}

function formatLatencyStats(item: {
  count: number;
  averageFirstAudioMs: number;
  p50FirstAudioMs: number;
  p95FirstAudioMs: number;
}, locale: UiLocale) {
  return locale === "zh"
    ? `${item.count} 次 / 平均 ${formatMs(item.averageFirstAudioMs)} / P50 ${formatMs(item.p50FirstAudioMs)} / P95 ${formatMs(item.p95FirstAudioMs)}`
    : `${item.count} lượt / TB ${formatMs(item.averageFirstAudioMs)} / P50 ${formatMs(item.p50FirstAudioMs)} / P95 ${formatMs(item.p95FirstAudioMs)}`;
}

export function LatencyReportPanel({
  report,
  isResetting = false,
  onResetHistory,
}: LatencyReportPanelProps) {
  const { locale, pick } = useUiLocale();

  if (!report || report.totalTurns === 0) {
    return (
      <section className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {pick("Tổng hợp độ trễ", "延迟汇总")}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {pick(
                "Chưa có dữ liệu. Hãy tạo sẵn audio cache rồi kiểm tra lại từ đầu.",
                "暂无数据。请先预生成音频缓存，然后重新测试。",
              )}
            </p>
          </div>
          {onResetHistory ? (
            <button
              type="button"
              onClick={onResetHistory}
              disabled={isResetting}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {isResetting
                ? pick("Đang đặt lại…", "正在重置…")
                : pick("Đặt lại lịch sử", "重置历史")}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const metrics = [
    [pick("Tổng lượt", "总次数"), report.totalTurns.toString()],
    [pick("TB audio đầu", "首段音频平均值"), formatMs(report.averageFirstAudioMs)],
    [pick("P50 audio đầu", "首段音频 P50"), formatMs(report.p50FirstAudioMs)],
    [pick("P95 audio đầu", "首段音频 P95"), formatMs(report.p95FirstAudioMs)],
    [pick("Nhanh nhất", "最快"), formatMs(report.fastestFirstAudioMs)],
    [pick("Chậm nhất", "最慢"), formatMs(report.slowestFirstAudioMs)],
    [pick("Dưới 2 giây", "低于 2 秒"), formatPercent(report.underTwoSecondsRate)],
    [pick("Dưới 3 giây", "低于 3 秒"), formatPercent(report.underThreeSecondsRate)],
  ];
  const kpiMetrics = [
    [
      pick("Câu dễ ≤1 giây", "简单句 ≤1 秒"),
      `${formatPercent(report.kpi.easyUnderOneSecondRate)} (${report.kpi.easyPassed}/${report.kpi.easyTotal})`,
    ],
    [
      pick("AI câu lạ ≤2 giây", "AI 陌生句 ≤2 秒"),
      `${formatPercent(report.kpi.aiUnderTwoSecondsRate)} (${report.kpi.aiPassed}/${report.kpi.aiTotal})`,
    ],
    [
      pick("Audio cache ≤1 giây", "音频缓存 ≤1 秒"),
      `${formatPercent(report.kpi.cachedAudioUnderOneSecondRate)} (${report.kpi.cachedAudioPassed}/${report.kpi.cachedAudioTotal})`,
    ],
    [
      "Legacy OpenAI text (history only)",
      `${formatPercent(report.kpi.openAiTextCallRate)} (${report.kpi.openAiTextCalls})`,
    ],
    [
      "Legacy OpenAI TTS (history only)",
      `${formatPercent(report.kpi.openAiTtsCallRate)} (${report.kpi.openAiTtsCalls})`,
    ],
  ];
  const benchmarkDimensions = [
    [pick("Thiết bị", "设备"), report.benchmarkBreakdown.device],
    [pick("Trình duyệt", "浏览器"), report.benchmarkBreakdown.browser],
    [pick("Mạng", "网络"), report.benchmarkBreakdown.network],
    [pick("Độ dài lượt nói", "语句长度"), report.benchmarkBreakdown.utteranceLength],
  ] as const;

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-4 flex flex-col justify-between gap-3 md:flex-row md:items-start">
        <div>
          <p className="text-sm font-semibold text-slate-950">
            {pick("Tổng hợp độ trễ", "延迟汇总")}
          </p>
          <p className="text-xs text-slate-500">
            {pick(
              "KPI: câu dễ dưới 1 giây, câu lạ dùng Cloudflare dưới 2 giây, tăng tỷ lệ rule/cache.",
              "KPI：简单句低于 1 秒，陌生句通过 Cloudflare 低于 2 秒，并提高规则/缓存命中率。",
            )}
          </p>
        </div>
        {onResetHistory ? (
          <button
            type="button"
            onClick={onResetHistory}
            disabled={isResetting}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {isResetting
              ? pick("Đang đặt lại…", "正在重置…")
              : pick("Đặt lại lịch sử", "重置历史")}
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={label} className="rounded-md bg-slate-50 p-3">
            <p className="text-xs font-semibold uppercase text-slate-500">
              {label}
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-950">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-5">
        {kpiMetrics.map(([label, value]) => (
          <div key={label} className="rounded-md bg-blue-50 p-3">
            <p className="text-xs font-semibold uppercase text-blue-700">
              {label}
            </p>
            <p className="mt-1 text-base font-semibold text-slate-950">
              {value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-slate-200 pt-4">
        <div className="flex flex-col justify-between gap-2 md:flex-row">
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500">
              {pick("Quyết định streaming ASR", "流式 ASR 决策")}
            </p>
            <p className="mt-1 text-sm text-slate-700">
              {report.streamingAsrDecision.reason}
            </p>
          </div>
          <p
            className={`text-sm font-semibold ${
              report.streamingAsrDecision.recommended
                ? "text-emerald-700"
                : "text-amber-700"
            }`}
          >
            {report.streamingAsrDecision.recommended
              ? pick("Đề xuất bật mặc định", "建议默认启用")
              : pick("Giữ batch mặc định", "保持默认批处理")}
          </p>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3">{pick("Chế độ ASR", "ASR 模式")}</th>
                <th className="py-2 pr-3">{pick("Audio đầu P50/P95", "首段音频 P50/P95")}</th>
                <th className="py-2 pr-3">{pick("Delta đầu P50/P95", "首个增量 P50/P95")}</th>
                <th className="py-2 pr-3">{pick("Final/Stop P50/P95", "最终/停止 P50/P95")}</th>
                <th className="py-2">{pick("Chất lượng", "质量")}</th>
              </tr>
            </thead>
            <tbody>
              {report.asrModeBreakdown.map((item) => (
                <tr key={item.source} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-medium text-slate-800">
                    {item.source} ({item.count})
                  </td>
                  <td className="py-2 pr-3 text-slate-600">
                    {formatMs(item.p50FirstAudioMs)} /{" "}
                    {formatMs(item.p95FirstAudioMs)}
                  </td>
                  <td className="py-2 pr-3 text-slate-600">
                    {formatMs(item.p50AsrFirstDeltaMs)} /{" "}
                    {formatMs(item.p95AsrFirstDeltaMs)}
                  </td>
                  <td className="py-2 pr-3 text-slate-600">
                    {formatMs(item.p50AsrFinalAfterStopMs)} /{" "}
                    {formatMs(item.p95AsrFinalAfterStopMs)}
                  </td>
                  <td className="py-2 text-slate-600">
                    {formatPercent(item.qualityApprovedRate)} ({item.reviewed})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-100 p-3">
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
            {pick("Theo chế độ", "按模式")}
          </p>
          <div className="space-y-2">
            {report.modeBreakdown.map((item) => (
              <div
                key={item.mode}
                className="flex min-w-0 items-center justify-between gap-3 text-sm"
              >
                <span className="font-medium text-slate-700">{item.mode}</span>
                <span className="min-w-0 text-right text-slate-500">
                  {formatLatencyStats(item, locale)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-slate-100 p-3">
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
            {pick("Theo ngữ cảnh", "按场景")}
          </p>
          <div className="space-y-2">
            {report.contextBreakdown.map((item) => (
              <div
                key={item.context}
                className="flex min-w-0 items-center justify-between gap-3 text-sm"
              >
                <span className="font-medium text-slate-700">
                  {item.context}
                </span>
                <span className="min-w-0 text-right text-slate-500">
                  {formatLatencyStats(item, locale)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-slate-100 p-3">
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
            {pick("Theo nguồn văn bản", "按文本来源")}
          </p>
          <div className="space-y-2">
            {report.textSourceBreakdown.map((item) => (
              <div
                key={item.source}
                className="flex min-w-0 items-center justify-between gap-3 text-sm"
              >
                <span className="font-medium text-slate-700">
                  {item.source}
                </span>
                <span className="min-w-0 text-right text-slate-500">
                  {formatLatencyStats(item, locale)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-slate-100 p-3">
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
            {pick("Theo nguồn audio", "按音频来源")}
          </p>
          <div className="space-y-2">
            {report.audioSourceBreakdown.map((item) => (
              <div
                key={item.source}
                className="flex min-w-0 items-center justify-between gap-3 text-sm"
              >
                <span className="font-medium text-slate-700">
                  {item.source}
                </span>
                <span className="min-w-0 text-right text-slate-500">
                  {formatLatencyStats(item, locale)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {benchmarkDimensions.map(([label, items]) => (
          <div key={label} className="border-t border-slate-200 pt-3">
            <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
              {label}
            </p>
            <div className="space-y-2">
              {items.map((item) => (
                <div
                  key={item.source}
                  className="flex min-w-0 items-center justify-between gap-3 text-sm"
                >
                  <span className="font-medium text-slate-700">
                    {item.source}
                  </span>
                  <span className="min-w-0 text-right text-slate-500">
                    {formatLatencyStats(item, locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {report.slowestTurns.length > 0 ? (
        <div className="mt-4 rounded-md border border-slate-100 p-3">
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
            {pick("Câu chậm nhất", "最慢的句子")}
          </p>
          <div className="space-y-2">
            {report.slowestTurns.map((item) => (
              <div
                key={item.conversationId}
                className="grid gap-1 border-b border-slate-100 pb-2 text-sm last:border-0 last:pb-0 md:grid-cols-[1fr_120px]"
              >
                <div>
                  <p className="font-medium text-slate-950">
                    {item.vietnameseText}
                  </p>
                  <p className="text-blue-700">{item.englishText}</p>
                </div>
                <div className="text-slate-500 md:text-right">
                  <p className="font-semibold text-slate-950">
                    {formatMs(item.firstAudioMs)}
                  </p>
                  <p>{item.textSource}</p>
                  <p>{item.audioSource}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
