"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";
import type { ConversationHistoryEntry } from "@/types/conversation";

type ConversationHistoryPanelProps = {
  conversations: ConversationHistoryEntry[];
  onReview?: (conversationId: string, approved: boolean) => void;
  onPromote?: (conversationId: string) => void;
};

function formatTime(value: string, locale: "vi" | "zh") {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function ConversationHistoryPanel({
  conversations,
  onReview,
  onPromote,
}: ConversationHistoryPanelProps) {
  const { locale, pick } = useUiLocale();
  const contextLabels = {
    home: pick("Ở nhà", "在家"),
    school: pick("Trường học", "学校"),
    outside: pick("Ra ngoài", "外出"),
  };

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-950">
            {pick("Lịch sử thử nghiệm gần nhất", "最近测试记录")}
          </p>
          <p className="text-xs text-slate-500">
            {pick(
              "Lưu local để so sánh tốc độ ASR, LLM và TTS.",
              "保存在本地，用于比较 ASR、LLM 和 TTS 的速度。",
            )}
          </p>
        </div>
        <p className="text-xs font-semibold uppercase text-slate-500">
          {conversations.length} {pick("lượt", "条")}
        </p>
      </div>

      {conversations.length === 0 ? (
        <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-500">
          {pick(
            "Chưa có lịch sử. Hãy gửi câu mẫu hoặc ghi âm một lượt.",
            "暂无记录，请发送示例句或录制一次语音。",
          )}
        </p>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs uppercase text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3 font-semibold">{pick("Thời gian", "时间")}</th>
                <th className="py-2 pr-3 font-semibold">{pick("Ngữ cảnh", "场景")}</th>
                <th className="py-2 pr-3 font-semibold">{pick("Trẻ nói", "孩子说")}</th>
                <th className="py-2 pr-3 font-semibold">{pick("Tiếng Anh", "英文")}</th>
                <th className="py-2 pr-3 font-semibold">{pick("Audio đầu", "首个音频")}</th>
                <th className="py-2 pr-3 font-semibold">{pick("Chi tiết", "详情")}</th>
                <th className="py-2 pr-3 font-semibold">{pick("Đánh giá", "审核")}</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((item) => (
                <tr
                  key={item.conversationId}
                  className="border-b border-slate-100 align-top last:border-0"
                >
                  <td className="py-3 pr-3 text-slate-600">
                    {formatTime(item.createdAt, locale)}
                  </td>
                  <td className="py-3 pr-3 text-slate-600">
                    {contextLabels[item.context]}
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                      {item.inputMode}
                    </span>
                    <span className="ml-1 rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-700">
                      {item.asrMode ?? "old"}
                    </span>
                    <span className="ml-1 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                      {item.processingMode ?? "old"}
                    </span>
                    <span className="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                      {item.textSource ?? "old"}
                    </span>
                    <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                      {item.audioSource ?? "old"}
                    </span>
                  </td>
                  <td className="py-3 pr-3 font-medium text-slate-950">
                    {item.vietnameseText}
                  </td>
                  <td className="py-3 pr-3 text-blue-700">
                    {item.englishText}
                  </td>
                  <td className="py-3 pr-3 font-semibold text-slate-950">
                    {item.latency.timeToFirstAudioMs}ms
                  </td>
                  <td className="py-3 pr-3 text-xs text-slate-500">
                    ASR {item.latency.asrMs}ms / LLM {item.latency.llmMs}ms /
                    TTS {item.latency.ttsMs}ms
                  </td>
                  <td className="py-3 pr-3">
                    <div className="flex min-w-[190px] gap-2">
                      <button
                        type="button"
                        onClick={() => onReview?.(item.conversationId, true)}
                        className={`rounded border px-2 py-1 text-xs font-semibold ${
                          item.qualityApproved === true
                            ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                            : "border-slate-300 text-slate-600"
                        }`}
                      >
                        {pick("Đúng ý", "意思正确")}
                      </button>
                      <button
                        type="button"
                        onClick={() => onReview?.(item.conversationId, false)}
                        className={`rounded border px-2 py-1 text-xs font-semibold ${
                          item.qualityApproved === false
                            ? "border-red-600 bg-red-50 text-red-700"
                            : "border-slate-300 text-slate-600"
                        }`}
                      >
                        {pick("Sai ý", "意思错误")}
                      </button>
                      {["openai", "cloudflare", "text_cache"].includes(
                        item.textSource,
                      ) ? (
                        <button
                          type="button"
                          onClick={() => onPromote?.(item.conversationId)}
                          disabled={item.promotedToRule}
                          className="rounded border border-blue-300 px-2 py-1 text-xs font-semibold text-blue-700 disabled:text-slate-400"
                        >
                          {item.promotedToRule
                            ? pick("Đã học", "已学习")
                            : pick("Học rule", "学习规则")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
