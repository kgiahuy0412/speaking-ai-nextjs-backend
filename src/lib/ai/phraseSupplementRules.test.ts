import assert from "node:assert/strict";
import test from "node:test";
import {
  findReviewedExactRule,
  normalizeVietnameseForExactMatch,
} from "./exactRules";
import { reviewedPhraseSupplementRulesV1 } from "./phraseSupplementRules";

test("phrase supplement contains all 214 reviewed legacy candidates", () => {
  assert.equal(reviewedPhraseSupplementRulesV1.length, 214);
  assert.equal(
    new Set(reviewedPhraseSupplementRulesV1.map((rule) => rule.id)).size,
    214,
  );
  assert.ok(
    reviewedPhraseSupplementRulesV1.every(
      (rule) =>
        rule.vietnamese.trim() &&
        rule.english.trim() &&
        rule.aliases.includes(rule.sourcePhrase),
    ),
  );
});

test("official 5000-sentence corpus text is retained when available", () => {
  const sourcedFromMaster = reviewedPhraseSupplementRulesV1.filter(
    (rule) => rule.masterCorpusIds.length > 0,
  );

  assert.equal(sourcedFromMaster.length, 5);
  assert.equal(
    sourcedFromMaster.find((rule) => rule.sourcePhrase === "con muon di tam")
      ?.vietnamese,
    "Con muốn đi tắm.",
  );
});

test("accented sentences and original unaccented aliases use the same fast path", () => {
  assert.equal(
    findReviewedExactRule("Cho con xin nước.")?.english,
    "Can I have some water, please?",
  );
  assert.equal(
    findReviewedExactRule("cho con xin nuoc")?.english,
    "Can I have some water, please?",
  );
});

test("official corpus translations win over legacy phrase conflicts", () => {
  assert.equal(
    findReviewedExactRule("Con muốn ăn cơm.")?.english,
    "I want to eat rice.",
  );
  assert.equal(
    findReviewedExactRule("Con muốn mua cái này.")?.english,
    "I want to buy this.",
  );
  assert.equal(
    findReviewedExactRule("Con muốn uống nước.")?.english,
    "I want some water.",
  );
});

test("new official corpus rows win over equal supplement entries", () => {
  assert.equal(findReviewedExactRule("Con muốn đi tắm.")?.id, "AIV0-0511");
  assert.equal(findReviewedExactRule("Con muốn đánh răng.")?.id, "AIV0-0505");
  assert.equal(
    findReviewedExactRule("Con muốn chơi xích đu.")?.id,
    "AIV0-0529",
  );
});

test("supplement has no normalized Vietnamese conflict", () => {
  const englishByVietnamese = new Map<string, string>();

  for (const rule of reviewedPhraseSupplementRulesV1) {
    const key = normalizeVietnameseForExactMatch(rule.vietnamese);
    const existing = englishByVietnamese.get(key);
    assert.ok(
      existing === undefined || existing === rule.english,
      `Conflicting supplement translation for ${rule.id}`,
    );
    englishByVietnamese.set(key, rule.english);
  }
});
