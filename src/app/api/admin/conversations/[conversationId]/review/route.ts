import { requireAdminAccess } from "@/lib/adminAuth";
import { removeAiEnglishText } from "@/lib/ai/textCache";
import {
  promoteEnglishRule,
  removePromotedRule,
} from "@/lib/ai/promotedRules";
import { synthesizeEnglishAudio } from "@/lib/ai/tts";
import {
  readConversationHistory,
  updateConversationHistory,
} from "@/lib/history";

export const runtime = "nodejs";

type ReviewRouteContext = {
  params: Promise<{ conversationId: string }>;
};

type ReviewBody = {
  clientId?: unknown;
  verdict?: unknown;
  correctedEnglish?: unknown;
  note?: unknown;
};

function normalizedEnglish(value: string) {
  return value.trim().toLocaleLowerCase("en");
}

export async function PATCH(request: Request, context: ReviewRouteContext) {
  const denied = requireAdminAccess(request);
  if (denied) {
    return denied;
  }

  const { conversationId } = await context.params;
  const body = (await request.json().catch(() => null)) as ReviewBody | null;
  const clientId =
    typeof body?.clientId === "string" && body.clientId.trim()
      ? body.clientId.trim()
      : undefined;

  if (
    !body ||
    !["unreviewed", "approved", "rejected"].includes(String(body.verdict))
  ) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Đánh giá không hợp lệ." } },
      { status: 400 },
    );
  }

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

  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  const correctedEnglish =
    typeof body.correctedEnglish === "string"
      ? body.correctedEnglish.trim()
      : "";

  if (correctedEnglish.length > 300) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Câu tiếng Anh quá dài." } },
      { status: 400 },
    );
  }

  const reviewedAt = new Date().toISOString();

  if (body.verdict === "unreviewed") {
    const updatedEnglish = correctedEnglish || conversation.englishText.trim();
    const wasCorrected =
      normalizedEnglish(updatedEnglish) !==
      normalizedEnglish(conversation.englishText);
    const removedRule = conversation.promotedToRule
      ? await removePromotedRule(
          conversation.vietnameseText,
          conversation.context,
          conversation.clientId,
        )
      : false;
    const updated = await updateConversationHistory({
      conversationId,
      clientId: conversation.clientId,
      englishText: updatedEnglish,
      originalEnglishText: wasCorrected
        ? conversation.originalEnglishText ?? conversation.englishText
        : conversation.originalEnglishText,
      reviewStatus: "unreviewed",
      reviewedAt,
      reviewedBy: "admin",
      reviewNote: note,
      promotedToRule: false,
      learningStatus: "observing",
      learningReason: "manual",
    });

    return Response.json({
      conversation: updated,
      learning: { removedRule },
    });
  }

  if (body.verdict === "rejected") {
    const [removedRule, removedCachedTexts] = await Promise.all([
      removePromotedRule(
        conversation.vietnameseText,
        conversation.context,
        conversation.clientId,
      ),
      removeAiEnglishText(
        conversation.vietnameseText,
        conversation.context,
        conversation.clientId,
      ),
    ]);
    const updated = await updateConversationHistory({
      conversationId,
      clientId: conversation.clientId,
      qualityApproved: false,
      reviewStatus: "rejected",
      reviewedAt,
      reviewedBy: "admin",
      reviewNote: note || "Admin đánh dấu sai ý.",
      promotedToRule: false,
      learningStatus: "rejected",
      learningReason: "negative_feedback",
      learningUseCount: 0,
    });

    return Response.json({
      conversation: updated,
      learning: { removedRule, removedCachedTexts },
    });
  }

  const approvedEnglish = correctedEnglish || conversation.englishText.trim();
  if (!approvedEnglish) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Câu tiếng Anh không được để trống." } },
      { status: 400 },
    );
  }

  const wasCorrected =
    normalizedEnglish(approvedEnglish) !==
    normalizedEnglish(conversation.englishText);
  const shouldPromote =
    Boolean(conversation.clientId) &&
    (wasCorrected ||
      ["openai", "cloudflare", "text_cache", "promoted_rule"].includes(
        conversation.textSource,
      ));
  let audio:
    | {
        audioUrl: string;
        source: "cache" | "openai_tts" | "cloudflare_tts";
      }
    | null = null;
  let audioWarning: string | null = null;

  if (shouldPromote) {
    await promoteEnglishRule(
      conversation.vietnameseText,
      approvedEnglish,
      conversation.context,
      {
        clientId: conversation.clientId,
        promotedBy: "manual",
      },
    );

    try {
      audio = await synthesizeEnglishAudio(approvedEnglish);
    } catch (error) {
      console.error("admin_review_audio_cache_failed", {
        conversationId,
        error,
      });
      audioWarning =
        "Đã lưu câu đúng nhưng chưa tạo được audio cache. Hệ thống sẽ thử lại khi sử dụng.";
    }
  }

  const updated = await updateConversationHistory({
    conversationId,
    clientId: conversation.clientId,
    englishText: approvedEnglish,
    originalEnglishText: wasCorrected
      ? conversation.originalEnglishText ?? conversation.englishText
      : conversation.originalEnglishText,
    audioUrl: audio?.audioUrl,
    audioSource: audio?.source,
    qualityApproved: true,
    reviewStatus: "approved",
    reviewedAt,
    reviewedBy: "admin",
    reviewNote:
      note ||
      (wasCorrected ? "Admin đã sửa và duyệt câu." : "Admin đã duyệt câu."),
    promotedToRule: shouldPromote || conversation.promotedToRule,
    learningStatus: shouldPromote ? "promoted" : "already_rule",
    learningReason: "manual",
  });

  return Response.json({
    conversation: updated,
    learning: {
      promoted: shouldPromote,
      scopedToClientId: conversation.clientId ?? null,
      audio,
      warning: audioWarning,
    },
  });
}
