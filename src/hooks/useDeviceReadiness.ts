"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useUiLocale,
  type UiLocale,
} from "@/components/UiLocaleProvider";
import type { AsrMode } from "@/types/conversation";

export type ReadinessState = "ready" | "warning" | "blocked" | "unknown";

export type ReadinessSignal = {
  state: ReadinessState;
  label: string;
  detail: string;
};

export type DeviceReadiness = {
  isChecking: boolean;
  recommendedMode: Exclude<AsrMode, "text">;
  recommendationReason: string;
  browser: ReadinessSignal;
  recognition: ReadinessSignal;
  network: ReadinessSignal;
  microphone: ReadinessSignal;
  bluetooth: ReadinessSignal;
};

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };

type NetworkInformationLike = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
};

function text(locale: UiLocale, vietnamese: string, chinese: string) {
  return locale === "zh" ? chinese : vietnamese;
}

function getInitialReadiness(locale: UiLocale): DeviceReadiness {
  const unknownSignal: ReadinessSignal = {
    state: "unknown",
    label: text(locale, "Đang kiểm tra", "正在检测"),
    detail: text(locale, "Chưa có dữ liệu.", "暂无数据。"),
  };

  return {
    isChecking: true,
    recommendedMode: "batch_chunks",
    recommendationReason: text(
      locale,
      "Đang kiểm tra khả năng của trình duyệt.",
      "正在检测浏览器能力。",
    ),
    browser: unknownSignal,
    recognition: unknownSignal,
    network: unknownSignal,
    microphone: unknownSignal,
    bluetooth: unknownSignal,
  };
}

function getBrowserName(locale: UiLocale) {
  const userAgent = navigator.userAgent;

  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("Chrome/")) return "Chrome";
  if (userAgent.includes("Firefox/")) return "Firefox";
  if (userAgent.includes("Safari/")) return "Safari";
  return text(locale, "Trình duyệt khác", "其他浏览器");
}

function supportsBrowserRecognition() {
  const speechWindow = window as SpeechWindow;
  return Boolean(
    speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition,
  );
}

function getNetworkInformation() {
  return (
    navigator as Navigator & { connection?: NetworkInformationLike }
  ).connection;
}

function isBluetoothLabel(label: string) {
  return /bluetooth|headset|headphone|earbud|airpod|wireless/i.test(label);
}

async function inspectMicrophone(locale: UiLocale) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      signal: {
        state: "blocked",
        label: text(locale, "Không hỗ trợ micro", "不支持麦克风"),
        detail: text(
          locale,
          "Trình duyệt không có getUserMedia.",
          "浏览器不支持 getUserMedia。",
        ),
      } satisfies ReadinessSignal,
      devices: [] as MediaDeviceInfo[],
    };
  }

  let permissionState: PermissionState | "unknown" = "unknown";

  try {
    const permission = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    permissionState = permission.state;
  } catch {
    // Some browsers expose the microphone but not its Permissions API entry.
  }

  let devices: MediaDeviceInfo[] = [];

  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    // Permission may be required before device labels can be enumerated.
  }

  const hasAudioInput = devices.some((device) => device.kind === "audioinput");

  if (permissionState === "denied") {
    return {
      signal: {
        state: "blocked",
        label: text(locale, "Micro bị chặn", "麦克风被阻止"),
        detail: text(
          locale,
          "Cần cấp lại quyền micro trong cài đặt trình duyệt.",
          "请在浏览器设置中重新授予麦克风权限。",
        ),
      } satisfies ReadinessSignal,
      devices,
    };
  }

  if (permissionState === "granted") {
    return {
      signal: {
        state: "ready",
        label: text(locale, "Micro sẵn sàng", "麦克风已就绪"),
        detail: hasAudioInput
          ? text(
              locale,
              "Đã cấp quyền và tìm thấy đầu vào âm thanh.",
              "已授权并检测到音频输入。",
            )
          : text(locale, "Đã cấp quyền micro.", "已获得麦克风权限。"),
      } satisfies ReadinessSignal,
      devices,
    };
  }

  return {
    signal: {
      state: hasAudioInput ? "warning" : "unknown",
      label: text(locale, "Cần xác nhận micro", "需要确认麦克风"),
      detail: text(
        locale,
        "Trình duyệt sẽ hỏi quyền khi bắt đầu ghi âm.",
        "开始录音时浏览器会请求权限。",
      ),
    } satisfies ReadinessSignal,
    devices,
  };
}

async function inspectReadiness(locale: UiLocale): Promise<DeviceReadiness> {
  const browserName = getBrowserName(locale);
  const mediaRecorderReady =
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const recognitionReady = supportsBrowserRecognition();
  const online = navigator.onLine;
  const network = getNetworkInformation();
  const effectiveType = network?.effectiveType ?? "unknown";
  const networkIsSlow = effectiveType === "slow-2g" || effectiveType === "2g";
  const { signal: microphone, devices } = await inspectMicrophone(locale);
  const bluetoothDevice = devices.find(
    (device) =>
      (device.kind === "audioinput" || device.kind === "audiooutput") &&
      isBluetoothLabel(device.label),
  );
  const canUseStreaming =
    mediaRecorderReady &&
    recognitionReady &&
    online &&
    !networkIsSlow &&
    microphone.state !== "blocked";

  return {
    isChecking: false,
    recommendedMode: canUseStreaming
      ? "browser_streaming"
      : "batch_chunks",
    recommendationReason: canUseStreaming
      ? text(
          locale,
          "Streaming sẵn sàng; Batch chunks vẫn được giữ làm dự phòng.",
          "流式识别已就绪；分块批处理仍作为回退方案。",
        )
      : text(
          locale,
          "Dùng Batch chunks vì một điều kiện Streaming chưa đạt.",
          "由于流式识别条件未满足，将使用分块批处理。",
        ),
    browser: {
      state: mediaRecorderReady ? "ready" : "blocked",
      label: browserName,
      detail: mediaRecorderReady
        ? text(locale, "Hỗ trợ ghi âm bằng MediaRecorder.", "支持使用 MediaRecorder 录音。")
        : text(locale, "Thiếu MediaRecorder hoặc getUserMedia.", "缺少 MediaRecorder 或 getUserMedia。"),
    },
    recognition: {
      state: recognitionReady ? "ready" : "blocked",
      label: recognitionReady
        ? text(locale, "Streaming ASR sẵn sàng", "流式 ASR 已就绪")
        : text(locale, "Không có Streaming ASR", "不支持流式 ASR"),
      detail: recognitionReady
        ? text(locale, "Trình duyệt có dịch vụ nhận dạng giọng nói.", "浏览器支持语音识别服务。")
        : text(locale, "Lượt nói sẽ dùng Batch ASR.", "本次语音将使用批量 ASR。"),
    },
    network: {
      state: !online ? "blocked" : networkIsSlow ? "warning" : "ready",
      label: !online
        ? text(locale, "Mất mạng", "网络已断开")
        : effectiveType === "unknown"
          ? text(locale, "Đang online", "网络在线")
          : `${text(locale, "Mạng", "网络")} ${effectiveType}`,
      detail: !online
        ? text(locale, "Cần kết nối mạng để xử lý AI.", "需要联网才能使用 AI 处理。")
        : networkIsSlow
          ? text(locale, "Mạng chậm; ưu tiên Batch để ổn định hơn.", "网络较慢；优先使用批处理以提高稳定性。")
          : `RTT ${network?.rtt ?? "?"}ms, downlink ${network?.downlink ?? "?"}Mbps.`,
    },
    microphone,
    bluetooth: bluetoothDevice
      ? {
          state: "ready",
          label: text(locale, "Có Bluetooth audio", "检测到蓝牙音频"),
          detail: bluetoothDevice.label,
        }
      : {
          state: "unknown",
          label: text(locale, "Bluetooth do hệ điều hành quản lý", "蓝牙由操作系统管理"),
          detail: text(
            locale,
            "Sẽ xác nhận đầu vào âm thanh sau khi cấp quyền micro.",
            "授予麦克风权限后将确认音频输入。",
          ),
        },
  };
}

export function useDeviceReadiness() {
  const { locale } = useUiLocale();
  const [readiness, setReadiness] =
    useState<DeviceReadiness>(() => getInitialReadiness(locale));

  const refresh = useCallback(async () => {
    setReadiness((current) => ({ ...current, isChecking: true }));

    try {
      setReadiness(await inspectReadiness(locale));
    } catch {
      setReadiness({
        ...getInitialReadiness(locale),
        isChecking: false,
        recommendationReason: text(
          locale,
          "Không kiểm tra được thiết bị; dùng Batch chunks để an toàn.",
          "无法检测设备；为安全起见使用分块批处理。",
        ),
      });
    }
  }, [locale]);

  useEffect(() => {
    const initialCheckId = window.setTimeout(() => {
      void refresh();
    }, 0);

    const handleChange = () => {
      void refresh();
    };

    window.addEventListener("online", handleChange);
    window.addEventListener("offline", handleChange);
    navigator.mediaDevices?.addEventListener?.("devicechange", handleChange);

    return () => {
      window.clearTimeout(initialCheckId);
      window.removeEventListener("online", handleChange);
      window.removeEventListener("offline", handleChange);
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        handleChange,
      );
    };
  }, [refresh]);

  return {
    ...readiness,
    refresh,
  };
}
