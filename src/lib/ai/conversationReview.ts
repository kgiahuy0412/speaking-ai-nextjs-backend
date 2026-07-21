import "server-only";

import type {
  ConversationAiReview,
  ConversationHistoryEntry,
} from "@/types/conversation";
import { getOpenAIClient } from "./openai";

type RawReview = {
  verdict?: unknown;
  confidence?: unknown;
  reason?: unknown;
  suggestedEnglish?: unknown;
};

const validVerdicts = new Set(["approved", "rejected", "needs_review"]);

function reviewModel() {
  return (
    process.env.OPENAI_REVIEW_MODEL ??
    process.env.OPENAI_FAST_TEXT_MODEL ??
    "gpt-4o-mini"
  );
}

function parseJsonOutput(value: string) {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned) as RawReview;
}

function normalizeReview(raw: RawReview, model: string): ConversationAiReview {
  const verdict =
    typeof raw.verdict === "string" && validVerdicts.has(raw.verdict)
      ? (raw.verdict as ConversationAiReview["verdict"])
      : "needs_review";
  const confidenceValue = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : 0;
  const reason =
    typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason.trim().slice(0, 500)
      : "AI chưa đưa ra lý do rõ ràng, cần người quản trị kiểm tra.";
  const suggestedEnglish =
    typeof raw.suggestedEnglish === "string" && raw.suggestedEnglish.trim()
      ? raw.suggestedEnglish.trim().slice(0, 300)
      : undefined;

  return {
    verdict,
    confidence,
    reason,
    suggestedEnglish,
    model,
    reviewedAt: new Date().toISOString(),
  };
}

export async function evaluateConversationQuality(
  conversation: ConversationHistoryEntry,
) {
  const client = getOpenAIClient();
  const model = reviewModel();
  const response = await client.responses.create({
    model,
    instructions:
      "Bạn là người kiểm duyệt bản dịch cho trẻ em. Đánh giá câu tiếng Anh có giữ đúng ý câu tiếng Việt trong đúng ngữ cảnh hay không. Không được giả định rằng bản chép lời tiếng Việt khớp hoàn toàn với audio. Trả về JSON thuần, không markdown, gồm verdict là approved, rejected hoặc needs_review; confidence từ 0 đến 1; reason ngắn bằng tiếng Việt; suggestedEnglish là câu tiếng Anh ngắn đã sửa hoặc chuỗi rỗng nếu không cần sửa. Nếu câu tiếng Việt mơ hồ hoặc thiếu ngữ cảnh, chọn needs_review.",
    input: JSON.stringify({
      context: conversation.context,
      vietnameseText: conversation.vietnameseText,
      englishText: conversation.englishText,
      textSource: conversation.textSource,
    }),
    max_output_tokens: 180,
  });
  const review = normalizeReview(parseJsonOutput(response.output_text), model);

  return {
    ...review,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
  } satisfies ConversationAiReview;
}
