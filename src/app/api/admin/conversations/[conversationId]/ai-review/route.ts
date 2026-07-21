import { requireAdminAccess } from "@/lib/adminAuth";
import { evaluateConversationQuality } from "@/lib/ai/conversationReview";
import {
  readConversationHistory,
  updateConversationHistory,
} from "@/lib/history";

export const runtime = "nodejs";

type AiReviewRouteContext = {
  params: Promise<{ conversationId: string }>;
};

export async function POST(request: Request, context: AiReviewRouteContext) {
  const denied = requireAdminAccess(request);
  if (denied) {
    return denied;
  }

  const { conversationId } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    clientId?: unknown;
    force?: unknown;
  } | null;
  const clientId =
    typeof body?.clientId === "string" && body.clientId.trim()
      ? body.clientId.trim()
      : undefined;
  const conversation = (await readConversationHistory(500)).find(
    (entry) =>
      entry.conversationId === conversationId &&
      (!clientId || entry.clientId === clientId),
  );

  if (!conversation) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Không tìm thấy lượt nói." } },
      { status: 404 },
    );
  }

  if (conversation.aiReview && body?.force !== true) {
    return Response.json({
      aiReview: conversation.aiReview,
      cached: true,
      conversation,
    });
  }

  try {
    const aiReview = await evaluateConversationQuality(conversation);
    const currentStatus =
      conversation.reviewStatus ??
      (conversation.qualityApproved === true
        ? "approved"
        : conversation.qualityApproved === false
          ? "rejected"
          : "unreviewed");
    const updated = await updateConversationHistory({
      conversationId,
      clientId: conversation.clientId,
      aiReview,
      reviewStatus:
        currentStatus === "unreviewed" && aiReview.verdict === "needs_review"
          ? "needs_review"
          : currentStatus,
    });

    return Response.json({ aiReview, cached: false, conversation: updated });
  } catch (error) {
    console.error("admin_ai_review_failed", { conversationId, error });
    return Response.json(
      {
        error: {
          code: "LLM_FAILED",
          message: "AI chưa đánh giá được câu này. Vui lòng thử lại sau.",
        },
      },
      { status: 502 },
    );
  }
}
