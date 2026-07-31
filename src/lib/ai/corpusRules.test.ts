import assert from "node:assert/strict";
import test from "node:test";
import { reviewedCorpusRulesV1 } from "./corpusRules";
import {
  findReviewedExactRule,
  normalizeVietnameseForExactMatch,
} from "./exactRules";

test("AIV0 V1 imports exactly the first 500 complete reviewed rules", () => {
  assert.equal(reviewedCorpusRulesV1.length, 500);
  assert.equal(reviewedCorpusRulesV1[0]?.id, "AIV0-0001");
  assert.equal(reviewedCorpusRulesV1.at(-1)?.id, "AIV0-0500");
  assert.equal(
    new Set(reviewedCorpusRulesV1.map((rule) => rule.id)).size,
    500,
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
