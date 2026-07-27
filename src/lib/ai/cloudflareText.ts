// GLM-4.7 Flash spends its completion budget on mandatory reasoning before it
// emits the translation. Llama 4 Scout returns the requested text directly,
// which keeps the primary path both faster and less likely to fall back.
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const DEFAULT_TEXT_TIMEOUT_MS = 2_500;

type CloudflareChatEnvelope = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  errors?: Array<{ code?: number; message?: string }>;
};

export class CloudflareTextProviderError extends Error {
  constructor(
    readonly reason: string,
    readonly status?: number,
  ) {
    super(`Cloudflare text translation failed: ${reason}`);
    this.name = "CloudflareTextProviderError";
  }
}

function positiveInteger(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

export function isCloudflareTextConfigured() {
  return Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() &&
      process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim(),
  );
}

export function getCloudflareTextConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim();
  const model =
    process.env.CLOUDFLARE_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;

  if (!accountId || !apiToken) {
    throw new CloudflareTextProviderError("not_configured");
  }

  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
    throw new CloudflareTextProviderError("invalid_model");
  }

  return {
    accountId,
    apiToken,
    model,
    timeoutMs: positiveInteger(
      "CLOUDFLARE_TEXT_TIMEOUT_MS",
      DEFAULT_TEXT_TIMEOUT_MS,
    ),
  };
}

export function buildCloudflareTextTranslationBody(
  model: string,
  instructions: string,
  vietnameseText: string,
) {
  return {
    model,
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: vietnameseText },
    ],
    temperature: 0,
    max_completion_tokens: 80,
    stream: false,
  } as const;
}

function extractTextContent(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) {
        return "";
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .join("")
    .trim();
}

export async function translateVietnameseWithCloudflare(
  vietnameseText: string,
  instructions: string,
) {
  const config = getCloudflareTextConfig();
  let response: Response;

  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildCloudflareTextTranslationBody(
            config.model,
            instructions,
            vietnameseText,
          ),
        ),
        signal: AbortSignal.timeout(config.timeoutMs),
        cache: "no-store",
      },
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new CloudflareTextProviderError(
      name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : "network_error",
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | CloudflareChatEnvelope
    | null;

  if (!response.ok) {
    throw new CloudflareTextProviderError(
      response.status === 429 ? "rate_limited" : `http_${response.status}`,
      response.status,
    );
  }

  const englishText = extractTextContent(
    payload?.choices?.[0]?.message?.content,
  );

  if (!englishText) {
    throw new CloudflareTextProviderError("empty_response");
  }

  return {
    englishText,
    model: config.model,
  };
}
