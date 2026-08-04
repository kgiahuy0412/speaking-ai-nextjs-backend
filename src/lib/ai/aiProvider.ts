import type { ApiErrorCode, AudioSource, TextSource } from "@/types/conversation";
import { AppError } from "@/lib/appError";

// `@cf/openai/...` is a model namespace in Cloudflare's catalog. Requests are
// still sent only to api.cloudflare.com; this does not use an OpenAI account.
const defaultCloudflareAsrModel = "@cf/openai/whisper-large-v3-turbo";
const defaultCloudflareTextModel = "@cf/qwen/qwen3-30b-a3b-fp8";
const defaultCloudflareTtsModel = "@cf/deepgram/aura-1";

type ProviderErrorCode = Extract<
  ApiErrorCode,
  "ASR_FAILED" | "LLM_FAILED" | "TTS_FAILED"
>;

export type AiProvider = "cloudflare";

export type TextGenerationResult = {
  text: string;
  provider: Extract<TextSource, "cloudflare">;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type TtsProfile = {
  provider: AiProvider;
  model: string;
  voice: string;
  speed: number;
  extension: "mp3";
};

export type EnglishSpeechResult = {
  response: Response;
  source: Extract<AudioSource, "cloudflare_tts">;
  profile: TtsProfile;
};

type CloudflareEnvelope<T> = {
  result?: T;
  success?: boolean;
  errors?: Array<{ message?: string }>;
};

type CloudflareAsrResult = {
  text?: unknown;
};

type CloudflareChatResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  errors?: Array<{ message?: string }>;
};

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function validCloudflareModel(value: string) {
  return /^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(value);
}

export function isCloudflareWorkersAiConfigured() {
  return Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() &&
      process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim(),
  );
}

function requireCloudflareConfig(errorCode: ProviderErrorCode) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim();

  if (!accountId || !apiToken) {
    throw new AppError(
      errorCode,
      "Backend chua duoc cau hinh Cloudflare Workers AI.",
      503,
    );
  }

  return { accountId, apiToken };
}

function requireModel(
  value: string | undefined,
  fallback: string,
  errorCode: ProviderErrorCode,
) {
  const model = value?.trim() || fallback;

  if (!validCloudflareModel(model)) {
    throw new AppError(
      errorCode,
      "Model Cloudflare Workers AI khong hop le.",
      500,
    );
  }

  return model;
}

function cloudflareRunUrl(accountId: string, model: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

function cloudflareOpenAiCompatibleUrl(accountId: string, resource: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/${resource}`;
}

function providerStatus(status: number) {
  return status === 429 ? 429 : 502;
}

function providerMessage(status: number, fallback: string) {
  return status === 429
    ? "Cloudflare Workers AI dang qua tai. Vui long thu lai sau."
    : fallback;
}

async function fetchProvider(
  url: string,
  init: RequestInit,
  errorCode: ProviderErrorCode,
  timeoutMs: number,
) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    throw new AppError(
      errorCode,
      error instanceof DOMException && error.name === "TimeoutError"
        ? "Cloudflare Workers AI phan hoi qua cham. Vui long thu lai."
        : "Khong ket noi duoc Cloudflare Workers AI. Vui long thu lai.",
      502,
    );
  }
}

export function getTextAiProfile() {
  requireCloudflareConfig("LLM_FAILED");
  return {
    provider: "cloudflare" as const,
    model: requireModel(
      process.env.CLOUDFLARE_TEXT_MODEL,
      defaultCloudflareTextModel,
      "LLM_FAILED",
    ),
  };
}

async function generateAiTextWithProfile(
  options: {
    instructions: string;
    input: string;
    maxOutputTokens: number;
    timeoutMs: number;
  },
  profile: ReturnType<typeof getTextAiProfile>,
): Promise<TextGenerationResult> {
  const config = requireCloudflareConfig("LLM_FAILED");
  const response = await fetchProvider(
    cloudflareOpenAiCompatibleUrl(config.accountId, "chat/completions"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: profile.model,
        messages: [
          {
            role: "system",
            content: profile.model.includes("/qwen3-")
              ? `/no_think\n${options.instructions}`
              : options.instructions,
          },
          { role: "user", content: options.input },
        ],
        max_tokens: Math.max(64, options.maxOutputTokens),
        temperature: 0,
      }),
    },
    "LLM_FAILED",
    options.timeoutMs,
  );
  const payload = (await response.json().catch(() => null)) as
    | CloudflareChatResponse
    | null;
  const text = payload?.choices?.[0]?.message?.content;
  const usage = payload?.usage;

  if (!response.ok || typeof text !== "string" || !text.trim()) {
    throw new AppError(
      "LLM_FAILED",
      providerMessage(
        response.status,
        "Cloudflare Workers AI chua sinh duoc cau tieng Anh.",
      ),
      providerStatus(response.status),
    );
  }

  return {
    text: text.trim(),
    provider: "cloudflare",
    model: profile.model,
    inputTokens:
      typeof usage?.prompt_tokens === "number"
        ? usage.prompt_tokens
        : undefined,
    outputTokens:
      typeof usage?.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined,
  };
}

async function transcribeVietnameseAudioWithCloudflare(audio: File) {
  const config = requireCloudflareConfig("ASR_FAILED");
  const model = requireModel(
    process.env.CLOUDFLARE_ASR_MODEL || process.env.CLOUDFLARE_WORKERS_AI_MODEL,
    defaultCloudflareAsrModel,
    "ASR_FAILED",
  );
  const maxBytes = positiveInteger("CLOUDFLARE_AUDIO_MAX_BYTES", 10 * 1024 * 1024);

  if (audio.size > maxBytes) {
    throw new AppError(
      "AUDIO_TOO_LONG",
      "Tep audio vuot qua gioi han cua Cloudflare Workers AI.",
      413,
    );
  }

  const response = await fetchProvider(
    cloudflareRunUrl(config.accountId, model),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: Buffer.from(await audio.arrayBuffer()).toString("base64"),
        task: "transcribe",
        language: "vi",
        vad_filter: true,
        condition_on_previous_text: false,
        initial_prompt:
          "Tre em noi tieng Viet, cau ngan dung trong giao tiep hang ngay.",
      }),
    },
    "ASR_FAILED",
    positiveInteger("CLOUDFLARE_ASR_TIMEOUT_MS", 6_000),
  );
  const payload = (await response.json().catch(() => null)) as
    | CloudflareEnvelope<CloudflareAsrResult>
    | null;
  const text = payload?.result?.text;

  if (!response.ok || typeof text !== "string" || !text.trim()) {
    throw new AppError(
      "ASR_FAILED",
      providerMessage(
        response.status,
        "Cloudflare Workers AI chua nhan dien duoc doan ghi am.",
      ),
      providerStatus(response.status),
    );
  }

  return { text: text.trim(), provider: "cloudflare" as const, model };
}

export async function transcribeVietnameseAudio(audio: File) {
  return transcribeVietnameseAudioWithCloudflare(audio);
}

export function getConfiguredTtsProfile(): TtsProfile {
  requireCloudflareConfig("TTS_FAILED");
  return {
    provider: "cloudflare",
    model: requireModel(
      process.env.CLOUDFLARE_TTS_MODEL,
      defaultCloudflareTtsModel,
      "TTS_FAILED",
    ),
    voice: process.env.CLOUDFLARE_TTS_SPEAKER?.trim() || "luna",
    speed: 1,
    extension: "mp3",
  };
}

export async function generateAiText(options: {
  instructions: string;
  input: string;
  maxOutputTokens: number;
  timeoutMs: number;
}): Promise<TextGenerationResult> {
  return generateAiTextWithProfile(options, getTextAiProfile());
}

export async function requestEnglishSpeech(
  text: string,
  profile: TtsProfile,
): Promise<EnglishSpeechResult> {
  const config = requireCloudflareConfig("TTS_FAILED");
  const response = await fetchProvider(
    cloudflareRunUrl(config.accountId, profile.model),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        speaker: profile.voice,
        encoding: "mp3",
      }),
    },
    "TTS_FAILED",
    positiveInteger("CLOUDFLARE_TTS_TIMEOUT_MS", 20_000),
  );

  if (!response.ok || !response.body) {
    throw new AppError(
      "TTS_FAILED",
      providerMessage(
        response.status,
        "Cloudflare Workers AI chua tao duoc audio tieng Anh.",
      ),
      providerStatus(response.status),
    );
  }

  return {
    response,
    profile,
    source: "cloudflare_tts",
  };
}
