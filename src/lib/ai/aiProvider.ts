import type { ApiErrorCode, AudioSource, TextSource } from "@/types/conversation";
import { AppError } from "@/lib/appError";
import { getOpenAIClient } from "./openai";

const defaultCloudflareAsrModel = "@cf/openai/whisper-large-v3-turbo";
const defaultCloudflareTextModel = "@cf/qwen/qwen3-30b-a3b-fp8";
const defaultCloudflareTtsModel = "@cf/deepgram/aura-1";

type ProviderErrorCode = Extract<
  ApiErrorCode,
  "ASR_FAILED" | "LLM_FAILED" | "TTS_FAILED"
>;

export type AiProvider = "openai" | "cloudflare";

type PrimaryProviderEnvironment =
  | "AI_ASR_PRIMARY_PROVIDER"
  | "AI_TEXT_PRIMARY_PROVIDER"
  | "AI_TTS_PRIMARY_PROVIDER";

export type TextGenerationResult = {
  text: string;
  provider: Extract<TextSource, "openai" | "cloudflare">;
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
  source: Extract<AudioSource, "openai_tts" | "cloudflare_tts">;
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

function getPrimaryProvider(environmentName: PrimaryProviderEnvironment) {
  return process.env[environmentName]?.trim().toLowerCase() === "openai"
    ? ("openai" as const)
    : ("cloudflare" as const);
}

export function isOpenAIConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
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
      "Backend chưa được cấu hình OpenAI hoặc Cloudflare Workers AI.",
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
      "Model Cloudflare Workers AI không hợp lệ.",
      500,
    );
  }

  return model;
}

function cloudflareRunUrl(accountId: string, model: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

function cloudflareOpenAiUrl(accountId: string, resource: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/${resource}`;
}

function providerStatus(status: number) {
  return status === 429 ? 429 : 502;
}

function providerMessage(status: number, fallback: string) {
  if (status === 429) {
    return "Dịch vụ AI đang quá tải. Vui lòng thử lại sau.";
  }

  return fallback;
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
        ? "Dịch vụ AI phản hồi quá chậm. Vui lòng thử lại."
        : "Không kết nối được dịch vụ AI. Vui lòng thử lại.",
      502,
    );
  }
}

export function getTextAiProfile() {
  const primaryProvider = getPrimaryProvider("AI_TEXT_PRIMARY_PROVIDER");

  if (
    primaryProvider === "cloudflare" &&
    isCloudflareWorkersAiConfigured()
  ) {
    return {
      provider: "cloudflare" as const,
      model: requireModel(
        process.env.CLOUDFLARE_TEXT_MODEL,
        defaultCloudflareTextModel,
        "LLM_FAILED",
      ),
    };
  }

  if (primaryProvider === "openai" && isOpenAIConfigured()) {
    return {
      provider: "openai" as const,
      model: process.env.OPENAI_FAST_TEXT_MODEL?.trim() || "gpt-4o-mini",
    };
  }

  if (isCloudflareWorkersAiConfigured()) {
    return {
      provider: "cloudflare" as const,
      model: requireModel(
        process.env.CLOUDFLARE_TEXT_MODEL,
        defaultCloudflareTextModel,
        "LLM_FAILED",
      ),
    };
  }

  if (isOpenAIConfigured()) {
    return {
      provider: "openai" as const,
      model: process.env.OPENAI_FAST_TEXT_MODEL?.trim() || "gpt-4o-mini",
    };
  }

  throw new AppError(
    "LLM_FAILED",
    "Backend chưa được cấu hình OpenAI hoặc Cloudflare Workers AI.",
    503,
  );
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
  if (profile.provider === "openai") {
    const response = await getOpenAIClient().responses.create(
      {
        model: profile.model,
        instructions: options.instructions,
        input: options.input,
        max_output_tokens: options.maxOutputTokens,
      },
      { timeout: options.timeoutMs },
    );

    return {
      text: response.output_text.trim(),
      provider: "openai",
      model: profile.model,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  }

  const config = requireCloudflareConfig("LLM_FAILED");
  const response = await fetchProvider(
    cloudflareOpenAiUrl(config.accountId, "chat/completions"),
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
        "Cloudflare Workers AI chưa sinh được câu tiếng Anh.",
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

async function transcribeVietnameseAudioWithOpenAI(audio: File) {
  const model = process.env.OPENAI_ASR_MODEL?.trim() || "gpt-4o-mini-transcribe";
  const transcription = await getOpenAIClient().audio.transcriptions.create(
    {
      file: audio,
      model,
      language: "vi",
      prompt:
        "Vietnamese child speaking short everyday phrases for English practice.",
    },
    {
      timeout: positiveInteger("OPENAI_ASR_TIMEOUT_MS", 15_000),
    },
  );

  return { text: transcription.text.trim(), provider: "openai" as const, model };
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
      "Tệp audio vượt quá giới hạn của Cloudflare Workers AI.",
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
          "Trẻ em nói tiếng Việt, câu ngắn dùng trong giao tiếp hằng ngày.",
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
        "Cloudflare Workers AI chưa nhận diện được đoạn ghi âm.",
      ),
      providerStatus(response.status),
    );
  }

  return { text: text.trim(), provider: "cloudflare" as const, model };
}

export async function transcribeVietnameseAudio(audio: File) {
  const primaryProvider = getPrimaryProvider("AI_ASR_PRIMARY_PROVIDER");

  if (primaryProvider === "cloudflare" && isCloudflareWorkersAiConfigured()) {
    try {
      return await transcribeVietnameseAudioWithCloudflare(audio);
    } catch (error) {
      if (!isOpenAIConfigured()) {
        throw error;
      }
      return transcribeVietnameseAudioWithOpenAI(audio);
    }
  }

  if (primaryProvider === "openai" && isOpenAIConfigured()) {
    return transcribeVietnameseAudioWithOpenAI(audio);
  }

  if (isCloudflareWorkersAiConfigured()) {
    return transcribeVietnameseAudioWithCloudflare(audio);
  }

  if (isOpenAIConfigured()) {
    return transcribeVietnameseAudioWithOpenAI(audio);
  }

  throw new AppError(
    "ASR_FAILED",
    "Backend chưa được cấu hình OpenAI hoặc Cloudflare Workers AI.",
    503,
  );
}

export function getConfiguredTtsProfile(): TtsProfile {
  const primaryProvider = getPrimaryProvider("AI_TTS_PRIMARY_PROVIDER");

  if (
    primaryProvider === "cloudflare" &&
    isCloudflareWorkersAiConfigured()
  ) {
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

  if (primaryProvider === "openai" && isOpenAIConfigured()) {
    const configuredSpeed = Number(process.env.OPENAI_TTS_SPEED ?? 0.9);
    return {
      provider: "openai",
      model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
      voice: process.env.OPENAI_TTS_VOICE?.trim() || "alloy",
      speed:
        Number.isFinite(configuredSpeed) &&
        configuredSpeed >= 0.25 &&
        configuredSpeed <= 4
          ? configuredSpeed
          : 0.9,
      extension: "mp3",
    };
  }

  if (isCloudflareWorkersAiConfigured()) {
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

  if (isOpenAIConfigured()) {
    const configuredSpeed = Number(process.env.OPENAI_TTS_SPEED ?? 0.9);
    return {
      provider: "openai",
      model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
      voice: process.env.OPENAI_TTS_VOICE?.trim() || "alloy",
      speed:
        Number.isFinite(configuredSpeed) &&
        configuredSpeed >= 0.25 &&
        configuredSpeed <= 4
          ? configuredSpeed
          : 0.9,
      extension: "mp3",
    };
  }

  throw new AppError(
    "TTS_FAILED",
    "Backend chưa được cấu hình OpenAI hoặc Cloudflare Workers AI.",
    503,
  );
}

export function getTtsFallbackProfile(profile: TtsProfile) {
  if (profile.provider !== "cloudflare" || !isOpenAIConfigured()) {
    return null;
  }

  const configuredSpeed = Number(process.env.OPENAI_TTS_SPEED ?? 0.9);
  return {
    provider: "openai" as const,
    model: process.env.OPENAI_TTS_MODEL?.trim() || "tts-1",
    voice: process.env.OPENAI_TTS_VOICE?.trim() || "alloy",
    speed:
      Number.isFinite(configuredSpeed) &&
      configuredSpeed >= 0.25 &&
      configuredSpeed <= 4
        ? configuredSpeed
        : 0.9,
    extension: "mp3" as const,
  };
}

export async function generateAiText(options: {
  instructions: string;
  input: string;
  maxOutputTokens: number;
  timeoutMs: number;
}): Promise<TextGenerationResult> {
  const profile = getTextAiProfile();

  try {
    return await generateAiTextWithProfile(options, profile);
  } catch (error) {
    if (profile.provider !== "cloudflare" || !isOpenAIConfigured()) {
      throw error;
    }

    return generateAiTextWithProfile(options, {
      provider: "openai",
      model: process.env.OPENAI_FAST_TEXT_MODEL?.trim() || "gpt-4o-mini",
    });
  }
}

async function requestEnglishSpeechFromProvider(
  text: string,
  profile: TtsProfile,
): Promise<EnglishSpeechResult> {
  const timeoutMs =
    profile.provider === "openai"
      ? positiveInteger("OPENAI_TTS_TIMEOUT_MS", 12_000)
      : positiveInteger("CLOUDFLARE_TTS_TIMEOUT_MS", 20_000);
  let response: Response;

  if (profile.provider === "openai") {
    response = await fetchProvider(
      "https://api.openai.com/v1/audio/speech",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY?.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: profile.model,
          voice: profile.voice,
          input: text,
          response_format: "mp3",
          speed: profile.speed,
        }),
      },
      "TTS_FAILED",
      timeoutMs,
    );
  } else {
    const config = requireCloudflareConfig("TTS_FAILED");
    response = await fetchProvider(
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
      timeoutMs,
    );
  }

  if (!response.ok || !response.body) {
    throw new AppError(
      "TTS_FAILED",
      providerMessage(
        response.status,
        "Dịch vụ AI chưa tạo được audio tiếng Anh.",
      ),
      providerStatus(response.status),
    );
  }

  return {
    response,
    profile,
    source: (profile.provider === "openai"
      ? "openai_tts"
      : "cloudflare_tts") satisfies AudioSource,
  };
}

export async function requestEnglishSpeech(
  text: string,
  profile: TtsProfile,
): Promise<EnglishSpeechResult> {
  try {
    return await requestEnglishSpeechFromProvider(text, profile);
  } catch (error) {
    const fallbackProfile = getTtsFallbackProfile(profile);

    if (!fallbackProfile) {
      throw error;
    }

    return requestEnglishSpeechFromProvider(text, fallbackProfile);
  }
}
