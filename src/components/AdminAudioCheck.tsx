"use client";

import Link from "next/link";
import {
  type InputHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useUiLocale } from "@/components/UiLocaleProvider";
import {
  downloadAudioCheckWorkbook,
  type AudioCheckWorkbookRow,
} from "@/lib/client/exportAudioCheckWorkbook";
import type {
  ConversationResponse,
  PracticeContext,
} from "@/types/conversation";

type AudioCheckMode = "standard" | "cloudflare_batch_chunks";
type AudioCheckStatus = "unreviewed" | "approved" | "rejected";
type AudioProcessingStatus = "queued" | "processing" | "completed" | "failed";
type ReviewVerdict = Extract<AudioCheckStatus, "approved" | "rejected">;
type AudioErrorReason = "" | "translation_error" | "spelling_error";
type SelectedAudioErrorReason = Exclude<AudioErrorReason, "">;
type ProgressReporter = (value: number) => void;

type AudioSessionResponse = {
  audioSessionId: string;
  capabilities?: {
    maxChunkBytes?: number;
    maxSessionBytes?: number;
    maxChunks?: number;
  };
};

type AudioCheckResult = {
  conversation: ConversationResponse;
  mode: AudioCheckMode;
  context: PracticeContext;
  totalMs: number;
  chunkCount: number;
};

type AudioCheckItem = {
  id: string;
  file: File;
  previewUrl: string;
  validationError: string | null;
  processingStatus: AudioProcessingStatus;
  result: AudioCheckResult | null;
  reviewStatus: AudioCheckStatus;
  errorReason: AudioErrorReason;
  showErrorReason: boolean;
  pendingReview: ReviewVerdict | "";
  progress: number;
  error: string | null;
};

const defaultChunkBytes = 512 * 1024;
const defaultMaxAudioBytes = 10 * 1024 * 1024;
const maxBatchFiles = 50;
const directoryInputAttributes = {
  webkitdirectory: "",
  directory: "",
} as unknown as InputHTMLAttributes<HTMLInputElement>;
const errorReasonVietnameseLabels: Record<SelectedAudioErrorReason, string> = {
  translation_error: "Dịch sai audio",
  spelling_error: "Sai chính tả",
};
const contextVietnameseLabels: Record<PracticeContext, string> = {
  home: "Ở nhà",
  school: "Trường học",
  outside: "Bên ngoài",
};

const mimeTypeByExtension: Record<string, string> = {
  "3g2": "audio/3gpp2",
  "3ga": "audio/3gpp",
  "3gp": "audio/3gpp",
  "3gpp": "audio/3gpp",
  aac: "audio/aac",
  ac3: "audio/ac3",
  aif: "audio/aiff",
  aifc: "audio/aiff",
  aiff: "audio/aiff",
  alac: "audio/alac",
  amr: "audio/amr",
  au: "audio/basic",
  caf: "audio/x-caf",
  flac: "audio/flac",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  m4p: "audio/mp4",
  mp2: "audio/mpeg",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  mpa: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  ra: "audio/vnd.rn-realaudio",
  ram: "audio/vnd.rn-realaudio",
  snd: "audio/basic",
  wav: "audio/wav",
  wave: "audio/wav",
  weba: "audio/webm",
  webm: "audio/webm",
  wma: "audio/x-ms-wma",
};
const canonicalMimeTypes: Record<string, string> = {
  "audio/aacp": "audio/aac",
  "audio/mp3": "audio/mpeg",
  "audio/vnd.wave": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-m4a": "audio/mp4",
  "audio/x-pn-realaudio": "audio/vnd.rn-realaudio",
  "audio/x-wav": "audio/wav",
};

function formatBytes(value: number) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function getAudioMimeType(file: File) {
  const declaredType = file.type.split(";", 1)[0]?.trim().toLowerCase();
  if (declaredType && declaredType.startsWith("audio/")) {
    return canonicalMimeTypes[declaredType] ?? declaredType;
  }

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return mimeTypeByExtension[extension] ?? "";
}

function getAudioRelativePath(file: File) {
  return file.webkitRelativePath.trim() || file.name;
}

async function getResponseError(response: Response) {
  const data = await response.json().catch(() => null);

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

  return "Request failed with status " + response.status;
}

function reviewStatusClasses(status: AudioCheckStatus) {
  return {
    unreviewed: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    approved: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    rejected: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  }[status];
}

function itemStatusClasses(item: AudioCheckItem) {
  if (item.processingStatus === "failed") {
    return "border-rose-400/30 bg-rose-400/10 text-rose-200";
  }
  if (item.processingStatus === "processing") {
    return "border-cyan-400/30 bg-cyan-400/10 text-cyan-200";
  }
  if (item.processingStatus === "queued") {
    return "border-slate-600 bg-slate-800 text-slate-300";
  }
  return reviewStatusClasses(item.reviewStatus);
}

export function AdminAudioCheck() {
  const { pick } = useUiLocale();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlsRef = useRef<string[]>([]);
  const [mode, setMode] = useState<AudioCheckMode>("standard");
  const [context, setContext] = useState<PracticeContext>("home");
  const [items, setItems] = useState<AudioCheckItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);
  const [activeFileLabel, setActiveFileLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () => () => {
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  const modeLabels: Record<AudioCheckMode, string> = {
    standard: pick("Chế độ tiêu chuẩn", "标准模式"),
    cloudflare_batch_chunks: "Cloudflare Batch Chunks",
  };
  const statusLabels: Record<AudioCheckStatus, string> = {
    unreviewed: pick("Chưa đánh giá", "未评估"),
    approved: pick("Đúng", "正确"),
    rejected: pick("Lỗi", "错误"),
  };
  const errorReasonLabels: Record<SelectedAudioErrorReason, string> = {
    translation_error: pick("Dịch sai audio", "音频翻译错误"),
    spelling_error: pick("Sai chính tả", "拼写错误"),
  };

  const validItemCount = items.filter((item) => !item.validationError).length;
  const completedCount = items.filter(
    (item) => item.processingStatus === "completed",
  ).length;
  const failedCount = items.filter(
    (item) => item.processingStatus === "failed",
  ).length;
  const settledCount = completedCount + failedCount;
  const approvedCount = items.filter(
    (item) => item.reviewStatus === "approved",
  ).length;
  const rejectedCount = items.filter(
    (item) => item.reviewStatus === "rejected",
  ).length;
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);

  function updateItem(
    itemId: string,
    updater: (current: AudioCheckItem) => AudioCheckItem,
  ) {
    setItems((current) =>
      current.map((item) => (item.id === itemId ? updater(item) : item)),
    );
  }

  function revokePreviewUrls() {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = [];
  }

  function validateFile(nextFile: File) {
    const mimeType = getAudioMimeType(nextFile);
    if (!mimeType) {
      return pick(
        "File đã chọn không phải định dạng audio.",
        "所选文件不是音频格式。",
      );
    }

    if (nextFile.size <= 0 || nextFile.size > defaultMaxAudioBytes) {
      return pick(
        "Audio phải có dữ liệu và không vượt quá 10 MB.",
        "音频不能为空，且大小不能超过 10 MB。",
      );
    }

    return null;
  }

  function chooseFiles(fileList: FileList | null) {
    revokePreviewUrls();
    setItems([]);
    setNotice(null);
    setOverallProgress(0);
    setActiveFileLabel("");

    if (!fileList?.length) {
      setError(null);
      return;
    }

    const selectedFiles = Array.from(fileList);
    const audioFiles = selectedFiles.filter((nextFile) =>
      Boolean(getAudioMimeType(nextFile)),
    );
    if (!audioFiles.length) {
      setError(
        pick(
          "Thư mục đã chọn không có file audio được hỗ trợ.",
          "所选文件夹中没有受支持的音频文件。",
        ),
      );
      return;
    }

    const limitedFiles = audioFiles.slice(0, maxBatchFiles);
    const selectionId = Date.now();
    const nextItems = limitedFiles.map((nextFile, index) => {
      const validationError = validateFile(nextFile);
      const previewUrl = validationError ? "" : URL.createObjectURL(nextFile);
      if (previewUrl) {
        previewUrlsRef.current.push(previewUrl);
      }

      return {
        id:
          String(selectionId) +
          "-" +
          String(index) +
          "-" +
          getAudioRelativePath(nextFile) +
          "-" +
          String(nextFile.lastModified),
        file: nextFile,
        previewUrl,
        validationError,
        processingStatus: validationError ? "failed" : "queued",
        result: null,
        reviewStatus: "unreviewed",
        errorReason: "",
        showErrorReason: false,
        pendingReview: "",
        progress: 0,
        error: validationError,
      } satisfies AudioCheckItem;
    });

    setItems(nextItems);
    setError(
      audioFiles.length > maxBatchFiles
        ? pick(
            "Mỗi lượt tối đa 50 file. Chỉ 50 file đầu tiên đã được thêm.",
            "每批最多 50 个文件，仅添加了前 50 个。",
          )
        : null,
    );
  }

  async function runStandardCheck(
    audioFile: File,
    selectedContext: PracticeContext,
    reportProgress: ProgressReporter,
  ) {
    const formData = new FormData();
    formData.append("audio", audioFile, audioFile.name);
    formData.append("context", selectedContext);
    formData.append("childAge", "6");
    formData.append(
      "benchmark",
      JSON.stringify({
        requestedAsrMode: "batch_chunks",
        batchTransport: "admin_standard_upload",
        audioChunkCount: 1,
        uploadedAudioBytes: audioFile.size,
      }),
    );
    reportProgress(20);

    const response = await fetch("/api/conversation", {
      method: "POST",
      body: formData,
    });
    reportProgress(90);

    if (!response.ok) {
      throw new Error(await getResponseError(response));
    }

    return {
      conversation: (await response.json()) as ConversationResponse,
      chunkCount: 1,
    };
  }

  async function runBatchChunksCheck(
    audioFile: File,
    selectedContext: PracticeContext,
    reportProgress: ProgressReporter,
  ) {
    let audioSessionId = "";

    try {
      const sessionResponse = await fetch("/api/audio-sessions", {
        method: "POST",
      });
      if (!sessionResponse.ok) {
        throw new Error(await getResponseError(sessionResponse));
      }

      const session = (await sessionResponse.json()) as AudioSessionResponse;
      audioSessionId = session.audioSessionId;
      const serverChunkLimit = session.capabilities?.maxChunkBytes;
      const chunkBytes =
        typeof serverChunkLimit === "number" && serverChunkLimit > 0
          ? Math.min(defaultChunkBytes, serverChunkLimit)
          : defaultChunkBytes;
      const maxSessionBytes = session.capabilities?.maxSessionBytes;

      if (
        typeof maxSessionBytes === "number" &&
        maxSessionBytes > 0 &&
        audioFile.size > maxSessionBytes
      ) {
        throw new Error(
          pick(
            "Audio vượt giới hạn " +
              formatBytes(maxSessionBytes) +
              " của Batch Chunks.",
            "音频超过 Batch Chunks 的 " +
              formatBytes(maxSessionBytes) +
              " 限制。",
          ),
        );
      }

      const chunkCount = Math.ceil(audioFile.size / chunkBytes);
      if (
        typeof session.capabilities?.maxChunks === "number" &&
        chunkCount > session.capabilities.maxChunks
      ) {
        throw new Error(
          pick(
            "Audio tạo ra quá nhiều chunks để xử lý.",
            "音频分块数量过多，无法处理。",
          ),
        );
      }

      reportProgress(8);
      for (let sequence = 0; sequence < chunkCount; sequence += 1) {
        const start = sequence * chunkBytes;
        const chunk = audioFile.slice(
          start,
          Math.min(start + chunkBytes, audioFile.size),
          audioFile.type,
        );
        const formData = new FormData();
        formData.append("sequence", String(sequence));
        formData.append("audio", chunk, "chunk-" + sequence + ".part");

        const uploadResponse = await fetch(
          "/api/audio-sessions/" +
            encodeURIComponent(audioSessionId) +
            "/chunks",
          { method: "POST", body: formData },
        );
        if (!uploadResponse.ok) {
          throw new Error(await getResponseError(uploadResponse));
        }

        reportProgress(
          8 + Math.round(((sequence + 1) / chunkCount) * 67),
        );
      }

      const finalizeResponse = await fetch(
        "/api/audio-sessions/" +
          encodeURIComponent(audioSessionId) +
          "/finalize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: selectedContext,
            childAge: 6,
            targetLanguage: "en",
            asrMode: "batch_chunks",
            mimeType: audioFile.type,
            benchmark: {
              requestedAsrMode: "batch_chunks",
              batchTransport: "admin_cloudflare_batch_chunks",
              audioChunkCount: chunkCount,
              uploadedAudioBytes: audioFile.size,
              chunkIntervalMs: 0,
            },
          }),
        },
      );
      reportProgress(92);

      if (!finalizeResponse.ok) {
        throw new Error(await getResponseError(finalizeResponse));
      }

      return {
        conversation: (await finalizeResponse.json()) as ConversationResponse,
        chunkCount,
      };
    } catch (batchError) {
      if (audioSessionId) {
        await fetch(
          "/api/audio-sessions/" +
            encodeURIComponent(audioSessionId) +
            "/chunks",
          { method: "DELETE" },
        ).catch(() => undefined);
      }
      throw batchError;
    }
  }

  async function runAllChecks() {
    if (isProcessing) return;

    const processableItems = items.filter((item) => !item.validationError);
    if (!processableItems.length) {
      setError(
        pick(
          "Hãy chọn ít nhất một file audio hợp lệ.",
          "请至少选择一个有效的音频文件。",
        ),
      );
      return;
    }

    const selectedMode = mode;
    const selectedContext = context;
    setIsProcessing(true);
    setError(null);
    setNotice(null);
    setOverallProgress(0);
    setItems((current) =>
      current.map((item) =>
        item.validationError
          ? {
              ...item,
              processingStatus: "failed",
              result: null,
              reviewStatus: "unreviewed",
              errorReason: "",
              showErrorReason: false,
              pendingReview: "",
              progress: 0,
              error: item.validationError,
            }
          : {
              ...item,
              processingStatus: "queued",
              result: null,
              reviewStatus: "unreviewed",
              errorReason: "",
              showErrorReason: false,
              pendingReview: "",
              progress: 0,
              error: null,
            },
      ),
    );

    let succeeded = 0;
    let failed = 0;

    try {
      for (let index = 0; index < processableItems.length; index += 1) {
        const item = processableItems[index];
        const positionLabel =
          String(index + 1) +
          "/" +
          String(processableItems.length) +
          " · " +
          item.file.name;
        setActiveFileLabel(positionLabel);
        updateItem(item.id, (current) => ({
          ...current,
          processingStatus: "processing",
          result: null,
          reviewStatus: "unreviewed",
          progress: 2,
          error: null,
        }));

        const mimeType = getAudioMimeType(item.file);
        const audioFile =
          item.file.type === mimeType
            ? item.file
            : new File([item.file], item.file.name, { type: mimeType });
        const startedAt = performance.now();
        const reportProgress = (value: number) => {
          const boundedProgress = Math.max(0, Math.min(100, value));
          updateItem(item.id, (current) => ({
            ...current,
            progress: boundedProgress,
          }));
          setOverallProgress(
            Math.round(
              ((index + boundedProgress / 100) /
                processableItems.length) *
                100,
            ),
          );
        };

        try {
          const check =
            selectedMode === "standard"
              ? await runStandardCheck(
                  audioFile,
                  selectedContext,
                  reportProgress,
                )
              : await runBatchChunksCheck(
                  audioFile,
                  selectedContext,
                  reportProgress,
                );
          updateItem(item.id, (current) => ({
            ...current,
            processingStatus: "completed",
            result: {
              ...check,
              mode: selectedMode,
              context: selectedContext,
              totalMs: Math.round(performance.now() - startedAt),
            },
            reviewStatus: "unreviewed",
            progress: 100,
            error: null,
          }));
          succeeded += 1;
        } catch (checkError) {
          updateItem(item.id, (current) => ({
            ...current,
            processingStatus: "failed",
            result: null,
            progress: 0,
            error:
              checkError instanceof Error
                ? checkError.message
                : pick("Không kiểm tra được audio.", "无法检查音频。"),
          }));
          failed += 1;
        }

        setOverallProgress(
          Math.round(((index + 1) / processableItems.length) * 100),
        );
      }

      setNotice(
        failed === 0
          ? pick(
              "Đã nhận diện xong " +
                String(succeeded) +
                " audio. Hãy đánh giá từng file là Đúng hoặc Lỗi.",
              "已完成 " +
                String(succeeded) +
                " 个音频的识别，请逐个评估为正确或错误。",
            )
          : pick(
              "Đã xử lý xong: " +
                String(succeeded) +
                " thành công, " +
                String(failed) +
                " lỗi kỹ thuật.",
              "处理完成：" +
                String(succeeded) +
                " 个成功，" +
                String(failed) +
                " 个技术错误。",
            ),
      );
    } finally {
      setIsProcessing(false);
      setActiveFileLabel("");
    }
  }

  function openErrorReason(itemId: string) {
    setError(null);
    setNotice(null);
    updateItem(itemId, (current) => ({
      ...current,
      showErrorReason: true,
    }));
  }

  async function saveReview(
    itemId: string,
    verdict: ReviewVerdict,
    selectedErrorReason: AudioErrorReason = "",
  ) {
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item?.result || item.pendingReview) return;
    if (verdict === "rejected" && !selectedErrorReason) {
      setError(
        pick(
          "Hãy chọn loại lỗi trước khi lưu đánh giá.",
          "保存评估前请选择错误类型。",
        ),
      );
      return;
    }

    const audioPath = getAudioRelativePath(item.file);
    const reasonNote =
      verdict === "rejected" && selectedErrorReason
        ? "Loại lỗi: " +
          errorReasonVietnameseLabels[selectedErrorReason] +
          " · "
        : "";
    updateItem(itemId, (current) => ({
      ...current,
      pendingReview: verdict,
    }));
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(
        "/api/admin/conversations/" +
          encodeURIComponent(item.result.conversation.conversationId) +
          "/review",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            verdict,
            correctedEnglish: item.result.conversation.englishText,
            note:
              "Admin batch audio check · " +
              reasonNote +
              audioPath +
              " · " +
              modeLabels[item.result.mode],
          }),
        },
      );

      if (response.status === 401) {
        window.location.replace("/admin/login");
        return;
      }
      if (!response.ok) {
        throw new Error(await getResponseError(response));
      }

      updateItem(itemId, (current) => ({
        ...current,
        reviewStatus: verdict,
        errorReason:
          verdict === "rejected" ? selectedErrorReason : "",
        showErrorReason: false,
      }));
      setNotice(
        verdict === "approved"
          ? pick(
              "Đã lưu " + audioPath + " là Đúng.",
              "已将 " + audioPath + " 保存为正确。",
            )
          : pick(
              "Đã lưu " +
                audioPath +
                " là Lỗi · " +
                errorReasonLabels[selectedErrorReason as SelectedAudioErrorReason] +
                ".",
              "已将 " +
                audioPath +
                " 保存为错误 · " +
                errorReasonLabels[selectedErrorReason as SelectedAudioErrorReason] +
                "。",
            ),
      );
    } catch (reviewError) {
      setError(
        audioPath +
          ": " +
          (reviewError instanceof Error
            ? reviewError.message
            : pick("Không lưu được trạng thái.", "无法保存状态。")),
      );
    } finally {
      updateItem(itemId, (current) => ({
        ...current,
        pendingReview: "",
      }));
    }
  }

  function exportResults() {
    if (!items.length || isProcessing) return;

    const rows: AudioCheckWorkbookRow[] = items.map((item) => {
      const evaluation =
        item.processingStatus === "failed"
          ? "Lỗi xử lý"
          : item.processingStatus !== "completed"
            ? "Chưa hoàn tất"
            : item.reviewStatus === "approved"
              ? "Đúng"
              : item.reviewStatus === "rejected"
                ? "Lỗi"
                : "Chưa đánh giá";
      const processingStatus =
        item.processingStatus === "completed"
          ? "Đã nhận diện"
          : item.processingStatus === "failed"
            ? "Lỗi xử lý"
            : item.processingStatus === "processing"
              ? "Đang xử lý"
              : "Chờ xử lý";

      return {
        audioPath: getAudioRelativePath(item.file),
        fileName: item.file.name,
        evaluation,
        errorReason:
          item.reviewStatus === "rejected" && item.errorReason
            ? errorReasonVietnameseLabels[item.errorReason]
            : "",
        processingStatus,
        vietnameseText: item.result?.conversation.vietnameseText ?? "",
        englishText: item.result?.conversation.englishText ?? "",
        recognitionMode: item.result
          ? item.result.mode === "standard"
            ? "Chế độ tiêu chuẩn"
            : "Cloudflare Batch Chunks"
          : "",
        context: contextVietnameseLabels[item.result?.context ?? context],
        asrMs: item.result?.conversation.latency.asrMs ?? null,
        totalMs: item.result?.totalMs ?? null,
        chunkCount: item.result?.chunkCount ?? null,
        fileSizeBytes: item.file.size,
        technicalError: item.error ?? "",
        conversationId: item.result?.conversation.conversationId ?? "",
      };
    });
    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-");
    downloadAudioCheckWorkbook(
      rows,
      "ket-qua-kiem-tra-audio-" + timestamp + ".xlsx",
    );
    setNotice(
      pick(
        "Đã xuất " + String(rows.length) + " dòng kết quả ra Excel.",
        "已将 " + String(rows.length) + " 条结果导出到 Excel。",
      ),
    );
  }

  function itemStatusLabel(item: AudioCheckItem) {
    if (item.processingStatus === "failed") {
      return pick("Lỗi xử lý", "处理错误");
    }
    if (item.processingStatus === "processing") {
      return pick("Đang xử lý", "处理中");
    }
    if (item.processingStatus === "queued") {
      return pick("Chờ xử lý", "等待处理");
    }
    return statusLabels[item.reviewStatus];
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-blue-950 to-cyan-950 p-6 shadow-2xl shadow-slate-950/20 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <Link
              href="/admin"
              className="inline-flex items-center gap-2 text-sm font-medium text-cyan-300 transition hover:text-cyan-100"
            >
              <span aria-hidden="true">←</span>
              {pick("Quay lại tổng quan", "返回总览")}
            </Link>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">
              {pick("Công cụ quản trị", "管理工具")}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {pick("Kiểm tra audio hàng loạt", "批量音频检查")}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              {pick(
                "Chọn nhiều audio tiếng Việt, chạy nhận diện chỉ với một lần bấm rồi đánh giá Đúng hoặc Lỗi cho từng file.",
                "选择多个越南语音频，只需点击一次即可运行识别，然后逐个评估为正确或错误。",
              )}
            </p>
          </div>
          <LanguageToggle tone="dark" />
        </div>
      </header>

      <section className="rounded-3xl border border-white/10 bg-slate-900 p-5 shadow-xl shadow-slate-950/20 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
              01 · {pick("Audio đầu vào", "输入音频")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-white">
              {pick("Chọn thư mục audio cần kiểm tra", "选择要检查的音频文件夹")}
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              {pick(
                "Hiển thị đường dẫn tương đối trong thư mục. Tối đa 50 audio mỗi lượt, 10 MB mỗi file.",
                "显示文件夹内的相对路径。每批最多 50 个音频，每个文件最大 10 MB。",
              )}
            </p>
          </div>
          {items.length ? (
            <div className="flex flex-wrap gap-2 text-xs font-semibold">
              <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-cyan-200">
                {items.length} audio
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-slate-300">
                {formatBytes(totalBytes)}
              </span>
            </div>
          ) : null}
        </div>

        <input
          {...directoryInputAttributes}
          ref={fileInputRef}
          type="file"
          multiple
          accept="audio/*,.3g2,.3ga,.3gp,.3gpp,.aac,.ac3,.aif,.aifc,.aiff,.alac,.amr,.au,.caf,.flac,.m4a,.m4b,.m4p,.mp2,.mp3,.mp4,.mpa,.mpga,.oga,.ogg,.opus,.ra,.ram,.snd,.wav,.wave,.weba,.webm,.wma"
          onChange={(event) => chooseFiles(event.target.files)}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => {
            if (fileInputRef.current) {
              fileInputRef.current.value = "";
              fileInputRef.current.click();
            }
          }}
          disabled={isProcessing}
          className="mt-5 flex min-h-36 w-full flex-col items-center justify-center rounded-2xl border border-dashed border-slate-600 bg-slate-950/60 px-5 py-7 text-center transition hover:border-cyan-400/60 hover:bg-cyan-400/5 disabled:cursor-wait disabled:opacity-60"
        >
          <span className="grid size-12 place-items-center rounded-2xl bg-cyan-400/10 text-2xl text-cyan-300">
            ♫
          </span>
          <span className="mt-4 font-semibold text-white">
            {items.length
              ? pick("Chọn lại thư mục audio", "重新选择音频文件夹")
              : pick("Chọn thư mục audio", "选择音频文件夹")}
          </span>
          <span className="mt-2 text-sm text-slate-400">
            {items.length
              ? pick(
                  String(items.length) + " file đã được thêm",
                  "已添加 " + String(items.length) + " 个文件",
                )
              : pick(
                  "Mọi định dạng audio, gồm AAC, FLAC, M4A, MP3, WAV... · chỉ hiển thị đường dẫn tương đối",
                  "支持所有音频格式，包括 AAC、FLAC、M4A、MP3、WAV 等 · 仅显示相对路径",
                )}
          </span>
        </button>

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.4fr_0.6fr]">
          <div>
            <p className="text-sm font-semibold text-slate-200">
              02 · {pick("Chế độ nhận diện", "识别模式")}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(
                ["standard", "cloudflare_batch_chunks"] as AudioCheckMode[]
              ).map((value) => {
                const selected = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    disabled={isProcessing}
                    aria-pressed={selected}
                    className={
                      "rounded-2xl border p-4 text-left transition disabled:cursor-wait disabled:opacity-60 " +
                      (selected
                        ? "border-cyan-400 bg-cyan-400/10 ring-1 ring-cyan-400/30"
                        : "border-slate-700 bg-slate-950/50 hover:border-slate-500")
                    }
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-white">
                        {modeLabels[value]}
                      </span>
                      <span
                        className={
                          "size-3 rounded-full border " +
                          (selected
                            ? "border-cyan-300 bg-cyan-300"
                            : "border-slate-500")
                        }
                      />
                    </span>
                    <span className="mt-2 block text-xs leading-5 text-slate-400">
                      {value === "standard"
                        ? pick(
                            "Gửi lần lượt từng file trong một request riêng.",
                            "依次为每个文件发送单独请求。",
                          )
                        : pick(
                            "Chia từng file thành chunks, upload rồi finalize.",
                            "将每个文件分块上传后再完成处理。",
                          )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block text-sm font-medium text-slate-300">
            <span className="mb-3 block">
              {pick("Ngữ cảnh xử lý", "处理场景")}
            </span>
            <select
              value={context}
              onChange={(event) =>
                setContext(event.target.value as PracticeContext)
              }
              disabled={isProcessing}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white outline-none ring-cyan-400 focus:ring-2 disabled:opacity-60"
            >
              <option value="home">{pick("Ở nhà", "在家")}</option>
              <option value="school">{pick("Trường học", "学校")}</option>
              <option value="outside">{pick("Bên ngoài", "户外")}</option>
            </select>
          </label>
        </div>

        <button
          type="button"
          onClick={() => void runAllChecks()}
          disabled={!validItemCount || isProcessing}
          className="mt-6 w-full rounded-xl bg-cyan-400 px-5 py-3.5 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {isProcessing
            ? pick(
                "Đang xử lý " + activeFileLabel,
                "正在处理 " + activeFileLabel,
              )
            : pick(
                "Kiểm tra tất cả " + String(validItemCount) + " audio",
                "检查全部 " + String(validItemCount) + " 个音频",
              )}
        </button>

        {isProcessing ? (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
              <span className="min-w-0 truncate">{activeFileLabel}</span>
              <span className="shrink-0 font-mono">{overallProgress}%</span>
            </div>
            <div
              role="progressbar"
              aria-label={pick(
                "Tiến độ kiểm tra danh sách audio",
                "批量音频检查进度",
              )}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={overallProgress}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"
            >
              <div
                className="h-full rounded-full bg-cyan-400 transition-[width] duration-300"
                style={{ width: overallProgress + "%" }}
              />
            </div>
          </div>
        ) : null}
      </section>

      {error ? (
        <div
          role="alert"
          className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-5 py-4 text-sm font-medium text-rose-100"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-5 py-4 text-sm font-medium text-emerald-100"
        >
          {notice}
        </div>
      ) : null}

      <section className="rounded-3xl border border-white/10 bg-slate-900 p-5 shadow-xl shadow-slate-950/20 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">
              03 · {pick("Kết quả cuối cùng", "最终结果")}
            </p>
            <h2 className="mt-2 text-xl font-semibold text-white">
              {pick("Đường dẫn audio và đánh giá", "音频路径与评估")}
            </h2>
          </div>
          {items.length ? (
            <div className="flex flex-col items-start gap-3 sm:items-end">
              <button
                type="button"
                onClick={exportResults}
                disabled={isProcessing}
                className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2.5 text-sm font-bold text-emerald-200 transition hover:bg-emerald-400/20 disabled:cursor-wait disabled:opacity-60"
              >
                ↓ {pick("Xuất Excel", "导出 Excel")}
              </button>
              <div className="flex flex-wrap gap-2 text-xs font-semibold">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-slate-300">
                  {pick("Đã xử lý", "已处理")} {settledCount}/{items.length}
                </span>
                <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-emerald-200">
                  {pick("Đúng", "正确")} {approvedCount}
                </span>
                <span className="rounded-full border border-rose-400/20 bg-rose-400/10 px-3 py-1.5 text-rose-200">
                  {pick("Lỗi", "错误")} {rejectedCount + failedCount}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {!items.length ? (
          <div className="mt-5 grid min-h-64 place-items-center rounded-2xl border border-dashed border-slate-700 bg-slate-950/40 p-8 text-center">
            <div>
              <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-violet-400/10 text-2xl text-violet-300">
                ≋
              </span>
              <p className="mt-4 font-semibold text-slate-200">
                {pick("Chưa có danh sách audio", "暂无音频列表")}
              </p>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
                {pick(
                  "Chọn một thư mục audio ở phía trên để tạo danh sách kết quả.",
                  "在上方选择一个音频文件夹以创建结果列表。",
                )}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-700">
            <div className="hidden grid-cols-[minmax(220px,0.9fr)_minmax(320px,1.45fr)_minmax(190px,0.65fr)] gap-4 border-b border-slate-700 bg-slate-950/80 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 lg:grid">
              <span>{pick("Đường dẫn audio", "音频路径")}</span>
              <span>{pick("Kết quả nhận diện", "识别结果")}</span>
              <span>{pick("Đánh giá", "评估")}</span>
            </div>

            <div className="divide-y divide-slate-700">
              {items.map((item, index) => (
                <article
                  key={item.id}
                  className="grid gap-5 bg-slate-950/40 p-4 lg:grid-cols-[minmax(220px,0.9fr)_minmax(320px,1.45fr)_minmax(190px,0.65fr)]"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 lg:hidden">
                      {pick("Đường dẫn audio", "音频路径")}
                    </p>
                    <p className="mt-1 break-all font-semibold text-white lg:mt-0">
                      <span className="mr-2 text-slate-500">
                        {String(index + 1)}.
                      </span>
                      {getAudioRelativePath(item.file)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatBytes(item.file.size)}
                    </p>
                    {item.previewUrl ? (
                      <audio
                        controls
                        preload="metadata"
                        src={item.previewUrl}
                        className="mt-3 h-10 w-full"
                      >
                        {pick(
                          "Trình duyệt không phát được audio này.",
                          "浏览器无法播放此音频。",
                        )}
                      </audio>
                    ) : null}
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 lg:hidden">
                      {pick("Kết quả nhận diện", "识别结果")}
                    </p>
                    {item.result ? (
                      <div className="mt-2 space-y-3 lg:mt-0">
                        <div>
                          <p className="text-xs text-slate-500">
                            {pick("Tiếng Việt", "越南语")}
                          </p>
                          <p className="mt-1 leading-6 text-white">
                            {item.result.conversation.vietnameseText}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500">
                            {pick("Tiếng Anh", "英语")}
                          </p>
                          <p className="mt-1 text-sm leading-6 text-slate-300">
                            {item.result.conversation.englishText}
                          </p>
                        </div>
                        <p className="text-xs text-slate-500">
                          {modeLabels[item.result.mode]} · ASR{" "}
                          {item.result.conversation.latency.asrMs} ms ·{" "}
                          {item.result.totalMs} ms · {item.result.chunkCount}{" "}
                          chunks
                        </p>
                      </div>
                    ) : item.error ? (
                      <p className="mt-2 rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-sm leading-6 text-rose-200 lg:mt-0">
                        {item.error}
                      </p>
                    ) : (
                      <div className="mt-2 lg:mt-0">
                        <p className="text-sm text-slate-400">
                          {item.processingStatus === "processing"
                            ? pick(
                                "Đang gửi audio tới hệ thống nhận diện…",
                                "正在将音频发送到识别系统…",
                              )
                            : pick("Đang chờ tới lượt xử lý.", "正在等待处理。")}
                        </p>
                        {item.processingStatus === "processing" ? (
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800">
                            <div
                              className="h-full rounded-full bg-cyan-400 transition-[width] duration-300"
                              style={{ width: item.progress + "%" }}
                            />
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 lg:hidden">
                      {pick("Đánh giá", "评估")}
                    </p>
                    <span
                      className={
                        "mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-semibold lg:mt-0 " +
                        itemStatusClasses(item)
                      }
                    >
                      {itemStatusLabel(item)}
                    </span>

                    {item.result ? (
                      <div className="mt-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                          <button
                            type="button"
                            onClick={() => void saveReview(item.id, "approved")}
                            disabled={
                              isProcessing || Boolean(item.pendingReview)
                            }
                            className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2.5 text-sm font-bold text-emerald-200 transition hover:bg-emerald-400/20 disabled:cursor-wait disabled:opacity-60"
                          >
                            {item.pendingReview === "approved"
                              ? pick("Đang lưu…", "保存中…")
                              : "✓ " + pick("Đúng", "正确")}
                          </button>
                          <button
                            type="button"
                            onClick={() => openErrorReason(item.id)}
                            disabled={
                              isProcessing || Boolean(item.pendingReview)
                            }
                            aria-expanded={item.showErrorReason}
                            className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2.5 text-sm font-bold text-rose-200 transition hover:bg-rose-400/20 disabled:cursor-wait disabled:opacity-60"
                          >
                            × {pick("Lỗi", "错误")}
                          </button>
                        </div>

                        {item.showErrorReason ? (
                          <div className="rounded-xl border border-rose-400/20 bg-rose-400/5 p-3">
                            <label className="block text-xs font-semibold text-rose-100">
                              <span className="mb-2 block">
                                {pick("Chọn loại lỗi", "选择错误类型")}
                              </span>
                              <select
                                value={item.errorReason}
                                onChange={(event) =>
                                  updateItem(item.id, (current) => ({
                                    ...current,
                                    errorReason: event.target
                                      .value as AudioErrorReason,
                                  }))
                                }
                                disabled={Boolean(item.pendingReview)}
                                className="w-full rounded-lg border border-rose-400/20 bg-slate-950 px-3 py-2 text-sm text-white outline-none ring-rose-400 focus:ring-2 disabled:opacity-60"
                              >
                                <option value="">
                                  {pick("Chọn một trường…", "请选择…")}
                                </option>
                                <option value="translation_error">
                                  {errorReasonLabels.translation_error}
                                </option>
                                <option value="spelling_error">
                                  {errorReasonLabels.spelling_error}
                                </option>
                              </select>
                            </label>
                            <button
                              type="button"
                              onClick={() =>
                                void saveReview(
                                  item.id,
                                  "rejected",
                                  item.errorReason,
                                )
                              }
                              disabled={
                                !item.errorReason ||
                                isProcessing ||
                                Boolean(item.pendingReview)
                              }
                              className="mt-2 w-full rounded-lg bg-rose-400 px-3 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-rose-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                            >
                              {item.pendingReview === "rejected"
                                ? pick("Đang lưu…", "保存中…")
                                : pick("Lưu đánh giá lỗi", "保存错误评估")}
                            </button>
                          </div>
                        ) : item.reviewStatus === "rejected" &&
                          item.errorReason ? (
                          <p className="rounded-lg bg-rose-400/5 px-3 py-2 text-xs leading-5 text-rose-200">
                            {pick("Loại lỗi", "错误类型")}:{" "}
                            {
                              errorReasonLabels[
                                item.errorReason as SelectedAudioErrorReason
                              ]
                            }
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
