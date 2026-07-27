import type {
  PracticeContext,
  TextProvider,
  TextSource,
} from "@/types/conversation";
import { after } from "next/server";
import { normalizeVietnamese } from "@/lib/normalize";
import { logEvent } from "@/lib/observability";
import { getOpenAIClient } from "./openai";
import { buildEnglishInstruction } from "./prompts";
import { getPromotedRule } from "./promotedRules";
import { getCachedAiEnglishText, saveAiEnglishText } from "./textCache";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import { findReviewedExactRule } from "./exactRules";
import { findMissingTranslationRequirements } from "./translationFidelity";
import {
  CloudflareTextProviderError,
  translateVietnameseWithCloudflare,
} from "./cloudflareText";

export type EnglishGenerationResult = {
  englishText: string;
  mode: "rule" | "ai" | "fallback";
  source: TextSource;
  matchedRule?: string;
  textProvider?: TextProvider;
  textModel?: string;
  textFallbackUsed?: boolean;
  textFallbackReason?: string;
};

type ProviderTranslation = {
  englishText: string;
  provider: TextProvider;
  model: string;
};

function getFixedEnglishSentence(vietnameseText: string) {
  const exactMatch = findReviewedExactRule(vietnameseText);

  if (!exactMatch) {
    return null;
  }

  return {
    englishText: exactMatch.english,
    matchedRule: `exact:${exactMatch.ruleVersion}:${exactMatch.id}`,
    source: "phrase_rule" as const,
  };
}

function isUnclearShortInput(normalizedText: string) {
  const unclearInputs = new Set([
    "con",
    "cai nay",
    "cai kia",
    "kia",
    "nay",
    "do",
    "a",
    "a a",
    "um",
    "uh",
  ]);

  return unclearInputs.has(normalizedText) || normalizedText.length < 3;
}

function getPrimaryTextProvider(): TextProvider {
  return process.env.AI_TEXT_PRIMARY_PROVIDER === "openai"
    ? "openai"
    : "cloudflare";
}

function getOpenAITextModel() {
  return process.env.OPENAI_FAST_TEXT_MODEL ?? "gpt-4o-mini";
}

function getOpenAITextTimeoutMs() {
  const timeoutMs = Number(process.env.OPENAI_TEXT_TIMEOUT_MS ?? 3500);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3500;
}

class TextModelTimeoutError extends Error {
  constructor(
    readonly provider: TextProvider,
    timeoutMs: number,
  ) {
    super(`${provider} text translation timed out after ${timeoutMs}ms`);
    this.name = "TextModelTimeoutError";
  }
}

class InvalidTranslationError extends Error {
  constructor(
    readonly provider: TextProvider,
    readonly details?: string,
  ) {
    super(`${provider} returned an invalid translation`);
    this.name = "InvalidTranslationError";
  }
}

async function withTimeout<T>(
  provider: TextProvider,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TextModelTimeoutError(provider, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeTranslationOutput(text: string) {
  let value = text.trim();

  value = value.replace(/^(english|translation)\s*:\s*/i, "").trim();

  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }

  if (
    !value ||
    value.length > 500 ||
    containsUnexpectedEastAsianScript(value) ||
    /^(vietnamese|source)\s*:/i.test(value)
  ) {
    return null;
  }

  return value;
}

function getProviderFailureReason(error: unknown) {
  if (error instanceof CloudflareTextProviderError) {
    return error.reason;
  }
  if (error instanceof TextModelTimeoutError) {
    return "timeout";
  }
  if (error instanceof InvalidTranslationError) {
    return error.details
      ? `invalid_translation:${error.details}`
      : "invalid_translation";
  }
  if (error instanceof Error) {
    return error.name || "provider_error";
  }
  return "unknown_error";
}

async function translateWithCloudflare(
  vietnameseText: string,
  instructions: string,
  requestId?: string,
): Promise<ProviderTranslation> {
  const startedAt = performance.now();

  try {
    const result = await translateVietnameseWithCloudflare(
      vietnameseText,
      instructions,
    );
    const englishText = normalizeTranslationOutput(result.englishText);

    if (!englishText) {
      throw new InvalidTranslationError("cloudflare");
    }

    const missingRequirements = findMissingTranslationRequirements(
      vietnameseText,
      englishText,
    );
    if (missingRequirements.length > 0) {
      throw new InvalidTranslationError(
        "cloudflare",
        missingRequirements.join(","),
      );
    }

    return {
      englishText,
      provider: "cloudflare",
      model: result.model,
    };
  } finally {
    logEvent("info", "text_provider_latency", {
      requestId,
      provider: "cloudflare",
      latencyMs: Math.round(performance.now() - startedAt),
    });
  }
}

async function translateWithOpenAI(
  vietnameseText: string,
  instructions: string,
  requestId?: string,
): Promise<ProviderTranslation> {
  const client = getOpenAIClient();
  const model = getOpenAITextModel();
  const timeoutMs = getOpenAITextTimeoutMs();
  const startedAt = performance.now();

  try {
    const response = await withTimeout(
      "openai",
      (signal) =>
        client.responses.create(
          {
            model,
            instructions,
            input: vietnameseText,
            max_output_tokens: 80,
          },
          { signal },
        ),
      timeoutMs,
    );
    const englishText = normalizeTranslationOutput(response.output_text);

    if (!englishText) {
      throw new InvalidTranslationError("openai");
    }

    const missingRequirements = findMissingTranslationRequirements(
      vietnameseText,
      englishText,
    );
    if (missingRequirements.length > 0) {
      throw new InvalidTranslationError(
        "openai",
        missingRequirements.join(","),
      );
    }

    return {
      englishText,
      provider: "openai",
      model,
    };
  } finally {
    logEvent("info", "text_provider_latency", {
      requestId,
      provider: "openai",
      model,
      latencyMs: Math.round(performance.now() - startedAt),
    });
  }
}

async function generateWithProviders(
  vietnameseText: string,
  instructions: string,
  requestId?: string,
) {
  const primaryProvider = getPrimaryTextProvider();

  if (primaryProvider === "openai") {
    const translation = await translateWithOpenAI(
      vietnameseText,
      instructions,
      requestId,
    );
    return {
      ...translation,
      fallbackUsed: false,
      fallbackReason: undefined,
    };
  }

  try {
    const translation = await translateWithCloudflare(
      vietnameseText,
      instructions,
      requestId,
    );
    return {
      ...translation,
      fallbackUsed: false,
      fallbackReason: undefined,
    };
  } catch (error) {
    const fallbackReason = getProviderFailureReason(error);
    logEvent("warn", "text_provider_fallback", {
      requestId,
      primaryProvider: "cloudflare",
      fallbackProvider: "openai",
      fallbackReason,
    });

    const translation = await translateWithOpenAI(
      vietnameseText,
      instructions,
      requestId,
    );
    return {
      ...translation,
      fallbackUsed: true,
      fallbackReason,
    };
  }
}

export async function generateEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
  childAge = 6,
  clientId?: string,
  requestId?: string,
  deferCacheWrite = false,
): Promise<EnglishGenerationResult> {
  const fastSentence = await resolveFastEnglishSentence(
    vietnameseText,
    context,
    childAge,
    clientId,
  );

  if (
    fastSentence &&
    !containsUnexpectedEastAsianScript(fastSentence.englishText)
  ) {
    return fastSentence;
  }

  const fallbackSentence = "Can you say that again, please?";

  if (isUnclearShortInput(normalizeVietnamese(vietnameseText))) {
    return {
      englishText: fallbackSentence,
      mode: "fallback",
      source: "fallback",
    };
  }

  const instructions = buildEnglishInstruction(context, childAge);

  try {
    const result = await generateWithProviders(
      vietnameseText,
      instructions,
      requestId,
    );

    const saveTextCache = () =>
      saveAiEnglishText(
        vietnameseText,
        context,
        childAge,
        result.englishText,
        clientId,
        {
          textProvider: result.provider,
          textModel: result.model,
          textFallbackUsed: result.fallbackUsed,
          textFallbackReason: result.fallbackReason,
        },
      );
    if (deferCacheWrite) {
      after(async () => {
        try {
          await saveTextCache();
        } catch (error) {
          logEvent("error", "text_cache_write_failed", {
            requestId,
            error,
          });
        }
      });
    } else {
      await saveTextCache();
    }

    return {
      englishText: result.englishText,
      mode: "ai",
      source: result.provider,
      textProvider: result.provider,
      textModel: result.model,
      textFallbackUsed: result.fallbackUsed,
      textFallbackReason: result.fallbackReason,
    };
  } catch (error) {
    const failureReason = getProviderFailureReason(error);
    logEvent("error", "text_providers_failed", {
      requestId,
      primaryProvider: getPrimaryTextProvider(),
      finalProvider: "openai",
      failureReason,
      error,
    });

    return {
      englishText: fallbackSentence,
      mode: "fallback",
      source: "fallback",
      matchedRule: `providers_failed:${failureReason}`,
      textFallbackUsed: getPrimaryTextProvider() === "cloudflare",
      textFallbackReason: failureReason,
    };
  }
}

export async function resolveFastEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
  childAge = 6,
  clientId?: string,
): Promise<EnglishGenerationResult | null> {
  const fixedSentence = getFixedEnglishSentence(vietnameseText);

  if (fixedSentence) {
    return {
      ...fixedSentence,
      mode: "rule",
    };
  }

  const normalizedText = normalizeVietnamese(vietnameseText);

  if (isUnclearShortInput(normalizedText)) {
    return null;
  }

  // Both values live in the same remote persistence layer in production.
  // Looking them up concurrently removes one full database round trip from
  // every cache miss without changing rule priority.
  const [promotedRule, cachedSentence] = await Promise.all([
    getPromotedRule(vietnameseText, context, clientId),
    getCachedAiEnglishText(
      vietnameseText,
      context,
      childAge,
      clientId,
    ),
  ]);

  if (promotedRule) {
    return {
      englishText: promotedRule.englishText,
      mode: "rule",
      source: "promoted_rule",
      matchedRule: `promoted:${promotedRule.ruleVersion}:${promotedRule.normalizedVietnameseText}`,
    };
  }

  if (!cachedSentence) {
    return null;
  }

  return {
    englishText: cachedSentence.englishText,
    mode: "ai",
    source: "text_cache",
    matchedRule: `text_cache:${cachedSentence.normalizedVietnameseText}`,
    textProvider: cachedSentence.textProvider,
    textModel: cachedSentence.textModel,
    textFallbackUsed: cachedSentence.textFallbackUsed,
    textFallbackReason: cachedSentence.textFallbackReason,
  };
}
