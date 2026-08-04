import { normalizeVietnameseForExactMatch } from "./exactRules";
import { allRegionalVocabularyRowsV1 } from "./regionalVocabularyAllData";

export type RegionalVocabularyReplacement = {
  source: string;
  standard: string;
  sourceRows: readonly number[];
};

export type RegionalVocabularyNormalizationResult = {
  text: string;
  normalized: boolean;
  replacements: readonly RegionalVocabularyReplacement[];
  unresolvedVariants: readonly string[];
};

type VariantTarget = {
  standard: string;
  sourceRows: Set<number>;
};

type PreparedVariant = {
  variant: string;
  variantTokens: readonly string[];
  standard?: string;
  sourceRows: readonly number[];
  enabled: boolean;
  skipReason?: "ambiguous" | "standard_homonym" | "single_word_not_reviewed";
};

type SurfaceToken = {
  value: string;
  normalized: string;
  start: number;
  end: number;
};

/**
 * Single-token variants need stricter review than phrases. Many workbook
 * values are also valid words with a different meaning (for example
 * "răng", "má", "thắng" or "giá"). Longer phrases are much less likely to
 * be accidental homonyms and are enabled automatically when they have one
 * unambiguous standard meaning.
 */
const reviewedSafeSingleWordVariants = new Set(
  [
    "ẵm",
    "bả",
    "bắp",
    "bẩu",
    "bể",
    "bển",
    "béng",
    "bịnh",
    "bọ",
    "bôm",
    "bồng",
    "bự",
    "bựa",
    "bui",
    "bươi",
    "chạc",
    "chén",
    "chi",
    "chơ",
    "chửa",
    "chùi",
    "chưn",
    "coi",
    "cọp",
    "cụng",
    "cươi",
    "đàng",
    "đặng",
    "dầy",
    "dệ",
    "dìa",
    "dơ",
    "đọi",
    "đờn",
    "giầu",
    "giời",
    "giùm",
    "giựt",
    "gởi",
    "gưn",
    "hẻm",
    "hên",
    "heo",
    "hoài",
    "hông",
    "kiếng",
    "lặt",
    "lầu",
    "lẹ",
    "lộn",
    "lưa",
    "lủng",
    "lượm",
    "mạ",
    "mần",
    "mập",
    "mầu",
    "mệ",
    "méc",
    "mền",
    "miềng",
    "mùng",
    "mướn",
    "muỗng",
    "nác",
    "náng",
    "nè",
    "ngái",
    "ngàn",
    "ngoải",
    "ngộp",
    "nhẩy",
    "nhời",
    "nhởi",
    "nhông",
    "nhứt",
    "ni",
    "nỏ",
    "nớ",
    "nom",
    "nón",
    "nựa",
    "ổng",
    "phẻ",
    "phước",
    "quạu",
    "quẹo",
    "ráng",
    "rầu",
    "rỗi",
    "rọng",
    "rọt",
    "rứa",
    "rước",
    "rượt",
    "sèm",
    "sình",
    "tầu",
    "té",
    "tê",
    "tề",
    "thâu",
    "thẹo",
    "thiệt",
    "thúi",
    "tiệm",
    "tra",
    "trấy",
    "trễ",
    "trển",
    "trốc",
    "trỏng",
    "tru",
    "tui",
    "uổng",
    "vô",
    "xui",
  ].map(normalizeVietnameseForExactMatch),
);

const standardTerms = new Set(
  allRegionalVocabularyRowsV1.map((row) =>
    normalizeVietnameseForExactMatch(row.standard),
  ),
);

const targetsByVariant = new Map<string, Map<string, VariantTarget>>();
for (const row of allRegionalVocabularyRowsV1) {
  const standard = normalizeVietnameseForExactMatch(row.standard);
  for (const rawVariant of [row.south, row.central, row.north]) {
    const variant = normalizeVietnameseForExactMatch(rawVariant);
    if (!variant || variant === standard) continue;

    const targets = targetsByVariant.get(variant) ?? new Map();
    const target = targets.get(standard) ?? {
      standard,
      sourceRows: new Set<number>(),
    };
    target.sourceRows.add(row.sourceRow);
    targets.set(standard, target);
    targetsByVariant.set(variant, targets);
  }
}

const preparedVariants: PreparedVariant[] = [...targetsByVariant].map(
  ([variant, targets]) => {
    const variantTokens = variant.split(" ");
    const targetList = [...targets.values()];
    const sourceRows = [
      ...new Set(targetList.flatMap((target) => [...target.sourceRows])),
    ].sort((left, right) => left - right);

    if (targetList.length !== 1) {
      return {
        variant,
        variantTokens,
        sourceRows,
        enabled: false,
        skipReason: "ambiguous",
      };
    }

    const standard = targetList[0].standard;
    if (standardTerms.has(variant)) {
      return {
        variant,
        variantTokens,
        standard,
        sourceRows,
        enabled: false,
        skipReason: "standard_homonym",
      };
    }

    if (
      variantTokens.length === 1 &&
      !reviewedSafeSingleWordVariants.has(variant)
    ) {
      return {
        variant,
        variantTokens,
        standard,
        sourceRows,
        enabled: false,
        skipReason: "single_word_not_reviewed",
      };
    }

    return {
      variant,
      variantTokens,
      standard,
      sourceRows,
      enabled: true,
    };
  },
);

// The workbook contains "bữa ni -> hôm nay" and "ni -> này". Children also
// commonly mix the standard noun with the Central particle as "hôm ni". This
// composed phrase must become "hôm nay", not the mechanically valid but
// unnatural "hôm này".
preparedVariants.push({
  variant: "hôm ni",
  variantTokens: ["hôm", "ni"],
  standard: "hôm nay",
  sourceRows: [236, 329],
  enabled: true,
});

function comparePreparedVariants(left: PreparedVariant, right: PreparedVariant) {
  return (
    right.variantTokens.length - left.variantTokens.length ||
    right.variant.length - left.variant.length
  );
}

const enabledVariantsByFirstToken = new Map<string, PreparedVariant[]>();
const unresolvedVariantsByFirstToken = new Map<string, PreparedVariant[]>();
for (const entry of preparedVariants) {
  const index = entry.enabled
    ? enabledVariantsByFirstToken
    : unresolvedVariantsByFirstToken;
  const firstToken = entry.variantTokens[0];
  const candidates = index.get(firstToken) ?? [];
  candidates.push(entry);
  candidates.sort(comparePreparedVariants);
  index.set(firstToken, candidates);
}

export const regionalVocabularyNormalizerStats = {
  sourceRowCount: allRegionalVocabularyRowsV1.length,
  uniqueVariantCount: targetsByVariant.size,
  enabledVariantCount: preparedVariants.filter((entry) => entry.enabled).length,
  ambiguousVariantCount: preparedVariants.filter(
    (entry) => entry.skipReason === "ambiguous",
  ).length,
  standardHomonymCount: preparedVariants.filter(
    (entry) => entry.skipReason === "standard_homonym",
  ).length,
  unreviewedSingleWordCount: preparedVariants.filter(
    (entry) => entry.skipReason === "single_word_not_reviewed",
  ).length,
} as const;

function tokenizeSurface(text: string): SurfaceToken[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: match[0],
    normalized: normalizeVietnameseForExactMatch(match[0]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function matchesAt(
  tokens: readonly SurfaceToken[],
  tokenIndex: number,
  entry: PreparedVariant,
) {
  return entry.variantTokens.every(
    (token, offset) => tokens[tokenIndex + offset]?.normalized === token,
  );
}

function capitalizeLikeSource(replacement: string, source: string) {
  const sourceLetter = source.match(/\p{L}/u)?.[0];
  if (
    !sourceLetter ||
    sourceLetter === sourceLetter.toLocaleLowerCase("vi")
  ) {
    return replacement;
  }

  return replacement.replace(/\p{L}/u, (letter) =>
    letter.toLocaleUpperCase("vi"),
  );
}

/**
 * Normalizes high-confidence regional vocabulary only after the complete
 * 5,000-sentence corpus has failed to match. Punctuation and surrounding text
 * are preserved. Ambiguous workbook entries are detected for telemetry but
 * never guessed or rewritten without sentence-level evidence.
 */
export function normalizeRegionalVietnameseOutsideCorpus(
  text: string,
): RegionalVocabularyNormalizationResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      text: trimmed,
      normalized: false,
      replacements: [],
      unresolvedVariants: [],
    };
  }

  const tokens = tokenizeSurface(text);
  if (tokens.length === 0) {
    return {
      text,
      normalized: false,
      replacements: [],
      unresolvedVariants: [],
    };
  }

  const output: string[] = [];
  const replacements: RegionalVocabularyReplacement[] = [];
  const unresolved = new Set<string>();
  let cursor = 0;
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    const enabledMatch = enabledVariantsByFirstToken
      .get(token.normalized)
      ?.find((entry) => matchesAt(tokens, tokenIndex, entry));

    if (enabledMatch?.standard) {
      const finalToken = tokens[
        tokenIndex + enabledMatch.variantTokens.length - 1
      ];
      const source = text.slice(token.start, finalToken.end);
      const standard = capitalizeLikeSource(enabledMatch.standard, source);
      output.push(text.slice(cursor, token.start), standard);
      cursor = finalToken.end;
      replacements.push({
        source,
        standard,
        sourceRows: enabledMatch.sourceRows,
      });
      tokenIndex += enabledMatch.variantTokens.length;
      continue;
    }

    const unresolvedMatch = unresolvedVariantsByFirstToken
      .get(token.normalized)
      ?.find((entry) => matchesAt(tokens, tokenIndex, entry));
    if (unresolvedMatch) {
      unresolved.add(unresolvedMatch.variant);
    }
    tokenIndex += 1;
  }

  if (replacements.length === 0) {
    return {
      text,
      normalized: false,
      replacements,
      unresolvedVariants: [...unresolved],
    };
  }

  output.push(text.slice(cursor));
  return {
    text: output.join(""),
    normalized: true,
    replacements,
    unresolvedVariants: [...unresolved],
  };
}
