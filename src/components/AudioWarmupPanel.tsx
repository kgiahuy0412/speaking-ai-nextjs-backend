"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";
import type { PracticeContext } from "@/types/conversation";

type AudioWarmupResult = {
  context: PracticeContext | "all";
  total: number;
  cached: number;
  generated: number;
  failed: number;
  latencyMs: number;
};

type AudioWarmupPanelProps = {
  context: PracticeContext;
  isWarming: boolean;
  result: AudioWarmupResult | null;
  onWarmup: () => void;
  onWarmupAll: () => void;
};

export function AudioWarmupPanel({
  context,
  isWarming,
  result,
  onWarmup,
  onWarmupAll,
}: AudioWarmupPanelProps) {
  const { pick } = useUiLocale();
  const contextLabels: Record<PracticeContext, string> = {
    home: pick("ở nhà", "在家"),
    school: pick("trường học", "学校"),
    outside: pick("ra ngoài", "外出"),
  };

  return (
    <section className="rounded-md border border-blue-100 bg-blue-50 p-4">
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
        <div>
          <p className="text-sm font-semibold text-slate-950">
            {pick("Tối ưu tốc độ rule", "优化规则响应速度")}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {pick("Tạo sẵn audio cho các câu phổ biến trong ngữ cảnh ", "为以下场景的常用句预生成音频：")}
            <span className="font-semibold">{contextLabels[context]}</span>.
            {pick(
              " Sau khi cache, các lần thử sau sẽ nhanh hơn.",
              " 缓存后，后续测试会更快。",
            )}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={onWarmup}
            disabled={isWarming}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {isWarming
              ? pick("Đang tạo audio…", "正在生成音频…")
              : pick("Pre-cache ngữ cảnh", "预缓存当前场景")}
          </button>
          <button
            type="button"
            onClick={onWarmupAll}
            disabled={isWarming}
            className="rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            {pick("Pre-cache tất cả", "全部预缓存")}
          </button>
        </div>
      </div>

      {result ? (
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
          <div className="rounded bg-white p-2">
            <p className="text-xs uppercase text-slate-500">
              {pick("Tổng", "总数")}
            </p>
            <p className="font-semibold text-slate-950">{result.total}</p>
          </div>
          <div className="rounded bg-white p-2">
            <p className="text-xs uppercase text-slate-500">
              {pick("Đã có cache", "已有缓存")}
            </p>
            <p className="font-semibold text-slate-950">{result.cached}</p>
          </div>
          <div className="rounded bg-white p-2">
            <p className="text-xs uppercase text-slate-500">
              {pick("Mới tạo", "新生成")}
            </p>
            <p className="font-semibold text-slate-950">{result.generated}</p>
          </div>
          <div className="rounded bg-white p-2">
            <p className="text-xs uppercase text-slate-500">
              {pick("Lỗi", "失败")}
            </p>
            <p className="font-semibold text-slate-950">{result.failed}</p>
          </div>
          <div className="rounded bg-white p-2">
            <p className="text-xs uppercase text-slate-500">
              {pick("Thời gian", "耗时")}
            </p>
            <p className="font-semibold text-slate-950">
              {result.latencyMs}ms
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
