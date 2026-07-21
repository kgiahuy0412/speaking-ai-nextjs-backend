"use client";

import { useEffect, useRef, useState } from "react";
import { useUiLocale } from "@/components/UiLocaleProvider";

type AudioPlayerProps = {
  audioUrl?: string | null;
  englishText?: string;
  onFirstByte?: (responseStartAt: number) => void;
  onPlaybackStarted?: () => void;
};

export function AudioPlayer({
  audioUrl,
  englishText,
  onFirstByte,
  onPlaybackStarted,
}: AudioPlayerProps) {
  const { pick } = useUiLocale();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    if (!audioUrl) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const audio = audioRef.current;

      if (!audio) {
        return;
      }

      setAutoplayBlocked(false);

      try {
        audio.currentTime = 0;
      } catch {
        // Some browsers do not allow seeking before metadata is ready.
      }

      void audio.play().catch(() => {
        setAutoplayBlocked(true);
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [audioUrl]);

  function speak() {
    if (!englishText || typeof window === "undefined") {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(englishText);
    utterance.lang = "en-US";
    utterance.rate = 0.85;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function reportFirstByte(event: React.SyntheticEvent<HTMLAudioElement>) {
    if (!audioUrl || !onFirstByte) {
      return;
    }

    const requestedUrl = new URL(audioUrl, window.location.href).href;
    const currentUrl = event.currentTarget.currentSrc;
    const entries = [
      ...performance.getEntriesByName(requestedUrl, "resource"),
      ...(currentUrl === requestedUrl
        ? []
        : performance.getEntriesByName(currentUrl, "resource")),
    ] as PerformanceResourceTiming[];
    const responseStartAt =
      entries.sort((a, b) => b.startTime - a.startTime)[0]?.responseStart ??
      performance.now();

    onFirstByte(responseStartAt);
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <p className="text-sm font-semibold text-slate-800">
        {pick("Phát âm thanh", "播放音频")}
      </p>
      <p className="mt-1 text-sm text-slate-500">
        {pick(
          "Audio cache hoặc luồng TTS sẽ phát tại đây.",
          "缓存音频或 TTS 音频流将在这里播放。",
        )}
      </p>
      {audioUrl ? (
        <>
          <audio
            ref={audioRef}
            className="mt-3 w-full"
            controls
            preload="auto"
            src={audioUrl}
            onLoadedData={reportFirstByte}
            onPlaying={onPlaybackStarted}
          />
          {autoplayBlocked ? (
            <p className="mt-2 text-xs font-medium text-amber-700">
              {pick(
                "Trình duyệt đang chặn tự phát. Bấm phát để nghe câu tiếng Anh.",
                "浏览器阻止了自动播放，请点击播放收听英文句子。",
              )}
            </p>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          onClick={speak}
          disabled={!englishText}
          className="mt-3 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {pick("Đọc câu tiếng Anh", "朗读英文句子")}
        </button>
      )}
    </div>
  );
}
