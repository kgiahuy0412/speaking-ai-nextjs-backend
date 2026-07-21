"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import {
  useUiLocale,
  type UiLocale,
} from "@/components/UiLocaleProvider";
import type {
  AdminOverview,
  AdminReviewFilter,
  DeviceSummary,
} from "@/types/admin";
import type {
  ConversationHistoryEntry,
  ConversationReviewStatus,
  PracticeContext,
} from "@/types/conversation";

function localeText(locale: UiLocale, vietnamese: string, chinese: string) {
  return locale === "zh" ? chinese : vietnamese;
}

function getResponseError(data: unknown, fallback: string) {
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    data.error &&
    typeof data.error === "object" &&
    "message" in data.error &&
    typeof data.error.message === "string"
  ) {
    return data.error.message;
  }

  return fallback;
}

function reviewStatus(
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

function statusLabel(status: ConversationReviewStatus, locale: UiLocale) {
  return {
    unreviewed: localeText(locale, "Chưa đánh giá", "未审核"),
    approved: localeText(locale, "Đã duyệt đúng", "已确认正确"),
    rejected: localeText(locale, "Đã đánh dấu sai", "已标记错误"),
    needs_review: localeText(locale, "Cần kiểm tra", "需要检查"),
  }[status];
}

function statusClass(status: ConversationReviewStatus) {
  return {
    unreviewed: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    approved: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    rejected: "border-rose-400/30 bg-rose-400/10 text-rose-200",
    needs_review: "border-violet-400/30 bg-violet-400/10 text-violet-200",
  }[status];
}

function aiVerdictLabel(
  verdict: "approved" | "rejected" | "needs_review",
  locale: UiLocale,
) {
  return {
    approved: localeText(locale, "AI nghiêng về đúng", "AI 倾向于正确"),
    rejected: localeText(locale, "AI nghiêng về sai", "AI 倾向于错误"),
    needs_review: localeText(locale, "AI cần người kiểm tra", "AI 建议人工检查"),
  }[verdict];
}

function formatDate(value: string | undefined, locale: UiLocale) {
  if (!value) {
    return localeText(locale, "Chưa có dữ liệu", "暂无数据");
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "vi-VN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function shortClientId(clientId?: string) {
  if (!clientId) {
    return "legacy";
  }

  return clientId.length > 22 ? `${clientId.slice(0, 22)}…` : clientId;
}

function deviceTitle(device: DeviceSummary | undefined, locale: UiLocale) {
  if (!device) {
    return localeText(locale, "Thiết bị chưa đặt tên", "未命名设备");
  }

  return device.childName
    ? `${device.childName} · ${device.deviceName}`
    : device.deviceName;
}

export function AdminDashboard() {
  const { locale, pick } = useUiLocale();
  const contextLabels: Record<PracticeContext, string> = {
    home: pick("Ở nhà", "在家"),
    school: pick("Trường học", "学校"),
    outside: pick("Bên ngoài", "外出"),
  };
  const statusOptions: Array<{ value: AdminReviewFilter; label: string }> = [
    { value: "unreviewed", label: pick("Chưa đánh giá", "未审核") },
    { value: "needs_review", label: pick("Cần kiểm tra", "需要检查") },
    { value: "ai_suggested", label: pick("Đã có AI gợi ý", "已有 AI 建议") },
    { value: "approved", label: pick("Đã duyệt đúng", "已确认正确") },
    { value: "rejected", label: pick("Đã đánh dấu sai", "已标记错误") },
    { value: "all", label: pick("Tất cả", "全部") },
  ];
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [status, setStatus] = useState<AdminReviewFilter>("unreviewed");
  const [search, setSearch] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [deviceName, setDeviceName] = useState("");
  const [childName, setChildName] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const adminHeaders = useCallback(
    (withJson = false) => {
      const headers: Record<string, string> = {};

      if (withJson) {
        headers["Content-Type"] = "application/json";
      }
      if (adminToken) {
        headers["x-admin-token"] = adminToken;
      }

      return headers;
    },
    [adminToken],
  );

  const loadOverview = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ status, limit: "200" });
      if (selectedClientId) {
        params.set("clientId", selectedClientId);
      }
      const response = await fetch(`/api/admin/overview?${params}`, {
        cache: "no-store",
        headers: adminHeaders(),
      });
      const data = (await response.json().catch(() => null)) as {
        overview?: AdminOverview;
      } | null;

      if (!response.ok || !data?.overview) {
        throw new Error(
          getResponseError(
            data,
            pick("Không tải được dữ liệu quản trị.", "无法加载管理数据。"),
          ),
        );
      }

      setOverview(data.overview);
      setDrafts((current) => {
        const next = { ...current };
        data.overview?.conversations.forEach((conversation) => {
          if (!(conversation.conversationId in next)) {
            next[conversation.conversationId] = conversation.englishText;
          }
        });
        return next;
      });

      const nextSelectedClientId =
        selectedClientId ||
        (data.overview.devices.length === 1
          ? data.overview.devices[0].clientId
          : "");
      const nextSelectedDevice = data.overview.devices.find(
        (device) => device.clientId === nextSelectedClientId,
      );

      if (!selectedClientId && nextSelectedClientId) {
        setSelectedClientId(nextSelectedClientId);
      }
      if (nextSelectedDevice) {
        setDeviceName(nextSelectedDevice.deviceName);
        setChildName(nextSelectedDevice.childName ?? "");
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : pick("Không tải được dữ liệu quản trị.", "无法加载管理数据。"),
      );
    } finally {
      setIsLoading(false);
    }
  }, [adminHeaders, pick, selectedClientId, status]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const savedToken =
        window.sessionStorage.getItem("admin-api-token") ?? "";
      setAdminToken(savedToken);
      setTokenInput(savedToken);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadOverview();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadOverview]);

  const selectedDevice = overview?.devices.find(
    (device) => device.clientId === selectedClientId,
  );

  function selectDevice(clientId: string) {
    setSelectedClientId(clientId);
    const device = overview?.devices.find((item) => item.clientId === clientId);
    setDeviceName(device?.deviceName ?? "");
    setChildName(device?.childName ?? "");
  }

  const devicesById = useMemo(
    () =>
      new Map(
        overview?.devices.map((device) => [device.clientId, device]) ?? [],
      ),
    [overview?.devices],
  );

  const visibleConversations = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("vi");
    if (!normalizedSearch) {
      return overview?.conversations ?? [];
    }

    return (overview?.conversations ?? []).filter((conversation) =>
      [
        conversation.vietnameseText,
        conversation.englishText,
        conversation.clientId ?? "legacy",
      ].some((value) => value.toLocaleLowerCase("vi").includes(normalizedSearch)),
    );
  }, [overview?.conversations, search]);

  function saveAdminToken() {
    const token = tokenInput.trim();
    window.sessionStorage.setItem("admin-api-token", token);
    setAdminToken(token);
    setNotice(
      token
        ? pick("Đã lưu mã quản trị cho phiên này.", "已为本次会话保存管理员令牌。")
        : pick("Đã dùng chế độ local.", "已切换为本地模式。"),
    );
  }

  async function reviewConversation(
    conversation: ConversationHistoryEntry,
    verdict: "approved" | "rejected",
  ) {
    const actionKey = `${conversation.conversationId}:${verdict}`;
    setPendingAction(actionKey);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/admin/conversations/${encodeURIComponent(conversation.conversationId)}/review`,
        {
          method: "PATCH",
          headers: adminHeaders(true),
          body: JSON.stringify({
            clientId: conversation.clientId,
            verdict,
            correctedEnglish: drafts[conversation.conversationId],
            note: notes[conversation.conversationId],
          }),
        },
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          getResponseError(data, pick("Không lưu được đánh giá.", "无法保存审核结果。")),
        );
      }

      const warning =
        data &&
        typeof data === "object" &&
        "learning" in data &&
        data.learning &&
        typeof data.learning === "object" &&
        "warning" in data.learning &&
        typeof data.learning.warning === "string"
          ? data.learning.warning
          : null;
      setNotice(
        warning ??
          (verdict === "approved"
            ? pick(
                "Đã duyệt và lưu cách nói cho thiết bị này.",
                "已确认并为该设备保存此表达。",
              )
            : pick(
                "Đã đánh dấu sai và gỡ dữ liệu học liên quan.",
                "已标记为错误并移除相关学习数据。",
              )),
      );
      await loadOverview();
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : pick("Không lưu được đánh giá.", "无法保存审核结果。"),
      );
    } finally {
      setPendingAction("");
    }
  }

  async function requestAiReview(conversation: ConversationHistoryEntry) {
    const actionKey = `${conversation.conversationId}:ai`;
    setPendingAction(actionKey);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/admin/conversations/${encodeURIComponent(conversation.conversationId)}/ai-review`,
        {
          method: "POST",
          headers: adminHeaders(true),
          body: JSON.stringify({ clientId: conversation.clientId }),
        },
      );
      const data = (await response.json().catch(() => null)) as {
        aiReview?: { suggestedEnglish?: string };
        cached?: boolean;
      } | null;

      if (!response.ok || !data?.aiReview) {
        throw new Error(
          getResponseError(data, pick("AI chưa đánh giá được câu.", "AI 暂时无法审核该句。")),
        );
      }

      if (data.aiReview.suggestedEnglish) {
        setDrafts((current) => ({
          ...current,
          [conversation.conversationId]:
            data.aiReview?.suggestedEnglish ?? conversation.englishText,
        }));
      }
      setNotice(
        data.cached
          ? pick(
              "Đã dùng lại kết quả AI trước đó, không phát sinh lượt đánh giá mới.",
              "已复用之前的 AI 结果，没有产生新的审核调用。",
            )
          : pick(
              "AI đã đưa ra gợi ý. Admin vẫn là người quyết định cuối cùng.",
              "AI 已给出建议，最终决定仍由管理员做出。",
            ),
      );
      await loadOverview();
    } catch (aiError) {
      setError(
        aiError instanceof Error
          ? aiError.message
          : pick("AI chưa đánh giá được câu.", "AI 暂时无法审核该句。"),
      );
    } finally {
      setPendingAction("");
    }
  }

  async function saveDeviceProfile() {
    if (!selectedClientId) {
      return;
    }

    setPendingAction("device-profile");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/admin/devices/${encodeURIComponent(selectedClientId)}`,
        {
          method: "PATCH",
          headers: adminHeaders(true),
          body: JSON.stringify({ deviceName, childName }),
        },
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          getResponseError(
            data,
            pick("Không lưu được thông tin thiết bị.", "无法保存设备信息。"),
          ),
        );
      }

      setNotice(pick("Đã lưu tên thiết bị và hồ sơ trẻ.", "已保存设备名称和儿童档案。"));
      await loadOverview();
    } catch (profileError) {
      setError(
        profileError instanceof Error
          ? profileError.message
          : pick("Không lưu được thông tin thiết bị.", "无法保存设备信息。"),
      );
    } finally {
      setPendingAction("");
    }
  }

  async function exportDeviceData() {
    if (!selectedClientId) {
      return;
    }

    setPendingAction("data-export");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        `/api/admin/data-export?clientId=${encodeURIComponent(selectedClientId)}`,
        { cache: "no-store", headers: adminHeaders() },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          getResponseError(
            data,
            pick("Không xuất được dữ liệu của trẻ.", "无法导出儿童数据。"),
          ),
        );
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `ai-speaking-${selectedClientId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      setNotice(
        pick(
          "Đã xuất lịch sử, hồ sơ và rule cá nhân của thiết bị.",
          "已导出该设备的历史记录、档案和个性化规则。",
        ),
      );
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : pick("Không xuất được dữ liệu của trẻ.", "无法导出儿童数据。"),
      );
    } finally {
      setPendingAction("");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-blue-950 p-6 shadow-2xl shadow-slate-950/20 sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">
              {pick("AI Speaking · Trung tâm quản trị", "AI Speaking · 管理中心")}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {pick(
                "Theo dõi và dạy hệ thống hiểu đúng từng trẻ",
                "追踪并帮助系统正确理解每个孩子",
              )}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              {pick(
                "Hiện tại dashboard tự nhận diện một Android emulator. Cấu trúc thiết bị đã tách theo clientId để sau này mỗi máy và mỗi trẻ có lịch sử, đánh giá và rule riêng.",
                "当前管理面板会自动识别一个 Android 模拟器。设备数据已按 clientId 隔离，之后每台设备和每个孩子都可以拥有独立的历史、审核和规则。",
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <LanguageToggle tone="dark" />
            <button
              type="button"
              onClick={() => void loadOverview()}
              disabled={isLoading}
              className="rounded-xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/15 disabled:cursor-wait disabled:opacity-60"
            >
              {isLoading
                ? pick("Đang cập nhật…", "正在更新…")
                : pick("Làm mới dữ liệu", "刷新数据")}
            </button>
          </div>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          [pick("Tổng lượt", "总次数"), overview?.stats.total ?? 0, "text-white"],
          [pick("Chưa duyệt", "未审核"), overview?.stats.unreviewed ?? 0, "text-amber-300"],
          [pick("Cần xem", "需检查"), overview?.stats.needsReview ?? 0, "text-violet-300"],
          [pick("Đúng ý", "符合意图"), overview?.stats.approved ?? 0, "text-emerald-300"],
          [pick("Sai ý", "不符意图"), overview?.stats.rejected ?? 0, "text-rose-300"],
          [pick("Đã học", "已学习"), overview?.stats.learned ?? 0, "text-cyan-300"],
        ].map(([label, value, color]) => (
          <div
            key={String(label)}
            className="rounded-2xl border border-white/10 bg-slate-900 p-4 shadow-lg shadow-slate-950/10"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {label}
            </p>
            <p className={`mt-2 text-3xl font-semibold ${color}`}>{value}</p>
          </div>
        ))}
      </section>

      {overview?.latencyHealth ? (
        <section
          className={`rounded-2xl border px-5 py-4 ${
            overview.latencyHealth.status === "warning"
              ? "border-amber-400/30 bg-amber-400/10"
              : "border-emerald-400/20 bg-emerald-400/10"
          }`}
          role={overview.latencyHealth.status === "warning" ? "alert" : "status"}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-white">
                {pick(
                  "Độ trễ từ lúc dừng nói đến khi bắt đầu phát",
                  "从停止说话到开始播放的延迟",
                )}
              </p>
              <p className="mt-1 text-sm text-slate-300">
                {locale === "zh"
                  ? overview.latencyHealth.status === "warning"
                    ? `从停止说话到音频开始播放的 P95 为 ${overview.latencyHealth.p95FirstAudioMs} 毫秒，超过 ${overview.latencyHealth.thresholdMs} 毫秒的阈值。`
                    : overview.latencyHealth.status === "healthy"
                      ? "P95 当前处于监控阈值内。"
                      : "至少需要 10 条音频播放遥测记录才能评估 P95。"
                  : overview.latencyHealth.message}
              </p>
            </div>
            <div className="shrink-0 text-left sm:text-right">
              <p className="font-mono text-2xl font-semibold text-white">
                {overview.latencyHealth.p95FirstAudioMs} ms
              </p>
              <p className="text-xs text-slate-400">
                P95 · {overview.latencyHealth.sampleCount} {pick("lượt", "次")}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <label className="flex-1 text-sm text-slate-300">
              <span className="mb-2 block font-medium">
                {pick("Thiết bị / trẻ", "设备 / 儿童")}
              </span>
              <select
                value={selectedClientId}
                onChange={(event) => selectDevice(event.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none ring-cyan-400 focus:ring-2"
              >
                <option value="">{pick("Tất cả thiết bị", "全部设备")}</option>
                {overview?.devices.map((device) => (
                  <option key={device.clientId} value={device.clientId}>
                    {deviceTitle(device, locale)} ({device.conversationCount}{" "}
                    {pick("lượt", "次")})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex-1 text-sm text-slate-300">
              <span className="mb-2 block font-medium">
                {pick("Trạng thái", "状态")}
              </span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as AdminReviewFilter)
                }
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white outline-none ring-cyan-400 focus:ring-2"
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-4 block text-sm text-slate-300">
            <span className="mb-2 block font-medium">
              {pick("Tìm trong danh sách", "在列表中搜索")}
            </span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={pick(
                "Tìm câu tiếng Việt, tiếng Anh hoặc clientId…",
                "搜索越南语、英语句子或 clientId…",
              )}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 outline-none ring-cyan-400 focus:ring-2"
            />
          </label>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">
                {pick("Hồ sơ thiết bị", "设备档案")}
              </p>
              <p className="mt-1 font-mono text-xs text-slate-500">
                {selectedClientId
                  ? shortClientId(selectedClientId)
                  : pick("Chọn một thiết bị để đặt tên", "选择设备后设置名称")}
              </p>
            </div>
            {overview?.securityMode ? (
              <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-400">
                {overview.securityMode === "local-development"
                  ? pick("Local dev", "本地开发")
                  : overview.securityMode === "admin-token"
                    ? pick("Có bảo vệ", "已保护")
                    : pick("Thiếu token", "缺少令牌")}
              </span>
            ) : null}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input
              value={childName}
              onChange={(event) => setChildName(event.target.value)}
              disabled={!selectedClientId}
              placeholder={pick("Tên trẻ, ví dụ: Bé An", "孩子姓名，例如：小安")}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 disabled:opacity-50"
            />
            <input
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              disabled={!selectedClientId}
              placeholder={pick("Tên thiết bị", "设备名称")}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={() => void saveDeviceProfile()}
            disabled={!selectedClientId || pendingAction === "device-profile"}
            className="mt-3 rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pendingAction === "device-profile"
              ? pick("Đang lưu…", "正在保存…")
              : pick("Lưu hồ sơ", "保存档案")}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold text-white">
              {pick("Dữ liệu và quyền riêng tư của trẻ", "儿童数据与隐私")}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              {locale === "zh"
                ? overview?.dataPolicy.historyRetentionDays
                  ? `对话历史保留 ${overview.dataPolicy.historyRetentionDays} 天。可以删除单条或全部历史记录；选择设备后可导出 JSON 副本。`
                  : "目前不会自动删除历史记录。可以删除单条或全部历史记录；选择设备后可导出 JSON 副本。"
                : overview?.dataPolicy.notes ??
                pick(
                  "Có thể xóa từng lượt hoặc toàn bộ lịch sử; chọn thiết bị để xuất bản sao JSON.",
                  "可以删除单条或全部历史记录；选择设备后可导出 JSON 副本。",
                )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void exportDeviceData()}
            disabled={!selectedClientId || pendingAction === "data-export"}
            className="shrink-0 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2.5 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pendingAction === "data-export"
              ? pick("Đang xuất…", "正在导出…")
              : pick("Xuất dữ liệu thiết bị", "导出设备数据")}
          </button>
        </div>
      </section>

      <details className="rounded-2xl border border-white/10 bg-slate-900 p-5">
        <summary className="cursor-pointer text-sm font-semibold text-white">
          {pick("Bảo vệ admin khi triển khai production", "生产环境的管理员保护")}
        </summary>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="ADMIN_API_TOKEN"
            className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder:text-slate-600"
          />
          <button
            type="button"
            onClick={saveAdminToken}
            className="rounded-xl border border-slate-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
          >
            {pick("Lưu cho phiên này", "为本次会话保存")}
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          {pick(
            "Khi chạy local, token có thể để trống. Ở production, backend từ chối API admin nếu chưa cấu hình biến môi trường ADMIN_API_TOKEN.",
            "本地运行时令牌可以留空。在生产环境中，如果未配置 ADMIN_API_TOKEN 环境变量，后端将拒绝管理员 API 请求。",
          )}
        </p>
      </details>

      {error ? (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
          {notice}
        </div>
      ) : null}

      <section className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">
              {pick("Lượt nói cần quản lý", "待管理的语音记录")}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {pick(
                `${visibleConversations.length} lượt đang hiển thị. AI chỉ chạy khi bạn bấm yêu cầu đánh giá.`,
                `当前显示 ${visibleConversations.length} 条记录。只有在您请求审核时才会调用 AI。`,
              )}
            </p>
          </div>
          {selectedDevice ? (
            <p className="text-xs text-slate-500">
              {pick("Hoạt động gần nhất", "最近活动")}:{" "}
              {formatDate(selectedDevice.lastSeenAt, locale)}
            </p>
          ) : null}
        </div>

        {isLoading && !overview ? (
          <div className="rounded-2xl border border-white/10 bg-slate-900 p-8 text-center text-sm text-slate-400">
            {pick("Đang tải lịch sử…", "正在加载历史记录…")}
          </div>
        ) : visibleConversations.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/60 p-10 text-center">
            <p className="font-medium text-white">
              {pick("Không có lượt nói phù hợp", "没有符合条件的语音记录")}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {pick(
                "Hãy đổi bộ lọc hoặc nói một câu mới trên Android emulator.",
                "请更改筛选条件，或在 Android 模拟器上说一个新句子。",
              )}
            </p>
          </div>
        ) : (
          visibleConversations.map((conversation) => {
            const currentStatus = reviewStatus(conversation);
            const device = devicesById.get(conversation.clientId ?? "legacy");
            const approvedPending =
              pendingAction === `${conversation.conversationId}:approved`;
            const rejectedPending =
              pendingAction === `${conversation.conversationId}:rejected`;
            const aiPending = pendingAction === `${conversation.conversationId}:ai`;
            const anyPending = approvedPending || rejectedPending || aiPending;

            return (
              <article
                key={conversation.conversationId}
                className="rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-lg shadow-slate-950/10"
              >
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`rounded-full border px-2.5 py-1 font-semibold ${statusClass(currentStatus)}`}
                    >
                      {statusLabel(currentStatus, locale)}
                    </span>
                    <span className="rounded-full bg-slate-800 px-2.5 py-1 text-slate-300">
                      {contextLabels[conversation.context]}
                    </span>
                    <span className="rounded-full bg-slate-800 px-2.5 py-1 text-slate-300">
                      {conversation.textSource}
                    </span>
                    {conversation.promotedToRule ? (
                      <span className="rounded-full bg-cyan-400/10 px-2.5 py-1 text-cyan-200">
                        {pick("Rule cá nhân", "个人规则")}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-slate-500 xl:text-right">
                    <p>{formatDate(conversation.createdAt, locale)}</p>
                    <p className="mt-1 font-mono">
                      {deviceTitle(device, locale)} · {shortClientId(conversation.clientId)}
                    </p>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {pick("Trẻ nói", "孩子说")}
                    </p>
                    <p className="mt-2 text-base leading-7 text-white">
                      {conversation.vietnameseText}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>ASR {conversation.latency.asrMs} ms</span>
                      <span>Text {conversation.latency.llmMs} ms</span>
                      <span>Audio {conversation.latency.ttsMs} ms</span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {pick(
                        "Câu tiếng Anh có thể sửa trước khi duyệt",
                        "审核前可修改英语句子",
                      )}
                    </label>
                    <textarea
                      rows={3}
                      value={drafts[conversation.conversationId] ?? conversation.englishText}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [conversation.conversationId]: event.target.value,
                        }))
                      }
                      className="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm leading-6 text-cyan-100 outline-none ring-cyan-400 focus:ring-2"
                    />
                    {conversation.originalEnglishText ? (
                      <p className="mt-2 text-xs text-slate-500">
                        {pick("Bản ban đầu", "原始版本")}: {conversation.originalEnglishText}
                      </p>
                    ) : null}
                  </div>
                </div>

                {conversation.aiReview ? (
                  <div className="mt-4 rounded-xl border border-violet-400/20 bg-violet-400/10 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-violet-100">
                        {aiVerdictLabel(conversation.aiReview.verdict, locale)} ·{" "}
                        {Math.round(conversation.aiReview.confidence * 100)}%
                      </p>
                      <p className="text-xs text-violet-300/70">
                        {conversation.aiReview.model}
                        {conversation.aiReview.inputTokens
                          ? ` · ${conversation.aiReview.inputTokens + (conversation.aiReview.outputTokens ?? 0)} tokens`
                          : ""}
                      </p>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-violet-100/80">
                      {conversation.aiReview.reason}
                    </p>
                    {conversation.aiReview.suggestedEnglish ? (
                      <button
                        type="button"
                        onClick={() =>
                          setDrafts((current) => ({
                            ...current,
                            [conversation.conversationId]:
                              conversation.aiReview?.suggestedEnglish ??
                              conversation.englishText,
                          }))
                        }
                        className="mt-3 text-sm font-semibold text-violet-200 underline underline-offset-4"
                      >
                        {pick("Dùng câu AI gợi ý", "使用 AI 建议句子")}: {conversation.aiReview.suggestedEnglish}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
                  <label className="text-sm text-slate-400">
                    <span className="mb-2 block">
                      {pick("Ghi chú đánh giá", "审核备注")}
                    </span>
                    <input
                      value={notes[conversation.conversationId] ?? ""}
                      onChange={(event) =>
                        setNotes((current) => ({
                          ...current,
                          [conversation.conversationId]: event.target.value,
                        }))
                      }
                      placeholder={
                        conversation.reviewNote ||
                        pick(
                          "Ví dụ: đúng ý nhưng cần câu ngắn hơn",
                          "例如：意思正确，但句子需要更简短",
                        )
                      }
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white placeholder:text-slate-600"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void requestAiReview(conversation)}
                      disabled={anyPending}
                      className="rounded-xl border border-violet-400/40 px-3.5 py-2.5 text-sm font-semibold text-violet-200 hover:bg-violet-400/10 disabled:opacity-40"
                    >
                      {aiPending
                        ? pick("AI đang xem…", "AI 正在审核…")
                        : conversation.aiReview
                          ? pick("Xem lại AI", "重新请求 AI")
                          : pick("Nhờ AI đánh giá", "请求 AI 审核")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void reviewConversation(conversation, "rejected")}
                      disabled={anyPending}
                      className="rounded-xl border border-rose-400/40 px-3.5 py-2.5 text-sm font-semibold text-rose-200 hover:bg-rose-400/10 disabled:opacity-40"
                    >
                      {rejectedPending
                        ? pick("Đang lưu…", "正在保存…")
                        : pick("Sai ý", "不符意图")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void reviewConversation(conversation, "approved")}
                      disabled={anyPending}
                      className="rounded-xl bg-emerald-400 px-3.5 py-2.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-40"
                    >
                      {approvedPending
                        ? pick("Đang lưu & tạo audio…", "正在保存并生成音频…")
                        : pick("Duyệt đúng", "确认正确")}
                    </button>
                  </div>
                </div>

                {conversation.audioUrl ? (
                  <audio
                    className="mt-4 h-9 w-full max-w-md"
                    controls
                    preload="none"
                    src={conversation.audioUrl}
                  />
                ) : null}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
