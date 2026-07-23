import { promoteEnglishRule } from "@/lib/ai/promotedRules";
import { synthesizeEnglishAudio } from "@/lib/ai/tts";
import {
  readConversationHistory,
  updateConversationHistory,
} from "@/lib/history";
import { requireAdminAccess } from "@/lib/adminAuth";

export const runtime = "nodejs";

type PromoteRequest = {
  conversationId?: string;
  clientId?: string;
};

export async function POST(request: Request) {
  const denied = requireAdminAccess(request);
  if (denied) {
    return denied;
  }

  const body = (await request.json()) as PromoteRequest;

  if (!body.conversationId) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Thiếu conversationId." } },
      { status: 400 },
    );
  }

  const conversation = (await readConversationHistory(1000)).find(
    (entry) =>
      entry.conversationId === body.conversationId &&
      (!body.clientId?.trim() || entry.clientId === body.clientId.trim()),
  );

  if (!conversation) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Không tìm thấy lượt AI." } },
      { status: 404 },
    );
  }

  if (
    !["cloudflare", "openai", "text_cache"].includes(
      conversation.textSource,
    )
  ) {
    return Response.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Chỉ nâng cấp câu do AI hoặc text cache tạo ra.",
        },
      },
      { status: 400 },
    );
  }

  const rule = await promoteEnglishRule(
    conversation.vietnameseText,
    conversation.englishText,
    conversation.context,
    {
      clientId: conversation.clientId,
      promotedBy: "manual",
    },
  );
  const audio = await synthesizeEnglishAudio(conversation.englishText);
  await updateConversationHistory({
    conversationId: conversation.conversationId,
    clientId: conversation.clientId,
    qualityApproved: true,
    reviewStatus: "approved",
    reviewedAt: new Date().toISOString(),
    reviewedBy: "practice",
    reviewNote: "Được nâng thành rule thủ công từ màn hình kiểm thử.",
    promotedToRule: true,
    learningStatus: "promoted",
    learningReason: "manual",
  });

  return Response.json({ rule, audio });
}
