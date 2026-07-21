import type { PracticeContext, TextSource } from "@/types/conversation";
import { normalizeVietnamese } from "@/lib/normalize";
import { getOpenAIClient } from "./openai";
import { keywordIntentRules, phraseRules } from "./phraseRules";
import { buildEnglishInstruction } from "./prompts";
import { getPromotedRule } from "./promotedRules";
import { findSemanticIntent } from "./semanticIntents";
import { getCachedAiEnglishText, saveAiEnglishText } from "./textCache";
import { containsUnexpectedEastAsianScript } from "./languageValidation";

export type EnglishGenerationResult = {
  englishText: string;
  mode: "rule" | "ai" | "fallback";
  source: TextSource;
  matchedRule?: string;
};

function getFixedEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
) {
  const normalized = normalizeVietnamese(vietnameseText);
  const contextOrder: PracticeContext[] = [
    context,
    ...(["home", "school", "outside"] as PracticeContext[]).filter(
      (item) => item !== context,
    ),
  ];
  const phraseMatch = contextOrder
    .flatMap((ruleContext, contextPriority) =>
      phraseRules[ruleContext].map((rule) => ({ rule, contextPriority })),
    )
    .filter(({ rule }) => safelyMatchesPhrase(normalized, rule.vietnamese))
    .sort((a, b) => {
      const exactDifference =
        Number(normalized === b.rule.vietnamese) -
        Number(normalized === a.rule.vietnamese);
      return (
        exactDifference ||
        b.rule.vietnamese.length - a.rule.vietnamese.length ||
        a.contextPriority - b.contextPriority
      );
    })[0]?.rule;

  if (phraseMatch) {
    return {
      englishText: phraseMatch.english,
      matchedRule: phraseMatch.vietnamese,
      source: "phrase_rule" as const,
    };
  }

  const keywordMatches = keywordIntentRules[context]
    .map((rule) => ({
      rule,
      matchedKeyword: getMatchedKeyword(
        normalized,
        rule.keywords,
        rule.blockedKeywords,
      ),
    }))
    .filter((item) => item.matchedKeyword)
    .filter((item) =>
      isSafeKeywordMatch(
        normalized,
        item.rule.intent,
        item.matchedKeyword ?? "",
      ),
    )
    .sort(
      (a, b) =>
        (b.matchedKeyword?.length ?? 0) -
        (a.matchedKeyword?.length ?? 0),
    );
  const keywordMatch = hasMultipleIdeas(normalized)
    ? null
    : keywordMatches[0]?.rule;

  return keywordMatch
    ? {
        englishText: keywordMatch.english,
        matchedRule: `keyword:${keywordMatch.intent}`,
        source: "keyword_rule" as const,
      }
    : null;
}

const phraseWrapperTokens = new Set([
  "a",
  "ba",
  "bo",
  "co",
  "giup",
  "lam",
  "me",
  "nha",
  "nhe",
  "oi",
  "qua",
  "roi",
  "thay",
]);

const genericKeywordIntents = new Set(["eat", "play"]);

function safelyMatchesPhrase(normalizedText: string, phrase: string) {
  if (normalizedText === phrase) {
    return true;
  }

  const inputTokens = normalizedText.split(" ").filter(Boolean);
  const phraseTokens = phrase.split(" ").filter(Boolean);
  const phraseLength = phraseTokens.length;

  for (let index = 0; index <= inputTokens.length - phraseLength; index += 1) {
    const candidate = inputTokens.slice(index, index + phraseLength);

    if (candidate.join(" ") !== phrase) {
      continue;
    }

    const wrapperTokens = [
      ...inputTokens.slice(0, index),
      ...inputTokens.slice(index + phraseLength),
    ];

    return (
      wrapperTokens.length <= 3 &&
      wrapperTokens.every((token) => phraseWrapperTokens.has(token))
    );
  }

  return false;
}

function containsKeyword(normalizedText: string, keyword: string) {
  return ` ${normalizedText} `.includes(` ${keyword} `);
}

function getMatchedKeyword(
  normalizedText: string,
  keywords: string[],
  blockedKeywords: string[] = [],
) {
  if (blockedKeywords.some((keyword) => containsKeyword(normalizedText, keyword))) {
    return null;
  }

  return (
    keywords
      .filter((keyword) => containsKeyword(normalizedText, keyword))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

function isSafeKeywordMatch(
  normalizedText: string,
  intent: string,
  matchedKeyword: string,
) {
  const inputTokens = new Set(normalizedText.split(" "));
  const keywordTokens = new Set(matchedKeyword.split(" "));

  if (
    ["khong", "chua"].some(
      (token) => inputTokens.has(token) && !keywordTokens.has(token),
    )
  ) {
    return false;
  }

  if (!genericKeywordIntents.has(intent)) {
    return true;
  }

  const scaffolding = new Set([
    "a",
    "con",
    "di",
    "me",
    "minh",
    "muon",
    "nha",
    "nhe",
    "oi",
    "roi",
  ]);
  const detailTokens = normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => !scaffolding.has(token) && !keywordTokens.has(token));

  return detailTokens.length === 0;
}

function hasMultipleIdeas(normalizedText: string) {
  return [" va ", " nhung "].some((connector) =>
    ` ${normalizedText} `.includes(connector),
  );
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

function getFallbackTextModel() {
  return process.env.OPENAI_FAST_TEXT_MODEL ?? "gpt-4o-mini";
}

function getFallbackTextTimeoutMs() {
  const timeoutMs = Number(process.env.OPENAI_TEXT_TIMEOUT_MS ?? 2500);

  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2500;
}

class TextModelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`OpenAI text fallback timed out after ${timeoutMs}ms`);
    this.name = "TextModelTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TextModelTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function generateEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
  childAge = 6,
  clientId?: string,
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

  if (isUnclearShortInput(normalizeVietnamese(vietnameseText))) {
    return {
      englishText: "Can you say that again, please?",
      mode: "fallback",
      source: "fallback",
    };
  }

  const client = getOpenAIClient();
  const fallbackSentence = "Can you say that again, please?";
  const model = getFallbackTextModel();
  const timeoutMs = getFallbackTextTimeoutMs();
  let sentence = "";
  const fastModelStartedAt = performance.now();

  try {
    const response = await withTimeout(
      client.responses.create({
        model,
        instructions: buildEnglishInstruction(context, childAge),
        input: vietnameseText,
        max_output_tokens: 48,
      }),
      timeoutMs,
    );

    sentence = response.output_text.trim();
    if (containsUnexpectedEastAsianScript(sentence)) {
      sentence = "";
    }
  } catch (error) {
    if (error instanceof TextModelTimeoutError) {
      return {
        englishText: fallbackSentence,
        mode: "fallback",
        source: "fallback",
        matchedRule: `timeout:openai_text:${model}:${timeoutMs}`,
      };
    }

    throw error;
  } finally {
    console.info("fast_model_latency", {
      model,
      latencyMs: Math.round(performance.now() - fastModelStartedAt),
      context,
    });
  }

  if (sentence && sentence !== fallbackSentence) {
    await saveAiEnglishText(
      vietnameseText,
      context,
      childAge,
      sentence,
      clientId,
    );
  }

  return {
    englishText: sentence || fallbackSentence,
    mode: sentence ? "ai" : "fallback",
    source: sentence ? "openai" : "fallback",
  };
}

export async function resolveFastEnglishSentence(
  vietnameseText: string,
  context: PracticeContext,
  childAge = 6,
  clientId?: string,
): Promise<EnglishGenerationResult | null> {
  const promotedRule = await getPromotedRule(
    vietnameseText,
    context,
    clientId,
  );

  if (promotedRule) {
    return {
      englishText: promotedRule.englishText,
      mode: "rule",
      source: "promoted_rule",
      matchedRule: `promoted:${promotedRule.normalizedVietnameseText}`,
    };
  }

  const fixedSentence = getFixedEnglishSentence(vietnameseText, context);

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

  const semanticIntent = hasMultipleIdeas(normalizedText)
    ? null
    : findSemanticIntent(vietnameseText, context);

  if (semanticIntent) {
    return {
      englishText: semanticIntent.englishText,
      mode: "rule",
      source: "semantic_cache",
      matchedRule: `semantic:${semanticIntent.intent}:${semanticIntent.score.toFixed(2)}`,
    };
  }

  const cachedSentence = await getCachedAiEnglishText(
    vietnameseText,
    context,
    childAge,
    clientId,
  );

  if (cachedSentence) {
    return {
      englishText: cachedSentence.englishText,
      mode: "ai",
      source: "text_cache",
      matchedRule: `text_cache:${cachedSentence.normalizedVietnameseText}`,
    };
  }

  return null;
}
