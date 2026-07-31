import corpusV1Batch1 from "./corpus/aiv0-v1-0001-0500.json";
import corpusV1Batch2 from "./corpus/aiv0-v1-0501-1000.json";

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
  if (records.length !== 1_000) {
    throw new Error(
      `AIV0 V1 corpus must contain 1,000 rules, got ${records.length}`,
    );
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
 * Reviewed rollout of the first 1,000 official AIV0 corpus rows. Each 500-row
 * batch remains a separate versioned JSON file after language QA; no runtime
 * spreadsheet parsing is required.
 */
export const reviewedCorpusRulesV1 = assertReviewedCorpus(
  [
    ...(corpusV1Batch1 as ReviewedCorpusRule[]),
    ...(corpusV1Batch2 as ReviewedCorpusRule[]),
  ],
);
