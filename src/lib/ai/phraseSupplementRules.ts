import phraseSupplementV1 from "./corpus/phrase-supplement-v1.json";

export type ReviewedPhraseSupplementRule = {
  id: string;
  vietnamese: string;
  english: string;
  aliases: readonly string[];
  contexts: readonly string[];
  sourcePhrase: string;
  masterCorpusIds: readonly string[];
};

function assertReviewedPhraseSupplement(
  records: ReviewedPhraseSupplementRule[],
) {
  if (records.length !== 214) {
    throw new Error(
      `Phrase supplement V1 must contain 214 rules, got ${records.length}`,
    );
  }

  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (!record.id.trim() || !record.vietnamese.trim() || !record.english.trim()) {
      throw new Error(`Invalid phrase supplement rule at row ${index + 1}`);
    }
    if (ids.has(record.id)) {
      throw new Error(`Duplicate phrase supplement rule id: ${record.id}`);
    }
    ids.add(record.id);
  }

  return records;
}

/**
 * Reviewed migration of the 214 non-conflicting legacy phrase candidates.
 * Canonical Vietnamese contains diacritics; the original unaccented phrase is
 * retained only as an exact alias for ASR engines that omit diacritics.
 */
export const reviewedPhraseSupplementRulesV1 =
  assertReviewedPhraseSupplement(
    phraseSupplementV1 as ReviewedPhraseSupplementRule[],
  );
