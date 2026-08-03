import { normalizeVietnameseForExactMatch } from "./exactRules";
import { regionalVocabularyRowsV1 } from "./regionalVocabularyData";

export type ReviewedRegionalVocabularyEntry = {
  sourceRow: number;
  standard: string;
  variants: readonly string[];
};

type PreparedRegionalVocabularyEntry = ReviewedRegionalVocabularyEntry & {
  standardTokens: readonly string[];
  variantTokens: readonly (readonly string[])[];
};

const excludedRegionalVocabularyRows = new Map([
  [213, "chừ là bây giờ, không thay được giờ trên đồng hồ"],
  [264, "đậu phộng không thay được lạc trong lạc đường/liên lạc"],
  [455, "bén không thay được sắc trong bản sắc/màu sắc"],
  [517, "bự không thay được to trong đọc to/nói to"],
  [556, "bóp không thay được ví trong ví dụ"],
  [574, "sên không thay được xích trong xích đu"],
]);

export const excludedRegionalVocabularyV1 = [
  ...excludedRegionalVocabularyRows,
].map(([sourceRow, reason]) => ({ sourceRow, reason }));

function uniqueRegionalVariants(row: (typeof regionalVocabularyRowsV1)[number]) {
  const standard = normalizeVietnameseForExactMatch(row.standard);
  return [row.south, row.central, row.north]
    .map(normalizeVietnameseForExactMatch)
    .filter((variant) => variant && variant !== standard)
    .filter((variant, index, variants) => variants.indexOf(variant) === index);
}

/**
 * All workbook rows that occur in the official 5,000-sentence corpus, after
 * removing six context-invalid homonyms. They are never applied as global
 * word replacements; they only generate aliases whose complete sentence is
 * already present in the reviewed corpus.
 */
export const reviewedRegionalVocabularyV1: ReviewedRegionalVocabularyEntry[] =
  regionalVocabularyRowsV1
    .filter((row) => !excludedRegionalVocabularyRows.has(row.sourceRow))
    .map((row) => {
      if (row.sourceRow === 64) {
        return {
          sourceRow: row.sourceRow,
          standard: "cây bút chì",
          variants: ["cây viết chì"],
        };
      }
      return {
        sourceRow: row.sourceRow,
        standard: normalizeVietnameseForExactMatch(row.standard),
        variants: uniqueRegionalVariants(row),
      };
    });

const blockedPreviousTokensBySourceRow = new Map<number, ReadonlySet<string>>([
  [62, new Set(["cây", "hộp"])],
  [81, new Set(["trái"])],
  [99, new Set(["đồ", "trò", "sân", "khu", "vui"])],
  [491, new Set(["nghe", "nhìn", "tìm", "cảm"])],
  [524, new Set(["rẽ"])],
]);

const blockedFollowingTokensBySourceRow = new Map<number, ReadonlySet<string>>([
  [2, new Set(["hưởng"])],
  [107, new Set(["lại"])],
  [391, new Set(["nhiễm"])],
]);

const safePreviousTokensForReturnVerb = new Set([
  "anh",
  "bạn",
  "bố",
  "buýt",
  "cháu",
  "chị",
  "con",
  "có",
  "cùng",
  "cần",
  "đang",
  "đã",
  "đi",
  "đón",
  "được",
  "em",
  "không",
  "mai",
  "mẹ",
  "mình",
  "muốn",
  "muộn",
  "nhớ",
  "nên",
  "phải",
  "quay",
  "rồi",
  "sẽ",
  "sớm",
  "thường",
  "thể",
  "trở",
  "vừa",
  "xe",
]);

const safeFollowingTokensForReturnVerb = new Set([
  "cùng",
  "đây",
  "đó",
  "kia",
  "muộn",
  "nhà",
  "rồi",
  "sau",
  "sớm",
  "thôi",
  "trước",
]);

function replacementIsContextSafe(
  entry: PreparedRegionalVocabularyEntry,
  source: readonly string[],
  matchIndex: number,
  replacement: readonly string[],
) {
  const previous = source[matchIndex - 1];
  const following = source[matchIndex + entry.standardTokens.length];

  if (
    previous &&
    blockedPreviousTokensBySourceRow.get(entry.sourceRow)?.has(previous)
  ) {
    return false;
  }
  if (
    following &&
    blockedFollowingTokensBySourceRow.get(entry.sourceRow)?.has(following)
  ) {
    return false;
  }

  // Prevent malformed duplicates such as "hình hình", "bông bông" or
  // "cây cây viết" when a workbook word occurs inside a larger phrase.
  if (
    (previous && previous === replacement[0]) ||
    (following && following === replacement[replacement.length - 1])
  ) {
    return false;
  }

  // "về -> dìa" is valid for returning somewhere, but not for the very
  // common educational preposition in "học/nói/tìm hiểu về...".
  if (
    entry.sourceRow === 555 &&
    !safePreviousTokensForReturnVerb.has(previous ?? "") &&
    !safeFollowingTokensForReturnVerb.has(following ?? "")
  ) {
    return false;
  }

  return true;
}

function replaceTokenSequence(
  source: readonly string[],
  entry: PreparedRegionalVocabularyEntry,
  replacement: readonly string[],
) {
  const matches: number[] = [];
  for (
    let index = 0;
    index <= source.length - entry.standardTokens.length;
    index += 1
  ) {
    if (
      entry.standardTokens.every(
        (token, offset) => source[index + offset] === token,
      ) &&
      replacementIsContextSafe(entry, source, index, replacement)
    ) {
      matches.push(index);
    }
  }

  const variants: string[][] = [];
  for (const matchIndex of matches) {
    variants.push([
      ...source.slice(0, matchIndex),
      ...replacement,
      ...source.slice(matchIndex + entry.standardTokens.length),
    ]);
  }

  if (matches.length > 1) {
    const matchIndexes = new Set(matches);
    const replacedAll: string[] = [];
    let sourceIndex = 0;
    while (sourceIndex < source.length) {
      if (matchIndexes.has(sourceIndex)) {
        replacedAll.push(...replacement);
        sourceIndex += entry.standardTokens.length;
      } else {
        replacedAll.push(source[sourceIndex]);
        sourceIndex += 1;
      }
    }
    variants.push(replacedAll);
  }

  return variants;
}

const preparedVocabulary = reviewedRegionalVocabularyV1
  .map((entry): PreparedRegionalVocabularyEntry => ({
    ...entry,
    standardTokens: normalizeVietnameseForExactMatch(entry.standard).split(" "),
    variantTokens: entry.variants.map((variant) =>
      normalizeVietnameseForExactMatch(variant).split(" "),
    ),
  }))
  .sort(
    (left, right) =>
      right.standardTokens.length - left.standardTokens.length,
  );

const vocabularyByFirstStandardToken = new Map<
  string,
  PreparedRegionalVocabularyEntry[]
>();
for (const entry of preparedVocabulary) {
  const firstToken = entry.standardTokens[0];
  const entries = vocabularyByFirstStandardToken.get(firstToken) ?? [];
  entries.push(entry);
  vocabularyByFirstStandardToken.set(firstToken, entries);
}

export function buildReviewedRegionalAliases(canonical: string) {
  const canonicalNormalized = normalizeVietnameseForExactMatch(canonical);
  const canonicalTokens = canonicalNormalized.split(" ");
  const candidateEntries = [
    ...new Set(
      canonicalTokens.flatMap(
        (token) => vocabularyByFirstStandardToken.get(token) ?? [],
      ),
    ),
  ].sort(
    (left, right) =>
      right.standardTokens.length - left.standardTokens.length,
  );
  const aliases = new Map([[canonicalNormalized, canonicalTokens]]);

  for (const entry of candidateEntries) {
    const additions: string[][] = [];
    for (const tokens of aliases.values()) {
      for (const variantTokens of entry.variantTokens) {
        additions.push(...replaceTokenSequence(tokens, entry, variantTokens));
      }
    }
    for (const tokens of additions) {
      const alias = tokens.join(" ");
      aliases.set(alias, tokens);
    }
  }

  aliases.delete(canonicalNormalized);
  return [...aliases.keys()];
}
