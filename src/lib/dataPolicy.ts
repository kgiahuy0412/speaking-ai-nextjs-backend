import "server-only";

export const CHILD_DATA_POLICY_VERSION = "2026-07-21";

function configuredRetentionDays() {
  const value = Number(process.env.CHILD_DATA_RETENTION_DAYS ?? "");
  return Number.isFinite(value) && value >= 1
    ? Math.min(3650, Math.floor(value))
    : null;
}

export function getChildDataRetentionDays() {
  return configuredRetentionDays();
}

export function getChildDataPolicy() {
  const historyRetentionDays = configuredRetentionDays();

  return {
    version: CHILD_DATA_POLICY_VERSION,
    historyRetentionDays,
    automaticDeletionEnabled: historyRetentionDays !== null,
    exportFormat: "json" as const,
    parentCanExport: true,
    parentCanDeleteIndividualTurns: true,
    parentCanDeleteAllDeviceHistory: true,
    notes: historyRetentionDays
      ? `Lịch sử quá ${historyRetentionDays} ngày được tự động xóa khi hệ thống truy cập dữ liệu.`
      : "Chưa bật tự động xóa theo thời gian; phụ huynh có thể xuất hoặc xóa dữ liệu thủ công từ admin.",
  };
}
