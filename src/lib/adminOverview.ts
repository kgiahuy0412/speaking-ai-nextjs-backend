import "server-only";

import { getAdminSecurityMode } from "@/lib/adminAuth";
import {
  createDefaultDeviceProfile,
  readDeviceProfiles,
} from "@/lib/deviceProfiles";
import { readConversationHistory } from "@/lib/history";
import type {
  AdminOverview,
  AdminReviewFilter,
  DeviceSummary,
} from "@/types/admin";
import type {
  ConversationHistoryEntry,
  ConversationReviewStatus,
} from "@/types/conversation";
import { buildLatencyReport } from "@/lib/reports";
import { getChildDataPolicy } from "@/lib/dataPolicy";

export function getConversationReviewStatus(
  conversation: ConversationHistoryEntry,
): ConversationReviewStatus {
  if (conversation.reviewStatus) {
    return conversation.reviewStatus;
  }

  if (conversation.qualityApproved === true) {
    return "approved";
  }

  if (conversation.qualityApproved === false) {
    return "rejected";
  }

  return "unreviewed";
}

function entryClientId(entry: ConversationHistoryEntry) {
  return entry.clientId?.trim() || "legacy";
}

function matchesStatus(
  entry: ConversationHistoryEntry,
  status: AdminReviewFilter,
) {
  if (status === "all") {
    return true;
  }

  if (status === "ai_suggested") {
    return Boolean(entry.aiReview);
  }

  return getConversationReviewStatus(entry) === status;
}

export async function getAdminOverview(options: {
  clientId?: string;
  status?: AdminReviewFilter;
  limit?: number;
} = {}): Promise<AdminOverview> {
  const status = options.status ?? "all";
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 200), 500));
  const [history, profiles] = await Promise.all([
    readConversationHistory(500),
    readDeviceProfiles(),
  ]);
  const allClientIds = new Set([
    ...Object.keys(profiles),
    ...history.map(entryClientId),
  ]);

  const devices: DeviceSummary[] = [...allClientIds].map((clientId) => {
    const conversations = history.filter(
      (entry) => entryClientId(entry) === clientId,
    );
    const profile = profiles[clientId] ?? createDefaultDeviceProfile(clientId);

    return {
      ...profile,
      conversationCount: conversations.length,
      unreviewedCount: conversations.filter(
        (entry) => getConversationReviewStatus(entry) === "unreviewed",
      ).length,
      approvedCount: conversations.filter(
        (entry) => getConversationReviewStatus(entry) === "approved",
      ).length,
      rejectedCount: conversations.filter(
        (entry) => getConversationReviewStatus(entry) === "rejected",
      ).length,
      lastSeenAt: conversations[0]?.createdAt,
    };
  });

  devices.sort((left, right) =>
    (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? ""),
  );

  const scopedHistory = options.clientId
    ? history.filter((entry) => entryClientId(entry) === options.clientId)
    : history;
  const conversations = scopedHistory
    .filter((entry) => matchesStatus(entry, status))
    .slice(0, limit);
  const latencyReport = buildLatencyReport(scopedHistory);
  const latencyAlert = latencyReport.alerts[0];
  const latencyHealth: AdminOverview["latencyHealth"] = latencyAlert
    ? {
        sampleCount: latencyAlert.sampleCount,
        p95FirstAudioMs: latencyAlert.actualMs,
        thresholdMs: latencyAlert.thresholdMs,
        status: "warning",
        message: latencyAlert.message,
      }
    : {
        sampleCount: latencyReport.measuredTurns,
        p95FirstAudioMs: latencyReport.p95FirstAudioMs,
        thresholdMs: Number(process.env.LATENCY_P95_ALERT_MS ?? 2500),
        status:
          latencyReport.measuredTurns >= 10 ? "healthy" : "insufficient_data",
        message:
          latencyReport.measuredTurns >= 10
            ? "P95 đang nằm trong ngưỡng theo dõi."
            : "Cần ít nhất 10 lượt có telemetry phát audio để đánh giá P95.",
      };

  return {
    devices,
    conversations,
    stats: {
      total: scopedHistory.length,
      unreviewed: scopedHistory.filter(
        (entry) => getConversationReviewStatus(entry) === "unreviewed",
      ).length,
      approved: scopedHistory.filter(
        (entry) => getConversationReviewStatus(entry) === "approved",
      ).length,
      rejected: scopedHistory.filter(
        (entry) => getConversationReviewStatus(entry) === "rejected",
      ).length,
      needsReview: scopedHistory.filter(
        (entry) =>
          getConversationReviewStatus(entry) === "needs_review" ||
          entry.aiReview?.verdict === "needs_review",
      ).length,
      aiSuggested: scopedHistory.filter((entry) => entry.aiReview).length,
      learned: scopedHistory.filter((entry) => entry.promotedToRule).length,
    },
    latencyHealth,
    dataPolicy: getChildDataPolicy(),
    filters: {
      clientId: options.clientId,
      status,
      limit,
    },
    securityMode: getAdminSecurityMode(),
    generatedAt: new Date().toISOString(),
  };
}
