import type {
  PracticeContext,
  TextProvider,
  TextSource,
} from "@/types/conversation";
import { after } from "next/server";
import { normalizeVietnamese } from "@/lib/normalize";
import { logEvent } from "@/lib/observability";
import { buildEnglishInstruction } from "./prompts";
import { getPromotedRule } from "./promotedRules";
import { getCachedAiEnglishText, saveAiEnglishText } from "./textCache";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import {
  findReviewedAsrRuleMatch,
  normalizeVietnameseForExactMatch,
} from "./exactRules";
import { findMissingTranslationRequirements } from "./translationFidelity";
import { normalizeTranslationOutput } from "./translationOutputQuality";
import {
  CloudflareTextProviderError,
  translateVietnameseWithCloudflare,
} from "./cloudflareText";
import { claimSingleFlight } from "./singleFlight";

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

type TextGenerationGlobalState = typeof globalThis & {
  __aiSpeakingTextGenerationFlights?: Map<
    string,
    Promise<EnglishGenerationResult>
  >;
};

const textGenerationGlobal = globalThis as TextGenerationGlobalState;
const textGenerationFlights =
  textGenerationGlobal.__aiSpeakingTextGenerationFlights ??=
    new Map<string, Promise<EnglishGenerationResult>>();
const textGenerationFlightRetentionMs = 5_000;

function getTextGenerationFlightKey(
  vietnameseText: string,
  context: PracticeContext,
  childAge: number,
) {
  return [
    "cloudflare",
    context,
    `age:${childAge}`,
    normalizeVietnameseForExactMatch(vietnameseText),
  ].join("::");
}

function getFixedEnglishSentence(vietnameseText: string) {
  const match = findReviewedAsrRuleMatch(vietnameseText);

  if (!match) {
    return null;
  }

  return {
    englishText: match.rule.english,
    matchedRule: `${match.matchType}:${match.rule.ruleVersion}:${match.rule.id}`,
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

class InvalidTranslationError extends Error {
  constructor(
    readonly provider: TextProvider,
    readonly details?: string,
  ) {
    super(`${provider} returned an invalid translation`);
    this.name = "InvalidTranslationError";
  }
}

function getProviderFailureReason(error: unknown) {
  if (error instanceof CloudflareTextProviderError) {
    return error.reason;
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

async function generateWithProviders(
  vietnameseText: string,
  instructions: string,
  requestId?: string,
) {
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
}

export async function generateEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
  childAge = 6,
  clientId?: string,
  requestId?: string,
  deferCacheWrite = false,
  skipFastLookup = false,
): Promise<EnglishGenerationResult> {
  const fastSentence = skipFastLookup
    ? null
    : await resolveFastEnglishSentence(
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
  const flightKey = getTextGenerationFlightKey(
    vietnameseText,
    context,
    childAge,
  );
  const claimedFlight = claimSingleFlight({
    flights: textGenerationFlights,
    key: flightKey,
    retainForMs: textGenerationFlightRetentionMs,
    operation: async (): Promise<EnglishGenerationResult> => {
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
        logEvent("error", "cloudflare_text_failed", {
          requestId,
          provider: "cloudflare",
          failureReason,
          error,
        });

        return {
          englishText: fallbackSentence,
          mode: "fallback",
          source: "fallback",
          matchedRule: `providers_failed:${failureReason}`,
          textFallbackUsed: false,
          textFallbackReason: failureReason,
        };
      }
    },
  });
  if (claimedFlight.joined) {
    logEvent("info", "text_generation_flight_joined", {
      requestId,
      context,
      childAge,
    });
  }
  return claimedFlight.promise;
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
