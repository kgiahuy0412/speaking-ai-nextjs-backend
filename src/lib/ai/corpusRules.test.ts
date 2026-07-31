import assert from "node:assert/strict";
import test from "node:test";
import { reviewedCorpusRulesV1 } from "./corpusRules";
import {
  findReviewedExactRule,
  normalizeVietnameseForExactMatch,
  reviewedExactRulesV1,
} from "./exactRules";

test("AIV0 V1 imports exactly the first 1,000 complete reviewed rules", () => {
  assert.equal(reviewedCorpusRulesV1.length, 1_000);
  assert.equal(reviewedCorpusRulesV1[0]?.id, "AIV0-0001");
  assert.equal(reviewedCorpusRulesV1[499]?.id, "AIV0-0500");
  assert.equal(reviewedCorpusRulesV1[500]?.id, "AIV0-0501");
  assert.equal(reviewedCorpusRulesV1.at(-1)?.id, "AIV0-1000");
  assert.equal(
    new Set(reviewedCorpusRulesV1.map((rule) => rule.id)).size,
    1_000,
  );
  assert.ok(
    reviewedCorpusRulesV1.every(
      (rule) => rule.vietnamese.trim() && rule.english.trim(),
    ),
  );
});

test("AIV0 V1 has no normalized sentence with conflicting English", () => {
  const translations = new Map<string, string>();

  for (const rule of reviewedCorpusRulesV1) {
    const key = normalizeVietnameseForExactMatch(rule.vietnamese);
    const existing = translations.get(key);
    assert.ok(
      !existing || existing === rule.english,
      `Conflicting translation for ${rule.id}`,
    );
    translations.set(key, rule.english);
  }
});

test("first and last AIV0 sentences are active exact rules", () => {
  assert.equal(
    findReviewedExactRule(reviewedCorpusRulesV1[0].vietnamese)?.english,
    reviewedCorpusRulesV1[0].english,
  );
  assert.equal(
    findReviewedExactRule(reviewedCorpusRulesV1.at(-1)!.vietnamese)?.english,
    reviewedCorpusRulesV1.at(-1)!.english,
  );
});

test("second AIV0 batch is active and keeps corpus priority", () => {
  assert.equal(
    findReviewedExactRule("Con muốn ăn một quả chuối.")?.english,
    "I want to eat a banana.",
  );
  assert.equal(
    findReviewedExactRule("Con muốn rửa tay.")?.id,
    "AIV0-0502",
  );
});

test("all 500 new corpus translations are active in the 1,265-rule runtime", () => {
  assert.equal(reviewedExactRulesV1.length, 1_265);

  for (const rule of reviewedCorpusRulesV1.slice(500)) {
    assert.equal(
      findReviewedExactRule(rule.vietnamese)?.english,
      rule.english,
      `Inactive or changed translation for ${rule.id}`,
    );
  }
});
