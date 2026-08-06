"use client";

import Link from "next/link";
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

type EditableReviewStatus = Extract<
  ConversationReviewStatus,
  "unreviewed" | "approved" | "rejected"
>;

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

async function fetchAdmin(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const response = await fetch(input, init);

  if (response.status === 401) {
    window.location.replace("/admin/login");
    throw new Error("Phiên đăng nhập quản trị đã hết hạn.");
  }

  return response;
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

function editableReviewStatus(
  conversation: ConversationHistoryEntry,
): EditableReviewStatus {
  const status = reviewStatus(conversation);
  return status === "approved" || status === "rejected" ? status : "unreviewed";
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
  const editableStatusOptions: Array<{
    value: EditableReviewStatus;
    label: string;
  }> = [
    { value: "approved", label: pick("Đúng", "正确") },
    { value: "rejected", label: pick("Sai", "错误") },
    { value: "unreviewed", label: pick("Chưa duyệt", "未审核") },
  ];
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [status, setStatus] = useState<AdminReviewFilter>("unreviewed");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reviewDrafts, setReviewDrafts] = useState<
    Record<string, EditableReviewStatus>
  >({});
  const [pendingAction, setPendingAction] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const adminHeaders = useCallback((withJson = false): Record<string, string> => {
    return withJson ? { "Content-Type": "application/json" } : {};
  }, []);

  const loadOverview = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ status, limit: "200" });
      if (selectedClientId) {
        params.set("clientId", selectedClientId);
      }
      const response = await fetchAdmin(`/api/admin/overview?${params}`, {
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
      setReviewDrafts((current) => {
        const next = { ...current };
        data.overview?.conversations.forEach((conversation) => {
          if (!(conversation.conversationId in next)) {
            next[conversation.conversationId] =
              editableReviewStatus(conversation);
          }
        });
        return next;
      });

      const nextSelectedClientId =
        selectedClientId ||
        (data.overview.devices.length === 1
          ? data.overview.devices[0].clientId
          : "");

      if (!selectedClientId && nextSelectedClientId) {
        setSelectedClientId(nextSelectedClientId);
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
      void loadOverview();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadOverview]);

  const selectedDevice = overview?.devices.find(
    (device) => device.clientId === selectedClientId,
  );

  function selectDevice(clientId: string) {
    setSelectedClientId(clientId);
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

  async function reviewConversation(
    conversation: ConversationHistoryEntry,
    verdict: EditableReviewStatus,
  ) {
    const actionKey = `${conversation.conversationId}:save`;
    setPendingAction(actionKey);
    setError(null);
    setNotice(null);

    try {
      const response = await fetchAdmin(
        `/api/admin/conversations/${encodeURIComponent(conversation.conversationId)}/review`,
        {
          method: "PATCH",
          headers: adminHeaders(true),
          body: JSON.stringify({
            clientId: conversation.clientId,
            verdict,
            correctedEnglish: drafts[conversation.conversationId],
            note: conversation.reviewNote,
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
            : verdict === "rejected"
              ? pick(
                "Đã đánh dấu sai và gỡ dữ liệu học liên quan.",
                "已标记为错误并移除相关学习数据。",
                )
              : pick(
                  "Đã lưu trạng thái chưa duyệt.",
                  "已保存为未审核状态。",
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

  async function logout() {
    setPendingAction("logout");
    setError(null);

    try {
      const response = await fetch("/api/admin/auth/logout", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          pick("Không thể đăng xuất. Vui lòng thử lại.", "无法退出登录，请重试。"),
        );
      }

      window.location.replace("/admin/login");
    } catch (logoutError) {
      setError(
        logoutError instanceof Error
          ? logoutError.message
          : pick("Không thể đăng xuất. Vui lòng thử lại.", "无法退出登录，请重试。"),
      );
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
            <Link
              href="/admin/audio-check"
              className="rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2.5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/20"
            >
              {pick("Kiểm tra audio", "音频检查")}
            </Link>
            <LanguageToggle tone="dark" />
            <button
              type="button"
              onClick={() => void loadOverview()}
              disabled={isLoading || pendingAction === "logout"}
              className="rounded-xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/15 disabled:cursor-wait disabled:opacity-60"
            >
              {isLoading
                ? pick("Đang cập nhật…", "正在更新…")
                : pick("Làm mới dữ liệu", "刷新数据")}
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              disabled={pendingAction === "logout"}
              className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
            >
              {pendingAction === "logout"
                ? pick("Đang đăng xuất…", "正在退出…")
                : pick("Đăng xuất", "退出登录")}
            </button>
          </div>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[
          [pick("Chưa duyệt", "未审核"), overview?.stats.unreviewed ?? 0, "text-amber-300"],
          [pick("Đúng ý", "符合意图"), overview?.stats.approved ?? 0, "text-emerald-300"],
          [pick("Sai ý", "不符意图"), overview?.stats.rejected ?? 0, "text-rose-300"],
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

      <section>
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
      </section>

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
                `${visibleConversations.length} lượt đang hiển thị.`,
                `当前显示 ${visibleConversations.length} 条记录。`,
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
            const selectedReviewStatus =
              reviewDrafts[conversation.conversationId] ??
              editableReviewStatus(conversation);
            const savePending =
              pendingAction === `${conversation.conversationId}:save`;
            const anyPending = savePending;

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
                      {conversation.latency.responseToPlaybackMs !== undefined ? (
                        <span>
                          Safari sau response {conversation.latency.responseToPlaybackMs} ms
                        </span>
                      ) : null}
                      {conversation.latency.audioFromDeviceCache !== undefined ? (
                        <span>
                          Reuse preload {conversation.latency.audioFromDeviceCache ? "yes" : "no"}
                        </span>
                      ) : null}
                      {conversation.latency.audioPreloadLoadedData !== undefined ? (
                        <span>
                          loadeddata {conversation.latency.audioPreloadLoadedData ? "yes" : "no"}
                          {conversation.latency.audioPreloadLoadedDataMs !== undefined
                            ? ` (${conversation.latency.audioPreloadLoadedDataMs} ms)`
                            : ""}
                        </span>
                      ) : null}
                      {conversation.latency.audioPreloadCanPlay !== undefined ? (
                        <span>
                          canplay {conversation.latency.audioPreloadCanPlay ? "yes" : "no"}
                          {conversation.latency.audioPreloadCanPlayMs !== undefined
                            ? ` (${conversation.latency.audioPreloadCanPlayMs} ms)`
                            : ""}
                        </span>
                      ) : null}
                      <span>
                        Audio cache hit {conversation.audioSource === "cache" ? "yes" : "no"}
                      </span>
                      {conversation.benchmark
                        ?.batchTerminalPreviewLeadBeforeFinalizeMs !== undefined ? (
                        <span>
                          Terminal sớm hơn finalize{" "}
                          {
                            conversation.benchmark
                              .batchTerminalPreviewLeadBeforeFinalizeMs
                          }{" "}
                          ms
                        </span>
                      ) : null}
                      {conversation.benchmark
                        ?.batchPipelineSharedFlightJoined !== undefined ? (
                        <span>
                          Shared pipeline{" "}
                          {conversation.benchmark.batchPipelineSharedFlightJoined
                            ? "yes"
                            : "no"}
                        </span>
                      ) : null}
                      {conversation.benchmark?.batchPrefetchRaceWinner !== undefined ? (
                        <span>
                          Race winner {conversation.benchmark.batchPrefetchRaceWinner}
                        </span>
                      ) : null}
                      {conversation.benchmark?.batchTerminalPipelineAgeMs !== undefined ? (
                        <span>
                          Terminal pipeline age {conversation.benchmark.batchTerminalPipelineAgeMs} ms
                        </span>
                      ) : null}
                      {conversation.benchmark
                        ?.batchTerminalPipelineTailEligible !== undefined ? (
                        <span>
                          Terminal tail {conversation.benchmark.batchTerminalPipelineTailEligible
                            ? "eligible"
                            : "rejected"}
                        </span>
                      ) : null}
                      {conversation.benchmark
                        ?.batchTerminalPipelineSharedFlightJoined !== undefined ? (
                        <span>
                          Terminal shared {conversation.benchmark.batchTerminalPipelineSharedFlightJoined
                            ? "yes"
                            : "no"}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {pick(
                        "Câu hệ thống dịch (có thể chỉnh sửa)",
                        "系统翻译（可编辑）",
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

                <div className="mt-4 flex justify-end">
                  <div className="flex flex-col gap-3">
                    <fieldset>
                      <legend className="mb-2 text-sm text-slate-400">
                        {pick("Cập nhật trạng thái", "更新状态")}
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {editableStatusOptions.map((option) => (
                          <label
                            key={option.value}
                            className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 has-checked:border-cyan-400/70 has-checked:bg-cyan-400/10 has-checked:text-cyan-100"
                          >
                            <input
                              type="radio"
                              name={`review-status-${conversation.conversationId}`}
                              value={option.value}
                              checked={selectedReviewStatus === option.value}
                              onChange={() =>
                                setReviewDrafts((current) => ({
                                  ...current,
                                  [conversation.conversationId]: option.value,
                                }))
                              }
                              disabled={anyPending}
                              className="size-4 accent-cyan-400"
                            />
                            {option.label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void reviewConversation(
                            conversation,
                            selectedReviewStatus,
                          )
                        }
                        disabled={anyPending}
                        className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {savePending
                          ? pick("Đang lưu…", "正在保存…")
                          : pick("Lưu", "保存")}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
