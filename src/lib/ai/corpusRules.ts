import corpusV1 from "./corpus/aiv0-v1-0001-0500.json";

export type ReviewedCorpusRule = {
  id: string;
  ageGroup: string;
  schoolLevel: string;
  context: string;
  topic: string;
  vietnamese: string;
  english: string;
  aliases: readonly string[];
};

function assertReviewedCorpus(
  records: ReviewedCorpusRule[],
): ReviewedCorpusRule[] {
  if (records.length !== 500) {
    throw new Error(`AIV0 V1 corpus must contain 500 rules, got ${records.length}`);
  }

  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (!record.id.trim() || !record.vietnamese.trim() || !record.english.trim()) {
      throw new Error(`Invalid AIV0 corpus rule at row ${index + 1}`);
    }
    if (ids.has(record.id)) {
      throw new Error(`Duplicate AIV0 corpus rule id: ${record.id}`);
    }
    ids.add(record.id);
  }

  return records;
}

/**
 * First reviewed rollout of the official AIV0 corpus. Additional 500-row
 * batches can be imported as separate versioned JSON files after language QA;
 * no runtime spreadsheet parsing is required.
 */
export const reviewedCorpusRulesV1 = assertReviewedCorpus(
  corpusV1 as ReviewedCorpusRule[],
);
