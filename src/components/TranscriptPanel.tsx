"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";

type TranscriptPanelProps = {
  vietnameseText?: string;
  englishText?: string;
};

export function TranscriptPanel({
  vietnameseText,
  englishText,
}: TranscriptPanelProps) {
  const { pick } = useUiLocale();

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-500">
          {pick("Trẻ nói", "孩子说")}
        </p>
        <p className="mt-2 text-lg font-medium text-slate-950">
          {vietnameseText ?? pick("Chưa có bản chép lời", "暂无转写文本")}
        </p>
      </div>
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <p className="text-xs font-semibold uppercase text-slate-500">
          {pick("Câu tiếng Anh", "英文句子")}
        </p>
        <p className="mt-2 text-lg font-medium text-blue-700">
          {englishText ?? pick("Chưa có câu trả lời", "暂无回答")}
        </p>
      </div>
    </div>
  );
}
