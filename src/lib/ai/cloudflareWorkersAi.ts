import { AppError } from "@/lib/errors";
import {
  buildCloudflareAudioTranslationBody,
  buildCloudflareAudioTranscriptionBody,
  type CloudflareWorkersAiEnvelope,
} from "./cloudflareWorkersAiRequest";

const DEFAULT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const DEFAULT_TIMEOUT_MS = 6_000;

export type AudioTranslationResult = {
  englishText: string;
  wordCount?: number;
  segments?: unknown[];
  vtt?: string;
  model: string;
};

export type AudioTranscriptionResult = {
  vietnameseText: string;
  wordCount?: number;
  segments?: unknown[];
  vtt?: string;
  model: string;
};

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

export function getCloudflareAudioTranslationConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim();
  const model =
    process.env.CLOUDFLARE_WORKERS_AI_MODEL?.trim() || DEFAULT_MODEL;

  if (!accountId || !apiToken) {
    throw new AppError(
      "ASR_FAILED",
      "Máy chủ chưa được cấu hình Cloudflare Workers AI.",
      503,
    );
  }

  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
    throw new AppError(
      "ASR_FAILED",
      "Model Cloudflare Workers AI không hợp lệ.",
      500,
    );
  }

  return {
    accountId,
    apiToken,
    model,
    timeoutMs: positiveInteger(
      "CLOUDFLARE_WORKERS_AI_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

export function getCloudflareAudioMaxBytes() {
  return positiveInteger("CLOUDFLARE_AUDIO_MAX_BYTES", 10 * 1024 * 1024);
}

export async function translateAudioToEnglish(
  audio: File,
  sourceLanguage: string,
): Promise<AudioTranslationResult> {
  const config = getCloudflareAudioTranslationConfig();
  const body = buildCloudflareAudioTranslationBody(
    await audio.arrayBuffer(),
    sourceLanguage,
  );

  let response: Response;

  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai/run/${config.model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
        cache: "no-store",
      },
    );
  } catch {
    throw new AppError(
      "ASR_FAILED",
      "Không kết nối được Cloudflare Workers AI. Vui lòng thử lại.",
      502,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | CloudflareWorkersAiEnvelope
    | null;
  const result = payload?.result;
  const englishText =
    typeof result?.text === "string" ? result.text.trim() : "";

  if (!response.ok || payload?.success === false || !englishText) {
    throw new AppError(
      "ASR_FAILED",
      response.status === 429
        ? "Cloudflare Workers AI đang quá tải. Vui lòng thử lại sau."
        : "Cloudflare Workers AI không dịch được đoạn ghi âm này.",
      response.status === 429 ? 429 : 502,
    );
  }

  return {
    englishText,
    wordCount:
      typeof result?.word_count === "number" ? result.word_count : undefined,
    segments: Array.isArray(result?.segments) ? result.segments : undefined,
    vtt: typeof result?.vtt === "string" ? result.vtt : undefined,
    model: config.model,
  };
}

export async function transcribeAudioToVietnamese(
  audio: File,
): Promise<AudioTranscriptionResult> {
  const config = getCloudflareAudioTranslationConfig();
  const body = buildCloudflareAudioTranscriptionBody(
    await audio.arrayBuffer(),
    "vi",
  );

  let response: Response;

  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai/run/${config.model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
        cache: "no-store",
      },
    );
  } catch {
    throw new AppError(
      "ASR_FAILED",
      "Không kết nối được Cloudflare Workers AI. Vui lòng thử lại.",
      502,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | CloudflareWorkersAiEnvelope
    | null;
  const result = payload?.result;
  const vietnameseText =
    typeof result?.text === "string" ? result.text.trim() : "";

  if (!response.ok || payload?.success === false || !vietnameseText) {
    throw new AppError(
      "ASR_FAILED",
      response.status === 429
        ? "Cloudflare Workers AI đang quá tải. Vui lòng thử lại sau."
        : "Cloudflare Workers AI không nhận diện được đoạn ghi âm này.",
      response.status === 429 ? 429 : 502,
    );
  }

  return {
    vietnameseText,
    wordCount:
      typeof result?.word_count === "number" ? result.word_count : undefined,
    segments: Array.isArray(result?.segments) ? result.segments : undefined,
    vtt: typeof result?.vtt === "string" ? result.vtt : undefined,
    model: config.model,
  };
}
