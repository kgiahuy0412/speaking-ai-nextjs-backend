import type {
  ConversationHistoryEntry,
  ConversationReviewStatus,
} from "@/types/conversation";

export type AdminReviewFilter =
  | "all"
  | ConversationReviewStatus
  | "ai_suggested";

export type DeviceProfile = {
  clientId: string;
  deviceName: string;
  childName?: string;
  createdAt: string;
  updatedAt: string;
};

export type DeviceSummary = DeviceProfile & {
  conversationCount: number;
  unreviewedCount: number;
  approvedCount: number;
  rejectedCount: number;
  lastSeenAt?: string;
};

export type AdminOverview = {
  devices: DeviceSummary[];
  conversations: ConversationHistoryEntry[];
  stats: {
    total: number;
    unreviewed: number;
    approved: number;
    rejected: number;
    needsReview: number;
    aiSuggested: number;
    learned: number;
  };
  latencyHealth: {
    sampleCount: number;
    p95FirstAudioMs: number;
    thresholdMs: number;
    status: "healthy" | "warning" | "insufficient_data";
    message: string;
  };
  dataPolicy: {
    version: string;
    historyRetentionDays: number | null;
    automaticDeletionEnabled: boolean;
    exportFormat: "json";
    parentCanExport: boolean;
    parentCanDeleteIndividualTurns: boolean;
    parentCanDeleteAllDeviceHistory: boolean;
    notes: string;
  };
  filters: {
    clientId?: string;
    status: AdminReviewFilter;
    limit: number;
  };
  securityMode: "local-development" | "admin-token" | "not-configured";
  generatedAt: string;
};
