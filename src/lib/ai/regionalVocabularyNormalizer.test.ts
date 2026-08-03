import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRegionalVietnameseOutsideCorpus,
  regionalVocabularyNormalizerStats,
} from "./regionalVocabularyNormalizer";

test("loads the complete three-region workbook as the fallback vocabulary", () => {
  assert.equal(regionalVocabularyNormalizerStats.sourceRowCount, 574);
  assert.equal(regionalVocabularyNormalizerStats.uniqueVariantCount, 597);
  assert.equal(regionalVocabularyNormalizerStats.ambiguousVariantCount, 20);
  assert.ok(regionalVocabularyNormalizerStats.enabledVariantCount > 400);
});

test("normalizes regional vocabulary in a sentence outside the corpus", () => {
  const result = normalizeRegionalVietnameseOutsideCorpus(
    "Bữa ni, con mần bài với mạ rồi đi ngủ.",
  );

  assert.equal(
    result.text,
    "Hôm nay, con làm bài với mẹ rồi đi ngủ.",
  );
  assert.equal(result.normalized, true);
  assert.deepEqual(
    result.replacements.map((replacement) => replacement.source),
    ["Bữa ni", "mần", "mạ"],
  );
});

test("uses the longest phrase before a shorter regional token", () => {
  const result = normalizeRegionalVietnameseOutsideCorpus(
    "Hôm ni con muốn uống nác.",
  );

  assert.equal(result.text, "Hôm nay con muốn uống nước.");
  assert.deepEqual(
    result.replacements.map((replacement) => replacement.source),
    ["Hôm ni", "nác"],
  );
});

test("does not guess ambiguous or standard homonym variants", () => {
  const source = "Ba nói ba lần rồi, con rẽ trái vì áo bị mắc.";
  const result = normalizeRegionalVietnameseOutsideCorpus(source);

  assert.equal(result.text, source);
  assert.equal(result.normalized, false);
  assert.ok(result.unresolvedVariants.includes("ba"));
  assert.ok(result.unresolvedVariants.includes("trái"));
  assert.ok(result.unresolvedVariants.includes("mắc"));
});

test("does not rewrite risky single-word homonyms without context", () => {
  const source = "Con đau chân nhưng vẫn lội qua nước.";
  const result = normalizeRegionalVietnameseOutsideCorpus(source);

  assert.equal(result.text, source);
  assert.equal(result.normalized, false);
  assert.ok(result.unresolvedVariants.includes("đau"));
  assert.ok(result.unresolvedVariants.includes("lội"));
});

test("preserves punctuation and capitalization around replacements", () => {
  const result = normalizeRegionalVietnameseOutsideCorpus(
    "Hông! Con chưa muốn vô, mạ ơi.",
  );

  assert.equal(result.text, "Không! Con chưa muốn vào, mẹ ơi.");
});
