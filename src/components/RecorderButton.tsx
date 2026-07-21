"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";

type RecorderButtonProps = {
  isLoading: boolean;
  isRecording: boolean;
  onRecordToggle: () => void;
  onSampleSubmit: () => void;
};

export function RecorderButton({
  isLoading,
  isRecording,
  onRecordToggle,
  onSampleSubmit,
}: RecorderButtonProps) {
  const { pick } = useUiLocale();

  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="button"
        onClick={onRecordToggle}
        disabled={isLoading}
        className={`h-14 rounded-md px-6 text-base font-semibold text-white transition disabled:cursor-not-allowed disabled:bg-slate-400 ${
          isRecording
            ? "bg-red-600 hover:bg-red-700"
            : "bg-slate-950 hover:bg-slate-800"
        }`}
      >
        {isRecording
          ? pick("Dừng ghi âm", "停止录音")
          : pick("Bắt đầu ghi âm", "开始录音")}
      </button>
      <button
        type="button"
        onClick={onSampleSubmit}
        disabled={isLoading || isRecording}
        className="h-14 rounded-md border border-slate-300 bg-white px-6 text-base font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
      >
        {isLoading
          ? pick("Đang xử lý…", "处理中…")
          : pick("Gửi câu mẫu", "发送示例句")}
      </button>
    </div>
  );
}
