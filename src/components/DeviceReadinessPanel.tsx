"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";
import type {
  DeviceReadiness,
  ReadinessSignal,
  ReadinessState,
} from "@/hooks/useDeviceReadiness";
import type { AsrMode } from "@/types/conversation";

type DeviceReadinessPanelProps = {
  readiness: DeviceReadiness;
  selectedMode: Exclude<AsrMode, "text">;
  effectiveMode?: Exclude<AsrMode, "text">;
  fallbackReason?: string;
  audioInputLabel?: string;
  isBluetoothInput?: boolean;
  initialNoiseRms?: number;
  onRefresh: () => void;
};

const swatchByState: Record<ReadinessState, string> = {
  ready: "bg-emerald-500",
  warning: "bg-amber-500",
  blocked: "bg-red-500",
  unknown: "bg-slate-400",
};

function SignalRow({ signal }: { signal: ReadinessSignal }) {
  return (
    <div className="min-w-0 border-t border-slate-100 py-3 first:border-0">
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${swatchByState[signal.state]}`}
          aria-hidden="true"
        />
        <p className="break-words text-sm font-semibold text-slate-800">
          {signal.label}
        </p>
      </div>
      <p className="mt-1 pl-[18px] text-xs text-slate-500">{signal.detail}</p>
    </div>
  );
}

export function DeviceReadinessPanel({
  readiness,
  selectedMode,
  effectiveMode,
  fallbackReason,
  audioInputLabel,
  isBluetoothInput,
  initialNoiseRms,
  onRefresh,
}: DeviceReadinessPanelProps) {
  const { pick } = useUiLocale();
  const runtimeMode = effectiveMode ?? selectedMode;

  return (
    <section className="border-y border-slate-200 bg-white">
      <div className="mx-auto max-w-5xl px-5 py-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {pick("Khả năng thiết bị", "设备能力")}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {readiness.recommendationReason}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-sm font-semibold text-blue-700">
              {runtimeMode === "browser_streaming"
                ? pick("Đang dùng Streaming", "正在使用流式识别")
                : pick("Đang dùng Batch chunks", "正在使用分块批处理")}
            </p>
            <button
              type="button"
              onClick={onRefresh}
              disabled={readiness.isChecking}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {readiness.isChecking
                ? pick("Đang kiểm tra…", "正在检测…")
                : pick("Kiểm tra lại", "重新检测")}
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-x-5 md:grid-cols-5">
          <SignalRow signal={readiness.browser} />
          <SignalRow signal={readiness.recognition} />
          <SignalRow signal={readiness.network} />
          <SignalRow signal={readiness.microphone} />
          <SignalRow signal={readiness.bluetooth} />
        </div>

        {audioInputLabel || initialNoiseRms !== undefined || fallbackReason ? (
          <div className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-600">
            {audioInputLabel ? (
              <span className="mr-4">
                {pick("Đầu vào", "输入")}: {audioInputLabel}
                {isBluetoothInput ? " (Bluetooth)" : ""}
              </span>
            ) : null}
            {initialNoiseRms !== undefined ? (
              <span className="mr-4">
                {pick("Nền âm thanh", "环境噪声")}: {initialNoiseRms.toFixed(3)} RMS
              </span>
            ) : null}
            {fallbackReason ? (
              <span className="font-semibold text-amber-700">
                {pick("Dự phòng", "回退")}: {fallbackReason}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
