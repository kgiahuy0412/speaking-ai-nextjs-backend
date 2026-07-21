"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";
import type { PracticeContext } from "@/types/conversation";
import { mvpTestPlan } from "@/lib/testPlan";

type MvpTestPlanPanelProps = {
  context: PracticeContext;
  isLoading: boolean;
  onSubmitSentence: (sentence: string) => void;
};

export function MvpTestPlanPanel({
  context,
  isLoading,
  onSubmitSentence,
}: MvpTestPlanPanelProps) {
  const { pick } = useUiLocale();
  const sentences = mvpTestPlan[context];
  const groups = [
    { group: "A", label: pick("A · Câu theo rule", "A · 规则句") },
    { group: "B", label: pick("B · Câu cần AI", "B · 需要 AI 的句子") },
    { group: "C", label: pick("C · Câu fallback", "C · 回退句") },
  ].map(({ group, label }) => ({
      group,
      label,
      sentences: sentences.filter((item) => item.group === group),
    }));
  const targetItems = [
    pick("Mỗi câu kiểm tra 2–3 lần", "每句测试 2–3 次"),
    pick("Rule nên dưới 2 giây", "规则应低于 2 秒"),
    pick("AI chấp nhận 2–3 giây", "AI 可接受 2–3 秒"),
    pick("Fallback chỉ dùng khi câu khó hiểu", "仅在语句难以理解时使用回退"),
  ];

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-4 flex flex-col justify-between gap-3 md:flex-row md:items-start">
        <div>
          <p className="text-sm font-semibold text-slate-950">
            {pick("Bộ câu kiểm tra MVP", "MVP 测试句集")}
          </p>
          <p className="text-xs text-slate-500">
            {pick(
              "Chọn từng câu để đo độ trễ theo kịch bản. Các lượt này vẫn được lưu vào lịch sử.",
              "选择句子按场景测量延迟，这些测试记录仍会保存到历史中。",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {targetItems.map((item) => (
            <span
              key={item}
              className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600"
            >
              {item}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {groups.map((group) => (
          <div key={group.group} className="rounded-md border border-slate-100">
            <div className="border-b border-slate-100 px-3 py-2">
              <p className="text-xs font-semibold uppercase text-slate-500">
                {group.label}
              </p>
            </div>
            <div className="flex max-h-64 flex-col gap-2 overflow-auto p-3">
              {group.sentences.map((item) => (
                <button
                  key={item.id}
                  className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm font-medium text-slate-800 transition hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isLoading}
                  type="button"
                  onClick={() => onSubmitSentence(item.text)}
                >
                  <span>{item.text}</span>
                  <span className="mt-1 block text-xs font-normal text-slate-500">
                    {pick("kỳ vọng", "预期")}: {item.expectedMode}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
