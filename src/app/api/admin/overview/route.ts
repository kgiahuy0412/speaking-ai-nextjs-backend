import { getAdminOverview } from "@/lib/adminOverview";
import { requireAdminAccess } from "@/lib/adminAuth";
import type { AdminReviewFilter } from "@/types/admin";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

const validStatuses = new Set<AdminReviewFilter>([
  "all",
  "unreviewed",
  "approved",
  "rejected",
  "needs_review",
  "ai_suggested",
]);

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const denied = requireAdminAccess(request);
  if (denied) {
    return withRequestId(denied, requestId);
  }

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status") ?? "all";
  const status = validStatuses.has(rawStatus as AdminReviewFilter)
    ? (rawStatus as AdminReviewFilter)
    : "all";
  const rawLimit = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
  const clientId = url.searchParams.get("clientId")?.trim() || undefined;

  const overview = await getAdminOverview({ clientId, status, limit });
  if (overview.latencyHealth.status === "warning") {
    logEvent("warn", "latency_p95_alert", {
      requestId,
      ...overview.latencyHealth,
    });
  }

  return withRequestId(Response.json({ overview }), requestId);
}
