"use client";

import { useRef, useState } from "react";
import {
  useUiLocale,
  type UiLocale,
} from "@/components/UiLocaleProvider";
import type {
  AsrMode,
  ConversationResponse,
  PracticeContext,
} from "@/types/conversation";

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  results: ArrayLike<{
    isFinal: boolean;
    0: {
      transcript: string;
      confidence?: number;
    };
  }>;
};

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

type UseConversationRecorderOptions = {
  context: PracticeContext;
  asrMode: Exclude<AsrMode, "text">;
  vadSilenceMs: number;
  onResult: (result: ConversationResponse, stoppedAt: number) => void;
  onError: (message: string) => void;
};

const chunkIntervalMs = 250;
const recordingTimeoutMs = 45_000;
const speechThreshold = 0.025;
const minimumAdaptiveSpeechThreshold = 0.012;
const maximumAdaptiveSpeechThreshold = 0.04;
const noiseToSpeechRatio = 2.5;
const minimumStreamingConfidence = 0.55;
const initialNoiseWindowMs = 500;
const preferredAudioConstraints: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  sampleRate: { ideal: 48_000 },
};

function isBluetoothLabel(label: string) {
  return /bluetooth|headset|headphone|earbud|airpod|wireless/i.test(label);
}

function getStreamingUnavailableReason(locale: UiLocale) {
  if (!navigator.onLine) {
    return locale === "zh" ? "没有网络连接。" : "Không có kết nối mạng.";
  }

  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string };
    }
  ).connection;

  if (
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  ) {
    return locale === "zh"
      ? "网络速度过慢，无法使用流式识别。"
      : "Mạng quá chậm cho Streaming.";
  }

  const speechWindow = window as SpeechWindow;

  if (
    !speechWindow.SpeechRecognition &&
    !speechWindow.webkitSpeechRecognition
  ) {
    return locale === "zh"
      ? "浏览器不支持流式 ASR 服务。"
      : "Trình duyệt không có dịch vụ Streaming ASR.";
  }

  return null;
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null);

  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }

  return `Request failed with status ${response.status}`;
}

function getBrowserLabel() {
  const userAgent = navigator.userAgent;

  if (userAgent.includes("Edg/")) return "edge";
  if (userAgent.includes("Chrome/")) return "chrome";
  if (userAgent.includes("Firefox/")) return "firefox";
  if (userAgent.includes("Safari/")) return "safari";
  return "other";
}

function getNetworkLabel() {
  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string };
    }
  ).connection;

  return connection?.effectiveType ?? "unknown";
}

export function useConversationRecorder({
  context,
  asrMode,
  vadSilenceMs,
  onResult,
  onError,
}: UseConversationRecorderOptions) {
  const { locale, pick } = useUiLocale();
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechDetected, setSpeechDetected] = useState(false);
  const [effectiveAsrMode, setEffectiveAsrMode] =
    useState<Exclude<AsrMode, "text">>(asrMode);
  const [fallbackReason, setFallbackReason] = useState<string | undefined>();
  const [audioInputLabel, setAudioInputLabel] = useState<string | undefined>();
  const [isBluetoothInput, setIsBluetoothInput] = useState(false);
  const [initialNoiseRms, setInitialNoiseRms] = useState<number | undefined>();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionEndedRef = useRef<Promise<void> | null>(null);
  const resolveRecognitionEndRef = useRef<(() => void) | null>(null);
  const browserTranscriptRef = useRef("");
  const finalBrowserTranscriptRef = useRef("");
  const recognitionHasFinalRef = useRef(false);
  const recognitionFailedRef = useRef(false);
  const recognitionConfidenceRef = useRef<number | undefined>(undefined);
  const effectiveAsrModeRef =
    useRef<Exclude<AsrMode, "text">>(asrMode);
  const fallbackReasonRef = useRef<string | undefined>(undefined);
  const audioInputLabelRef = useRef<string | undefined>(undefined);
  const isBluetoothInputRef = useRef(false);
  const initialNoiseRmsRef = useRef<number | undefined>(undefined);
  const audioSessionIdRef = useRef("");
  const uploadPromisesRef = useRef<Promise<void>[]>([]);
  const chunkSequenceRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const stoppedAtRef = useRef(0);
  const firstDeltaMsRef = useRef<number | undefined>(undefined);
  const asrFinalAtRef = useRef<number | undefined>(undefined);
  const stopRequestedRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  function stopVad() {
    if (vadFrameRef.current !== null) {
      window.cancelAnimationFrame(vadFrameRef.current);
      vadFrameRef.current = null;
    }

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  function stopRecording() {
    if (stopRequestedRef.current) {
      return;
    }

    stopRequestedRef.current = true;
    stoppedAtRef.current = performance.now();
    stopVad();
    recognitionRef.current?.stop();
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  function startVad(stream: MediaStream) {
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    const samples = new Uint8Array(analyser.fftSize);
    let heardSpeech = false;
    let lastSpeechAt = performance.now();
    const noiseWindowStartedAt = performance.now();
    let noiseTotal = 0;
    let noiseSamples = 0;
    let noiseReported = false;
    let adaptiveSpeechThreshold = speechThreshold;

    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.25;
    source.connect(analyser);
    audioContextRef.current = audioContext;

    const inspectAudio = () => {
      analyser.getByteTimeDomainData(samples);
      let squaredTotal = 0;

      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        squaredTotal += normalized * normalized;
      }

      const rms = Math.sqrt(squaredTotal / samples.length);
      const now = performance.now();

      if (!noiseReported && now - noiseWindowStartedAt <= initialNoiseWindowMs) {
        noiseTotal += rms;
        noiseSamples += 1;
      } else if (!noiseReported) {
        const measuredNoise =
          noiseSamples > 0 ? noiseTotal / noiseSamples : rms;
        initialNoiseRmsRef.current = measuredNoise;
        setInitialNoiseRms(measuredNoise);
        adaptiveSpeechThreshold = Math.max(
          minimumAdaptiveSpeechThreshold,
          Math.min(
            maximumAdaptiveSpeechThreshold,
            measuredNoise * noiseToSpeechRatio,
          ),
        );
        noiseReported = true;
      }

      if (rms >= adaptiveSpeechThreshold) {
        heardSpeech = true;
        lastSpeechAt = now;
        setSpeechDetected(true);
      } else if (heardSpeech && now - lastSpeechAt >= vadSilenceMs) {
        stopRecording();
        return;
      }

      vadFrameRef.current = window.requestAnimationFrame(inspectAudio);
    };

    vadFrameRef.current = window.requestAnimationFrame(inspectAudio);
  }

  async function uploadChunk(chunk: Blob, sequence: number) {
    const formData = new FormData();
    formData.append("sequence", sequence.toString());
    formData.append("audio", chunk, `chunk-${sequence}.webm`);
    const response = await fetch(
      `/api/audio-sessions/${audioSessionIdRef.current}/chunks`,
      {
        method: "POST",
        body: formData,
      },
    );

    if (!response.ok) {
      throw new Error(await responseError(response));
    }
  }

  async function finalizeRecording(mimeType: string) {
    setIsSubmitting(true);

    try {
      const uploadDrainStartedAt = performance.now();
      await Promise.all(uploadPromisesRef.current);
      const uploadDrainAfterStopMs = Math.max(
        0,
        Math.round(performance.now() - uploadDrainStartedAt),
      );

      if (
        effectiveAsrModeRef.current === "browser_streaming" &&
        recognitionEndedRef.current
      ) {
        await Promise.race([
          recognitionEndedRef.current,
          new Promise<void>((resolve) => window.setTimeout(resolve, 700)),
        ]);
      }

      const finalTranscript = finalBrowserTranscriptRef.current.trim();
      const confidence = recognitionConfidenceRef.current;
      const confidenceIsAcceptable =
        confidence === undefined ||
        confidence === 0 ||
        confidence >= minimumStreamingConfidence;
      const canTrustStreamingTranscript =
        effectiveAsrModeRef.current === "browser_streaming" &&
        recognitionHasFinalRef.current &&
        !recognitionFailedRef.current &&
        Boolean(finalTranscript) &&
        confidenceIsAcceptable;
      let sessionAsrMode = effectiveAsrModeRef.current;

      if (
        sessionAsrMode === "browser_streaming" &&
        !canTrustStreamingTranscript
      ) {
        sessionAsrMode = "batch_chunks";
        effectiveAsrModeRef.current = sessionAsrMode;
        setEffectiveAsrMode(sessionAsrMode);

        if (!fallbackReasonRef.current) {
          fallbackReasonRef.current = !recognitionHasFinalRef.current
            ? pick("Streaming không có transcript cuối.", "流式识别没有最终转写结果。")
            : pick("Transcript Streaming có độ tin cậy thấp.", "流式转写的置信度较低。");
          setFallbackReason(fallbackReasonRef.current);
        }
      }

      const finalizeRequestStartedAt = performance.now();
      const response = await fetch(
        `/api/audio-sessions/${audioSessionIdRef.current}/finalize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context,
            childAge: 6,
            targetLanguage: "en",
            sourceText: canTrustStreamingTranscript
              ? finalTranscript
              : undefined,
            asrMode: sessionAsrMode,
            mimeType,
            benchmark: {
              browser: getBrowserLabel(),
              device: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
                ? "mobile"
                : "desktop",
              network: getNetworkLabel(),
              utteranceDurationMs: Math.round(
                stoppedAtRef.current - recordingStartedAtRef.current,
              ),
              vadSilenceMs,
              requestedAsrMode: asrMode,
              streamingFallbackReason: fallbackReasonRef.current,
              audioInputLabel: audioInputLabelRef.current,
              bluetoothAudioInput: isBluetoothInputRef.current,
              initialNoiseRms: initialNoiseRmsRef.current,
            },
          }),
        },
      );

      if (!response.ok) {
        throw new Error(await responseError(response));
      }

      const result = (await response.json()) as ConversationResponse;
      const asrFinalAfterStopMs =
        result.asrMode === "browser_streaming" &&
        asrFinalAtRef.current !== undefined
          ? Math.max(
              0,
              Math.round(asrFinalAtRef.current - stoppedAtRef.current),
            )
          : Math.max(
              0,
              Math.round(
                finalizeRequestStartedAt -
                  stoppedAtRef.current +
                  result.latency.asrMs,
              ),
            );
      const latency = {
        asrFirstDeltaMs: firstDeltaMsRef.current,
        asrFinalAfterStopMs,
        uploadDrainAfterStopMs,
      };

      result.latency = { ...result.latency, ...latency };
      await fetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: result.conversationId,
          latency,
        }),
      });
      onResult(result, stoppedAtRef.current);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : pick("Không xử lý được audio.", "无法处理音频。"),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function startRecording() {
    onError("");
    setInterimTranscript("");
    setSpeechDetected(false);
    setFallbackReason(undefined);
    setInitialNoiseRms(undefined);
    browserTranscriptRef.current = "";
    finalBrowserTranscriptRef.current = "";
    recognitionHasFinalRef.current = false;
    recognitionFailedRef.current = false;
    recognitionConfidenceRef.current = undefined;
    fallbackReasonRef.current = undefined;
    initialNoiseRmsRef.current = undefined;
    uploadPromisesRef.current = [];
    chunkSequenceRef.current = 0;
    firstDeltaMsRef.current = undefined;
    asrFinalAtRef.current = undefined;
    stopRequestedRef.current = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      onError(pick("Trình duyệt không hỗ trợ ghi âm.", "浏览器不支持录音。"));
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: preferredAudioConstraints,
    });
    const inputLabel =
      stream.getAudioTracks()[0]?.label ||
      pick("Micro mặc định", "默认麦克风");
    audioInputLabelRef.current = inputLabel;
    isBluetoothInputRef.current = isBluetoothLabel(inputLabel);
    setAudioInputLabel(inputLabel);
    setIsBluetoothInput(isBluetoothInputRef.current);
    const sessionResponse = await fetch("/api/audio-sessions", {
      method: "POST",
    });

    if (!sessionResponse.ok) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error(await responseError(sessionResponse));
    }

    const session = (await sessionResponse.json()) as {
      audioSessionId: string;
    };
    audioSessionIdRef.current = session.audioSessionId;

    const mimeType = MediaRecorder.isTypeSupported(
      "audio/webm;codecs=opus",
    )
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    recordingStartedAtRef.current = performance.now();
    const unavailableReason =
      asrMode === "browser_streaming"
        ? getStreamingUnavailableReason(locale)
        : null;
    const sessionAsrMode =
      asrMode === "browser_streaming" && !unavailableReason
        ? "browser_streaming"
        : "batch_chunks";
    effectiveAsrModeRef.current = sessionAsrMode;
    setEffectiveAsrMode(sessionAsrMode);

    if (unavailableReason) {
      fallbackReasonRef.current = unavailableReason;
      setFallbackReason(unavailableReason);
    }

    if (sessionAsrMode === "browser_streaming") {
      const SpeechRecognition =
        ((window as SpeechWindow).SpeechRecognition ??
          (window as SpeechWindow)
            .webkitSpeechRecognition) as SpeechRecognitionConstructor;

      recognitionEndedRef.current = new Promise<void>((resolve) => {
        resolveRecognitionEndRef.current = resolve;
      });
      const recognition = new SpeechRecognition();
      recognition.lang = "vi-VN";
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.onresult = (event) => {
        const results = Array.from(event.results);
        const transcript = results
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();
        const finalResults = results.filter((result) => result.isFinal);
        const finalTranscript = finalResults
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();

        if (!transcript) {
          return;
        }

        if (firstDeltaMsRef.current === undefined) {
          firstDeltaMsRef.current = Math.round(
            performance.now() - recordingStartedAtRef.current,
          );
        }

        browserTranscriptRef.current = transcript;
        setInterimTranscript(transcript);

        if (finalTranscript) {
          finalBrowserTranscriptRef.current = finalTranscript;
          recognitionHasFinalRef.current = true;
          const confidenceValues = finalResults
            .map((result) => result[0]?.confidence)
            .filter(
              (value): value is number =>
                typeof value === "number" && Number.isFinite(value),
            );
          recognitionConfidenceRef.current =
            confidenceValues.length > 0
              ? confidenceValues.reduce((total, value) => total + value, 0) /
                confidenceValues.length
              : undefined;
        }

        if (finalTranscript && asrFinalAtRef.current === undefined) {
          asrFinalAtRef.current = performance.now();
        }
      };
      recognition.onerror = (event) => {
        recognitionFailedRef.current = true;
        finalBrowserTranscriptRef.current = "";
        const reason = event.error
          ? pick(
              `Dịch vụ Streaming lỗi ${event.error}.`,
              `流式识别服务错误：${event.error}。`,
            )
          : pick(
              "Dịch vụ Streaming không phản hồi.",
              "流式识别服务没有响应。",
            );
        fallbackReasonRef.current = reason;
        setFallbackReason(reason);
        resolveRecognitionEndRef.current?.();
      };
      recognition.onend = () => {
        resolveRecognitionEndRef.current?.();
      };
      recognitionRef.current = recognition;
      recognition.start();
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) {
        return;
      }

      const sequence = chunkSequenceRef.current++;
      uploadPromisesRef.current.push(uploadChunk(event.data, sequence));
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      recognitionRef.current = null;
      void finalizeRecording(mimeType);
    };

    mediaRecorderRef.current = recorder;
    recorder.start(chunkIntervalMs);
    setIsRecording(true);
    startVad(stream);
    timeoutRef.current = window.setTimeout(
      stopRecording,
      recordingTimeoutMs,
    );
  }

  async function toggleRecording() {
    if (isRecording) {
      stopRecording();
      return;
    }

    try {
      await startRecording();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : pick("Không thể bắt đầu ghi âm.", "无法开始录音。"),
      );
      setIsRecording(false);
      stopVad();
    }
  }

  return {
    isRecording,
    isSubmitting,
    interimTranscript,
    speechDetected,
    effectiveAsrMode,
    fallbackReason,
    audioInputLabel,
    isBluetoothInput,
    initialNoiseRms,
    toggleRecording,
  };
}
