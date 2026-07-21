import { readConversationHistory } from "@/lib/history";
import { buildLatencyReport } from "@/lib/reports";
import { requireAdminAccess } from "@/lib/adminAuth";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const denied = requireAdminAccess(request);
  if (denied) {
    return withRequestId(denied, requestId);
  }

  const conversations = await readConversationHistory(200);
  const report = buildLatencyReport(conversations);
  const alert = report.alerts[0];

  if (alert) {
    logEvent("warn", "latency_p95_alert", { requestId, ...alert });
  }

  return withRequestId(Response.json({ report }), requestId);
}
