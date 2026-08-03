import corpusV1Batch1 from "./corpus/aiv0-v1-0001-0500.json";
import corpusV1Batch2 from "./corpus/aiv0-v1-0501-1000.json";
import corpusV1Batch3 from "./corpus/aiv0-v1-1001-1500.json";
import corpusV1Batch4 from "./corpus/aiv0-v1-1501-2000.json";
import corpusV1Batch5 from "./corpus/aiv0-v1-2001-2500.json";
import corpusV1Batch6 from "./corpus/aiv0-v1-2501-3000.json";
import corpusV1Batch7 from "./corpus/aiv0-v1-3001-3500.json";
import corpusV1Batch8 from "./corpus/aiv0-v1-3501-4000.json";
import corpusV1Batch9 from "./corpus/aiv0-v1-4001-4500.json";
import corpusV1Batch10 from "./corpus/aiv0-v1-4501-5000.json";

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
  if (records.length !== 5_000) {
    throw new Error(
      `AIV0 V1 corpus must contain 5,000 rules, got ${records.length}`,
    );
  }

  const ids = new Set<string>();
  const englishByVietnamese = new Map<string, string>();
  for (const [index, record] of records.entries()) {
    if (!record.id.trim() || !record.vietnamese.trim() || !record.english.trim()) {
      throw new Error(`Invalid AIV0 corpus rule at row ${index + 1}`);
    }
    const expectedId = `AIV0-${String(index + 1).padStart(4, "0")}`;
    if (record.id !== expectedId) {
      throw new Error(
        `Unexpected AIV0 corpus rule id at row ${index + 1}: ${record.id}`,
      );
    }
    if (ids.has(record.id)) {
      throw new Error(`Duplicate AIV0 corpus rule id: ${record.id}`);
    }
    ids.add(record.id);

    const normalizedVietnamese = record.vietnamese
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .toLocaleLowerCase("vi")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const existingEnglish = englishByVietnamese.get(normalizedVietnamese);
    if (existingEnglish && existingEnglish !== record.english) {
      throw new Error(
        `Conflicting AIV0 corpus translation for ${record.id}`,
      );
    }
    englishByVietnamese.set(normalizedVietnamese, record.english);
  }

  return records;
}

/**
 * Reviewed rollout of all 5,000 official AIV0 corpus rows. Each 500-row
 * batch remains a separate versioned JSON file after language QA; no runtime
 * spreadsheet parsing is required.
 */
export const reviewedCorpusRulesV1 = assertReviewedCorpus(
  [
    ...(corpusV1Batch1 as ReviewedCorpusRule[]),
    ...(corpusV1Batch2 as ReviewedCorpusRule[]),
    ...(corpusV1Batch3 as ReviewedCorpusRule[]),
    ...(corpusV1Batch4 as ReviewedCorpusRule[]),
    ...(corpusV1Batch5 as ReviewedCorpusRule[]),
    ...(corpusV1Batch6 as ReviewedCorpusRule[]),
    ...(corpusV1Batch7 as ReviewedCorpusRule[]),
    ...(corpusV1Batch8 as ReviewedCorpusRule[]),
    ...(corpusV1Batch9 as ReviewedCorpusRule[]),
    ...(corpusV1Batch10 as ReviewedCorpusRule[]),
  ],
);
