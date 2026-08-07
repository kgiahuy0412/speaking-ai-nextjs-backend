import {
  normalizeVietnameseForAsrRuleMatch,
  normalizeVietnameseForExactMatch,
  reviewedExactRulesV1,
  type ExactTranslationRule,
} from "./exactRules";
import { buildReviewedRegionalAliases } from "./regionalVocabulary";

export type TranscriptCorpusRepairStrategy =
  | "asr_folded"
  | "observed_asr_alias"
  | "regional_alias"
  | "regional_fuzzy";

export type TranscriptCorpusRepairResult = {
  text: string;
  repaired: boolean;
  ruleId?: string;
  strategy?: TranscriptCorpusRepairStrategy;
  score?: number;
  margin?: number;
};

const priorityRuleIds = new Set([
  "V1-CHILD-001",
  ...Array.from(
    { length: 99 },
    (_, index) => `AIV0-${String(index + 1).padStart(4, "0")}`,
  ),
]);

/**
 * Fuzzy pronunciation repair intentionally remains limited to 100 reviewed
 * high-frequency sentences. Exact regional aliases are expanded separately
 * to the full 5,000-sentence corpus below.
 */
export const regionalChildSpeechRulesV1 = reviewedExactRulesV1.filter((rule) =>
  priorityRuleIds.has(rule.id),
);

if (regionalChildSpeechRulesV1.length !== 100) {
  throw new Error(
    `Regional child-speech rollout must contain 100 rules, got ${regionalChildSpeechRulesV1.length}`,
  );
}

export const regionalCorpusRulesV1 = reviewedExactRulesV1.filter((rule) =>
  rule.id.startsWith("AIV0-"),
);

if (regionalCorpusRulesV1.length !== 5_000) {
  throw new Error(
    `Regional corpus rollout must contain 5,000 rules, got ${regionalCorpusRulesV1.length}`,
  );
}

const uniqueRegionalCorpusRuleByVietnamese = new Map<
  string,
  ExactTranslationRule
>();
for (const rule of regionalCorpusRulesV1) {
  const normalized = normalizeVietnameseForExactMatch(rule.vietnamese);
  if (!uniqueRegionalCorpusRuleByVietnamese.has(normalized)) {
    uniqueRegionalCorpusRuleByVietnamese.set(normalized, rule);
  }
}

export const regionalCorpusMatchRulesV1 = [
  ...uniqueRegionalCorpusRuleByVietnamese.values(),
];

const regionalExactRepairRuleByVietnamese = new Map(
  uniqueRegionalCorpusRuleByVietnamese,
);
for (const rule of regionalChildSpeechRulesV1) {
  const normalized = normalizeVietnameseForExactMatch(rule.vietnamese);
  if (!regionalExactRepairRuleByVietnamese.has(normalized)) {
    regionalExactRepairRuleByVietnamese.set(normalized, rule);
  }
}
const regionalExactRepairRulesV1 = [
  ...regionalExactRepairRuleByVietnamese.values(),
];

const knownTokenConfusionGroups = [
  // Subject variants frequently emitted by Vietnamese ASR for child speech.
  ["con", "co", "cong", "cung"],
  // "rất" pronounced or transcribed with d/gi/z/g and t/c endings.
  ["rat", "dat", "zat", "gat", "gac"],
  ["vui", "zui", "dui"],
  ["muon", "mun", "mon"],
  ["nuoc", "nuot"],
  ["so", "xo"],
] as const;

const tokenConfusionGroupByToken = new Map<string, number>();
for (const [groupIndex, group] of knownTokenConfusionGroups.entries()) {
  for (const token of group) {
    tokenConfusionGroupByToken.set(token, groupIndex);
  }
}

const optionalChildSpeechTokens = new Set(["con", "oi", "a", "nhe"]);
const negationTokens = new Set(["khong", "chua", "chang"]);

function tokensForSpeechMatch(text: string) {
  const normalized = normalizeVietnameseForAsrRuleMatch(text);
  return normalized ? normalized.split(" ") : [];
}

function phoneticCode(token: string) {
  return token
    .replace(/^ngh/, "ng")
    .replace(/^gi/, "z")
    .replace(/^(?:tr|ch)/, "c")
    .replace(/^[sx]/, "s")
    .replace(/^[rdz]/, "z")
    .replace(/^[ln]/, "n")
    .replace(/(?:ng|n)$/, "n")
    .replace(/[tc]$/, "t");
}

function editDistance(left: string, right: string) {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function tokenCost(source: string, canonical: string) {
  if (source === canonical) return 0;

  const sourceGroup = tokenConfusionGroupByToken.get(source);
  if (
    sourceGroup !== undefined &&
    sourceGroup === tokenConfusionGroupByToken.get(canonical)
  ) {
    return 0.18;
  }

  if (phoneticCode(source) === phoneticCode(canonical)) {
    return 0.28;
  }

  const longestLength = Math.max(source.length, canonical.length);
  const similarity =
    longestLength === 0
      ? 1
      : 1 - editDistance(source, canonical) / longestLength;
  if (similarity >= 0.8) return 0.35;
  if (Math.min(source.length, canonical.length) >= 3 && similarity >= 0.67) {
    return 0.48;
  }

  return null;
}

function haveSameNegation(
  sourceTokens: readonly string[],
  canonicalTokens: readonly string[],
) {
  const sourceNegation = sourceTokens.filter((token) =>
    negationTokens.has(token),
  );
  const canonicalNegation = canonicalTokens.filter((token) =>
    negationTokens.has(token),
  );
  return sourceNegation.join(" ") === canonicalNegation.join(" ");
}

function removeOneOptionalToken(tokens: readonly string[]) {
  const variants: string[][] = [];
  for (const [index, token] of tokens.entries()) {
    if (!optionalChildSpeechTokens.has(token)) continue;
    variants.push(tokens.filter((_, tokenIndex) => tokenIndex !== index));
  }
  return variants;
}

function alignTokenCounts(
  sourceTokens: readonly string[],
  canonicalTokens: readonly string[],
) {
  if (sourceTokens.length === canonicalTokens.length) {
    return [{ source: [...sourceTokens], canonical: [...canonicalTokens] }];
  }
  if (sourceTokens.length + 1 === canonicalTokens.length) {
    return removeOneOptionalToken(canonicalTokens)
      .filter((tokens) => tokens.length === sourceTokens.length)
      .map((tokens) => ({ source: [...sourceTokens], canonical: tokens }));
  }
  if (canonicalTokens.length + 1 === sourceTokens.length) {
    return removeOneOptionalToken(sourceTokens)
      .filter((tokens) => tokens.length === canonicalTokens.length)
      .map((tokens) => ({ source: tokens, canonical: [...canonicalTokens] }));
  }
  return [];
}

function scoreCandidate(sourceText: string, rule: ExactTranslationRule) {
  const sourceTokens = tokensForSpeechMatch(sourceText);
  const canonicalTokens = tokensForSpeechMatch(rule.vietnamese);
  if (
    sourceTokens.length < 2 ||
    !haveSameNegation(sourceTokens, canonicalTokens)
  ) {
    return null;
  }

  let bestScore: number | null = null;
  for (const alignment of alignTokenCounts(sourceTokens, canonicalTokens)) {
    let totalCost = 0;
    let changedTokens = 0;
    let valid = true;
    for (let index = 0; index < alignment.source.length; index += 1) {
      const cost = tokenCost(
        alignment.source[index],
        alignment.canonical[index],
      );
      if (cost === null) {
        valid = false;
        break;
      }
      totalCost += cost;
      if (cost > 0) changedTokens += 1;
    }
    const maxChangedTokens = canonicalTokens.length >= 5 ? 2 : 1;
    if (!valid || changedTokens > maxChangedTokens) continue;

    if (sourceTokens.length !== canonicalTokens.length) {
      totalCost += 0.45;
    }
    const score = 1 - totalCost / Math.max(sourceTokens.length, canonicalTokens.length);
    bestScore = bestScore === null ? score : Math.max(bestScore, score);
  }

  return bestScore;
}

const foldedRuleByVietnamese = new Map<
  string,
  ExactTranslationRule | null
>();
const exactRuleByVietnamese = new Map<string, ExactTranslationRule>();
for (const rule of regionalExactRepairRulesV1) {
  exactRuleByVietnamese.set(
    normalizeVietnameseForExactMatch(rule.vietnamese),
    rule,
  );
  const folded = normalizeVietnameseForAsrRuleMatch(rule.vietnamese);
  const existing = foldedRuleByVietnamese.get(folded);
  foldedRuleByVietnamese.set(
    folded,
    existing && existing.id !== rule.id ? null : rule,
  );
}

/**
 * Provider errors confirmed from real phone/Web test turns. These aliases are
 * deliberately explicit: broad fuzzy matching over all 5,000+ child
 * sentences can silently change a legitimate sentence into another rule.
 */
const reviewedObservedAsrCorrectionsV1 = [
  {
    aliases: [
      "Công mũ xem phim hòa cân",
      "À con muốn xem phim hoặc hình",
    ],
    canonical: "Con muốn xem phim hoạt hình.",
  },
  {
    aliases: ["Con bị vẹn rồi"],
    canonical: "Con mệt rồi.",
  },
  {
    aliases: ["Còn muốn đi sở thủ xìm càng hổ"],
    canonical: "Con muốn đi sở thú xem con hổ.",
  },
  {
    aliases: ["Con học lớp xấu rồi"],
    canonical: "Con học lớp sáu rồi.",
  },
] as const;

const reviewedRuleByCanonicalVietnamese = new Map(
  reviewedExactRulesV1.map((rule) => [
    normalizeVietnameseForExactMatch(rule.vietnamese),
    rule,
  ]),
);
const observedAsrCorrectionByFoldedText = new Map(
  reviewedObservedAsrCorrectionsV1.flatMap((correction) =>
    correction.aliases.map(
      (alias) =>
        [normalizeVietnameseForAsrRuleMatch(alias), correction] as const,
    ),
  ),
);

function addUnambiguousRuleAlias(
  aliases: Map<string, ExactTranslationRule | null>,
  alias: string,
  rule: ExactTranslationRule,
) {
  if (!aliases.has(alias)) {
    aliases.set(alias, rule);
    return;
  }
  const existing = aliases.get(alias);
  if (!existing || existing.id !== rule.id) {
    aliases.set(alias, null);
  }
}

const regionalAliasRuleByVietnamese = new Map<
  string,
  ExactTranslationRule | null
>();
const foldedRegionalAliasRuleByVietnamese = new Map<
  string,
  ExactTranslationRule | null
>();

for (const rule of regionalExactRepairRulesV1) {
  for (const alias of buildReviewedRegionalAliases(rule.vietnamese)) {
    const canonicalCollision = exactRuleByVietnamese.get(alias);
    if (canonicalCollision && canonicalCollision.id !== rule.id) continue;
    addUnambiguousRuleAlias(regionalAliasRuleByVietnamese, alias, rule);

    const foldedAlias = normalizeVietnameseForAsrRuleMatch(alias);
    const foldedCanonicalCollision = foldedRuleByVietnamese.get(foldedAlias);
    if (
      foldedRuleByVietnamese.has(foldedAlias) &&
      (!foldedCanonicalCollision || foldedCanonicalCollision.id !== rule.id)
    ) {
      continue;
    }
    addUnambiguousRuleAlias(
      foldedRegionalAliasRuleByVietnamese,
      foldedAlias,
      rule,
    );
  }
}

export const regionalCorpusRuntimeStats = {
  sourceRuleCount: regionalCorpusRulesV1.length,
  uniqueCanonicalCount: regionalCorpusMatchRulesV1.length,
  exactAliasCount: [...regionalAliasRuleByVietnamese.values()].filter(Boolean)
    .length,
  foldedAliasCount: [
    ...foldedRegionalAliasRuleByVietnamese.values(),
  ].filter(Boolean).length,
  ambiguousExactAliasCount: [
    ...regionalAliasRuleByVietnamese.values(),
  ].filter((rule) => rule === null).length,
  ambiguousFoldedAliasCount: [
    ...foldedRegionalAliasRuleByVietnamese.values(),
  ].filter((rule) => rule === null).length,
} as const;

export function repairVietnameseTranscriptWithCorpus(
  text: string,
): TranscriptCorpusRepairResult {
  const trimmed = text.trim();
  if (!trimmed) return { text: trimmed, repaired: false };

  const normalizedExact = normalizeVietnameseForExactMatch(trimmed);
  const exactRule = exactRuleByVietnamese.get(normalizedExact);
  if (exactRule) {
    return { text: trimmed, repaired: false, ruleId: exactRule.id };
  }

  const observedCorrection = observedAsrCorrectionByFoldedText.get(
    normalizeVietnameseForAsrRuleMatch(trimmed),
  );
  if (observedCorrection) {
    const canonicalRule = reviewedRuleByCanonicalVietnamese.get(
      normalizeVietnameseForExactMatch(observedCorrection.canonical),
    );
    return {
      text: observedCorrection.canonical,
      repaired: true,
      ruleId: canonicalRule?.id,
      strategy: "observed_asr_alias",
      score: 1,
      margin: 1,
    };
  }

  const regionalAliasRule = regionalAliasRuleByVietnamese.get(normalizedExact);
  if (regionalAliasRule) {
    return {
      text: regionalAliasRule.vietnamese,
      repaired: true,
      ruleId: regionalAliasRule.id,
      strategy: "regional_alias",
      score: 1,
      margin: 1,
    };
  }

  const folded = normalizeVietnameseForAsrRuleMatch(trimmed);
  const foldedRule = foldedRuleByVietnamese.get(folded);
  if (foldedRule) {
    return {
      text: foldedRule.vietnamese,
      repaired: true,
      ruleId: foldedRule.id,
      strategy: "asr_folded",
      score: 1,
      margin: 1,
    };
  }

  const foldedRegionalAliasRule =
    foldedRegionalAliasRuleByVietnamese.get(folded);
  if (foldedRegionalAliasRule) {
    return {
      text: foldedRegionalAliasRule.vietnamese,
      repaired: true,
      ruleId: foldedRegionalAliasRule.id,
      strategy: "regional_alias",
      score: 1,
      margin: 1,
    };
  }

  const ranked = regionalChildSpeechRulesV1
    .map((rule) => ({ rule, score: scoreCandidate(trimmed, rule) }))
    .filter(
      (candidate): candidate is { rule: ExactTranslationRule; score: number } =>
        candidate.score !== null,
    )
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best) return { text: trimmed, repaired: false };

  const secondScore = ranked[1]?.score ?? 0;
  const margin = best.score - secondScore;
  const tokenCount = tokensForSpeechMatch(trimmed).length;
  const minimumScore = tokenCount <= 3 ? 0.86 : 0.9;
  const minimumMargin = tokenCount <= 3 ? 0.16 : 0.1;
  if (best.score < minimumScore || margin < minimumMargin) {
    return { text: trimmed, repaired: false };
  }

  return {
    text: best.rule.vietnamese,
    repaired: true,
    ruleId: best.rule.id,
    strategy: "regional_fuzzy",
    score: Number(best.score.toFixed(3)),
    margin: Number(margin.toFixed(3)),
  };
}
