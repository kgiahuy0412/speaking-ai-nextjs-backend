import { faithfulTranslationGoldenSet } from "./faithfulTranslationGoldenSet";
import { RULE_VERSION } from "./translationPolicy";

export type ExactTranslationRule = {
  id: string;
  vietnamese: string;
  english: string;
  normalizedVietnamese: string;
  ruleVersion: string;
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
  },
  {
    id: "V1-HIST-006",
    vietnamese: "Con muốn đi thư viện.",
    english: "I want to go to the library.",
  },
] as const;

/**
 * Exact matching ignores only presentation differences. Vietnamese diacritics,
 * word order, pronouns and meaning-bearing particles remain part of the key.
 */
export function normalizeVietnameseForExactMatch(text: string) {
  return text
    .toLocaleLowerCase("vi")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const reviewedExactRulesV1: ExactTranslationRule[] =
  [
    ...faithfulTranslationGoldenSet
      .filter((testCase) => testCase.exactRuleEligible)
      .map((testCase) => ({
        id: testCase.id,
        vietnamese: testCase.vietnamese,
        english: testCase.expectedEnglish,
      })),
    ...reviewedHistoricalCorrections,
  ].map((testCase) => ({
      id: testCase.id,
      vietnamese: testCase.vietnamese,
      english: testCase.english,
      normalizedVietnamese: normalizeVietnameseForExactMatch(
        testCase.vietnamese,
      ),
      ruleVersion: RULE_VERSION,
    }));

const exactRuleByVietnamese = new Map<string, ExactTranslationRule>();

for (const rule of reviewedExactRulesV1) {
  const existing = exactRuleByVietnamese.get(rule.normalizedVietnamese);

  if (existing && existing.english !== rule.english) {
    throw new Error(
      `Conflicting reviewed exact rules: ${existing.id} and ${rule.id}`,
    );
  }

  exactRuleByVietnamese.set(rule.normalizedVietnamese, rule);
}

export function findReviewedExactRule(vietnameseText: string) {
  const normalizedVietnamese = normalizeVietnameseForExactMatch(vietnameseText);
  return exactRuleByVietnamese.get(normalizedVietnamese) ?? null;
}

export function getReviewedExactRuleAudioTexts() {
  return [...new Set(reviewedExactRulesV1.map((rule) => rule.english))];
}
