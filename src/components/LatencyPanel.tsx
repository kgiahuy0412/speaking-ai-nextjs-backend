"use client";

import { useUiLocale } from "@/components/UiLocaleProvider";
import type { ConversationLatency } from "@/types/conversation";

type LatencyPanelProps = {
  latency?: ConversationLatency;
};

const emptyLatency: ConversationLatency = {
  asrMs: 0,
  llmMs: 0,
  ttsMs: 0,
  timeToFirstAudioMs: 0,
};

export function LatencyPanel({ latency = emptyLatency }: LatencyPanelProps) {
  const { pick } = useUiLocale();
  const items = [
    ["ASR", latency.asrMs],
    ["LLM", latency.llmMs],
    ["TTS", latency.ttsMs],
    [pick("Audio đầu tiên", "首个音频"), latency.timeToFirstAudioMs],
    [pick("ASR delta đầu", "ASR 首次增量"), latency.asrFirstDeltaMs],
    [pick("ASR cuối/Dừng", "ASR 完成/停止"), latency.asrFinalAfterStopMs],
    [pick("Tải audio", "音频加载"), latency.audioLoadMs],
    [pick("TTS byte đầu", "TTS 首字节"), latency.ttsFirstByteMs],
    [pick("Audio phát/Dừng", "音频播放/停止"), latency.audioStartedAfterStopMs],
  ];

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {items
        .filter(([, value]) => typeof value === "number")
        .map(([label, value]) => (
        <div
          key={label}
          className="rounded-md border border-slate-200 bg-white p-3"
        >
          <p className="text-xs font-semibold uppercase text-slate-500">
            {label}
          </p>
          <p className="mt-1 text-xl font-semibold text-slate-950">
            {value}ms
          </p>
        </div>
        ))}
    </div>
  );
}
