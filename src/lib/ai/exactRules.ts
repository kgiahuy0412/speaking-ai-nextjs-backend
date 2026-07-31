import { faithfulTranslationGoldenSet } from "./faithfulTranslationGoldenSet";
import { reviewedCorpusRulesV1 } from "./corpusRules";
import { reviewedPhraseSupplementRulesV1 } from "./phraseSupplementRules";
import { RULE_VERSION } from "./translationPolicy";

export type ExactTranslationRule = {
  id: string;
  vietnamese: string;
  english: string;
  aliases: readonly string[];
  normalizedVietnamese: string;
  ruleVersion: string;
};

export type ExactTranslationRuleMatch = {
  rule: ExactTranslationRule;
  matchType: "exact" | "alias" | "asr_folded";
  matchedVietnamese: string;
};

type ReviewedRuleSource = {
  id: string;
  vietnamese: string;
  english: string;
  aliases?: readonly string[];
};

const reviewedHistoricalCorrections = [
  {
    id: "V1-HIST-001",
    vietnamese: "Con muốn mua cái này.",
    english: "I want to buy this.",
  },
  {
    id: "V1-HIST-002",
    vietnamese: "Con không muốn mua cái này.",
    english: "I don't want to buy this.",
  },
  {
    id: "V1-HIST-003",
    vietnamese: "Bố mua cái này cho con nhé.",
    english: "Dad, please buy this for me.",
  },
  {
    id: "V1-HIST-004",
    vietnamese: "Đường đi xa lắm.",
    english: "It's a long way.",
  },
  {
    id: "V1-HIST-005",
    vietnamese: "Con muốn đi sở thú.",
    english: "I want to go to the zoo.",
    aliases: ["Con muốn đi vườn thú."],
  },
  {
    id: "V1-HIST-006",
    vietnamese: "Con muốn đi thư viện.",
    english: "I want to go to the library.",
  },
] as const satisfies readonly ReviewedRuleSource[];

/**
 * Exact matching ignores only presentation differences. Vietnamese diacritics,
 * word order, pronouns and meaning-bearing particles remain part of the key.
 */
export function normalizeVietnameseForExactMatch(text: string) {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keeps every word and its order, but removes Vietnamese diacritics that ASR
 * may omit. This is intentionally not fuzzy matching: meaning-bearing words
 * such as "không" still have to be present in the whole utterance.
 */
export function normalizeVietnameseForAsrRuleMatch(text: string) {
  return normalizeVietnameseForExactMatch(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d");
}

const reviewedPrimaryRuleSources: ReviewedRuleSource[] = [
  ...faithfulTranslationGoldenSet
    .filter((testCase) => testCase.exactRuleEligible)
    .map((testCase) => ({
      id: testCase.id,
      vietnamese: testCase.vietnamese,
      english: testCase.expectedEnglish,
    })),
  ...reviewedHistoricalCorrections,
  ...reviewedCorpusRulesV1,
];

// The official corpus is the source of truth. A legacy phrase supplement may
// add aliases for the same output, but it must never replace a corpus
// translation when the two sources disagree.
const primaryTranslationByVietnamese = new Map(
  reviewedPrimaryRuleSources.map((rule) => [
    normalizeVietnameseForExactMatch(rule.vietnamese),
    rule.english,
  ]),
);

const reviewedRuleSources: ReviewedRuleSource[] = [
  ...reviewedPrimaryRuleSources,
  ...reviewedPhraseSupplementRulesV1.filter((rule) => {
    const primaryEnglish = primaryTranslationByVietnamese.get(
      normalizeVietnameseForExactMatch(rule.vietnamese),
    );
    return primaryEnglish === undefined || primaryEnglish === rule.english;
  }),
];

export const reviewedExactRulesV1: ExactTranslationRule[] =
  reviewedRuleSources.map((testCase) => ({
    id: testCase.id,
    vietnamese: testCase.vietnamese,
    english: testCase.english,
    aliases: [...(testCase.aliases ?? [])],
    normalizedVietnamese: normalizeVietnameseForExactMatch(
      testCase.vietnamese,
    ),
    ruleVersion: RULE_VERSION,
  }));

const exactRuleMatchByVietnamese = new Map<
  string,
  ExactTranslationRuleMatch
>();

function registerRuleMatch(
  rule: ExactTranslationRule,
  vietnamese: string,
  matchType: ExactTranslationRuleMatch["matchType"],
) {
  const normalizedVietnamese = normalizeVietnameseForExactMatch(vietnamese);

  if (!normalizedVietnamese) {
    throw new Error(`Empty reviewed rule phrase: ${rule.id}`);
  }

  const existing = exactRuleMatchByVietnamese.get(normalizedVietnamese);

  if (existing && existing.rule.english !== rule.english) {
    throw new Error(
      `Conflicting reviewed exact rules: ${existing.rule.id} and ${rule.id}`,
    );
  }

  // Canonical sentences always win over an alias that happens to normalize to
  // the same text. Equal-output alias collisions are harmless and deterministic.
  if (!existing || (existing.matchType === "alias" && matchType === "exact")) {
    exactRuleMatchByVietnamese.set(normalizedVietnamese, {
      rule,
      matchType,
      matchedVietnamese: vietnamese,
    });
  }
}

for (const rule of reviewedExactRulesV1) {
  registerRuleMatch(rule, rule.vietnamese, "exact");
}

for (const rule of reviewedExactRulesV1) {
  for (const alias of rule.aliases) {
    registerRuleMatch(rule, alias, "alias");
  }
}

const asrRuleMatchByVietnamese = new Map<string, ExactTranslationRuleMatch>();

for (const match of exactRuleMatchByVietnamese.values()) {
  const normalizedVietnamese = normalizeVietnameseForAsrRuleMatch(
    match.matchedVietnamese,
  );
  const existing = asrRuleMatchByVietnamese.get(normalizedVietnamese);

  if (existing && existing.rule.english !== match.rule.english) {
    throw new Error(
      `Conflicting reviewed ASR rules: ${existing.rule.id} and ${match.rule.id}`,
    );
  }

  if (!existing || (existing.matchType === "alias" && match.matchType === "exact")) {
    asrRuleMatchByVietnamese.set(normalizedVietnamese, match);
  }
}

export function findReviewedExactRuleMatch(vietnameseText: string) {
  const normalizedVietnamese = normalizeVietnameseForExactMatch(vietnameseText);
  return exactRuleMatchByVietnamese.get(normalizedVietnamese) ?? null;
}

export function findReviewedExactRule(vietnameseText: string) {
  return findReviewedExactRuleMatch(vietnameseText)?.rule ?? null;
}

export function findReviewedAsrRuleMatch(vietnameseText: string) {
  const exactMatch = findReviewedExactRuleMatch(vietnameseText);
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedVietnamese = normalizeVietnameseForAsrRuleMatch(
    vietnameseText,
  );
  const foldedMatch = asrRuleMatchByVietnamese.get(normalizedVietnamese);
  if (!foldedMatch) {
    return null;
  }

  return {
    ...foldedMatch,
    matchType: "asr_folded" as const,
  };
}

export function getReviewedExactRuleAudioTexts(limit?: number) {
  const texts = [...new Set(reviewedExactRulesV1.map((rule) => rule.english))];
  return limit === undefined ? texts : texts.slice(0, Math.max(0, limit));
}
