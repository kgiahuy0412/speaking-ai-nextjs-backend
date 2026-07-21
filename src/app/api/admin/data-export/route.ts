import { requireAdminAccess } from "@/lib/adminAuth";
import { getChildDataPolicy } from "@/lib/dataPolicy";
import { readDeviceProfiles } from "@/lib/deviceProfiles";
import { readConversationHistory } from "@/lib/history";
import { getPromotedRulesForClient } from "@/lib/ai/promotedRules";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

function safeDownloadName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "device";
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const denied = requireAdminAccess(request);
  if (denied) {
    return withRequestId(denied, requestId);
  }

  const clientId = new URL(request.url).searchParams.get("clientId")?.trim();
  if (!clientId) {
    return withRequestId(
      Response.json(
        {
          error: {
            code: "BAD_REQUEST",
            message: "Vui lòng chọn thiết bị cần xuất dữ liệu.",
            requestId,
          },
        },
        { status: 400 },
      ),
      requestId,
    );
  }

  const [history, profiles, promotedRules] = await Promise.all([
    readConversationHistory(500),
    readDeviceProfiles(),
    getPromotedRulesForClient(clientId),
  ]);
  const conversations = history.filter((entry) => entry.clientId === clientId);
  const exportedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    exportedAt,
    dataPolicy: getChildDataPolicy(),
    device: profiles[clientId] ?? null,
    conversations,
    promotedRules,
  };

  logEvent("info", "child_data_exported", {
    requestId,
    clientId,
    conversationCount: conversations.length,
    promotedRuleCount: promotedRules.length,
  });

  return withRequestId(
    new Response(`${JSON.stringify(payload, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ai-speaking-${safeDownloadName(clientId)}.json"`,
        "Cache-Control": "private, no-store",
      },
    }),
    requestId,
  );
}
