import {
  clearConversationHistory,
  claimLegacyConversationHistory,
  deleteConversationHistoryEntry,
  readConversationHistory,
  updateConversationHistory,
} from "@/lib/history";
import type { ConversationHistoryPatch } from "@/types/conversation";
import {
  learnFromPositiveFeedback,
  unlearnFromNegativeFeedback,
} from "@/lib/ai/adaptiveLearning";
import { requireAdminAccess } from "@/lib/adminAuth";
import { getRequestId, logEvent } from "@/lib/observability";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedLimit = Number(
    url.searchParams.get("limit") ?? "",
  );
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.floor(requestedLimit)
      : 50;
  const clientId = url.searchParams.get("clientId")?.trim() || undefined;
  if (!clientId) {
    const denied = requireAdminAccess(request);
    if (denied) {
      return denied;
    }
  }
  const claimedLegacyItems = clientId
    ? await claimLegacyConversationHistory(clientId)
    : 0;
  const history = await readConversationHistory(clientId ? 500 : limit);
  const conversations = (
    clientId
      ? history.filter((entry) => entry.clientId === clientId)
      : history
  ).slice(0, limit);

  return Response.json({
    conversations,
    learning: {
      scope: clientId ? "device" : "legacy",
      clientId,
      claimedLegacyItems,
    },
  });
}

export async function DELETE(request: Request) {
  const requestId = getRequestId(request);
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  const clientId = url.searchParams.get("clientId")?.trim() || undefined;
  if (!clientId) {
    const denied = requireAdminAccess(request);
    if (denied) {
      return denied;
    }
  }

  if (conversationId) {
    const deleted = await deleteConversationHistoryEntry(
      conversationId,
      clientId,
    );

    logEvent("info", "child_history_item_deleted", {
      requestId,
      conversationId,
      deleted,
    });
    return Response.json({ deleted, requestId });
  }

  await clearConversationHistory(clientId);
  logEvent("info", "child_history_cleared", { requestId, clientId });

  return Response.json({
    conversations: [],
    requestId,
  });
}

export async function PATCH(request: Request) {
  const requestId = getRequestId(request);
  const body = (await request.json()) as Partial<ConversationHistoryPatch>;

  if (!body.clientId?.trim()) {
    const denied = requireAdminAccess(request);
    if (denied) {
      return denied;
    }
  }

  if (!body.conversationId) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Thiếu conversationId." } },
      { status: 400 },
    );
  }

  const historyPatch: ConversationHistoryPatch = {
    conversationId: body.conversationId,
    clientId: body.clientId?.trim() || undefined,
    latency: body.latency,
    qualityApproved: body.qualityApproved,
    reviewStatus:
      typeof body.qualityApproved === "boolean"
        ? body.qualityApproved
          ? "approved"
          : "rejected"
        : body.reviewStatus,
    reviewedAt:
      typeof body.qualityApproved === "boolean"
        ? new Date().toISOString()
        : body.reviewedAt,
    reviewedBy:
      typeof body.qualityApproved === "boolean"
        ? "practice"
        : body.reviewedBy,
    reviewNote: body.reviewNote,
    promotedToRule: body.promotedToRule,
  };
  let conversation = await updateConversationHistory(historyPatch);

  // Conversation history is persisted after the main response. Playback can
  // begin before that background write finishes, especially for cached audio.
  // Retry only telemetry patches so the UI remains completely non-blocking.
  if (!conversation && body.latency) {
    for (const delayMs of [75, 150, 300]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      conversation = await updateConversationHistory(historyPatch);
      if (conversation) {
        break;
      }
    }
  }

  if (!conversation) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Không tìm thấy lượt nói." } },
      { status: 404 },
    );
  }

  let learning = null;

  if (typeof body.qualityApproved === "boolean") {
    try {
      learning = body.qualityApproved
        ? await learnFromPositiveFeedback(conversation)
        : await unlearnFromNegativeFeedback(conversation);
      conversation =
        (await updateConversationHistory({
          conversationId: body.conversationId,
          clientId: body.clientId?.trim() || undefined,
          promotedToRule: learning.promoted,
          learningStatus: learning.status,
          learningReason: body.qualityApproved
            ? "positive_feedback"
            : "negative_feedback",
          learningUseCount: learning.useCount,
        })) ?? conversation;
    } catch (error) {
      console.error("adaptive_learning_feedback_failed", {
        conversationId: body.conversationId,
        qualityApproved: body.qualityApproved,
        error,
      });
    }
  }

  if (body.latency?.audioStartedAfterStopMs !== undefined) {
    logEvent("info", "playback_latency_recorded", {
      requestId,
      conversationId: body.conversationId,
      audioStartedAfterStopMs: body.latency.audioStartedAfterStopMs,
      audioLoadMs: body.latency.audioLoadMs,
      audioFromDeviceCache: body.latency.audioFromDeviceCache,
    });
  }

  return Response.json({ conversation, learning, requestId });
}
