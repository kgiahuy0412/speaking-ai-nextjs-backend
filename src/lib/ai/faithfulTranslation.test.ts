import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  faithfulTranslationGoldenSet,
} from "./faithfulTranslationGoldenSet";
import {
  findReviewedAsrRuleMatch,
  findReviewedExactRule,
  findReviewedExactRuleMatch,
  normalizeVietnameseForExactMatch,
  reviewedExactRulesV1,
} from "./exactRules";
import { buildEnglishInstruction } from "./prompts";
import {
  PROMPT_VERSION,
  RULE_VERSION,
  TEXT_CACHE_VERSION,
  TRANSLATION_POLICY_VERSION,
} from "./translationPolicy";
import { findMissingTranslationRequirements } from "./translationFidelity";
import { normalizeTranslationOutput } from "./translationOutputQuality";
import { getOfflineIntentManifest } from "./offlineIntentManifest";

test("golden set contains 50 unique faithful-translation cases", () => {
  assert.equal(faithfulTranslationGoldenSet.length, 50);
  assert.equal(
    new Set(faithfulTranslationGoldenSet.map((item) => item.id)).size,
    50,
  );
  assert.ok(
    faithfulTranslationGoldenSet.every(
      (item) =>
        item.vietnamese.trim() &&
        item.expectedEnglish.trim() &&
        item.rejectedEnglish.trim() &&
        item.criticalCriteria.length > 0,
    ),
  );
});

test("reviewed V1 rules match the whole normalized utterance only", () => {
  assert.equal(
    findReviewedExactRule("MẸ ƠI, CON MUỐN MUA CÁI NÀY!!!")?.english,
    "Mom, I want to buy this.",
  );
  assert.equal(
    findReviewedExactRule("Mẹ ơi, con muốn mua cái này nhé."),
    null,
  );
  assert.equal(
    findReviewedExactRule("Mẹ ơi, mình mua cái này được không?")?.english,
    "Mom, can we buy this?",
  );
  assert.equal(
    findReviewedExactRule("Con muốn mua cái này.")?.english,
    "I want to buy this.",
  );
  assert.equal(
    findReviewedExactRule("Con không muốn mua cái này.")?.english,
    "I don't want to buy this.",
  );
  assert.equal(
    findReviewedExactRule("ĐƯỜNG ĐI XA LẮM!!!")?.english,
    "It's a long way.",
  );
  assert.equal(
    findReviewedExactRule("Con muốn đi sở thú.")?.english,
    "I want to go to the zoo.",
  );
  assert.equal(
    findReviewedExactRule("Con muốn đi sở thú với mẹ."),
    null,
  );
});

test("exact normalization preserves Vietnamese diacritics and word order", () => {
  assert.notEqual(
    normalizeVietnameseForExactMatch("Má ơi, con khát nước quá."),
    normalizeVietnameseForExactMatch("Ma ơi, con khát nước quá."),
  );
  assert.notEqual(
    normalizeVietnameseForExactMatch("Con không muốn mua cái này."),
    normalizeVietnameseForExactMatch("Con muốn mua cái này."),
  );
  assert.ok(reviewedExactRulesV1.length >= 30);
});

test("reviewed aliases resolve to the canonical exact rule", () => {
  const match = findReviewedExactRuleMatch("Con muốn đi vườn thú!");

  assert.equal(match?.matchType, "alias");
  assert.equal(match?.rule.id, "V1-HIST-005");
  assert.equal(match?.rule.english, "I want to go to the zoo.");
  assert.equal(
    findReviewedExactRule("Con muốn đi sở thú.")?.id,
    "V1-HIST-005",
  );
});

test("ASR rule matching tolerates omitted diacritics without becoming fuzzy", () => {
  const positive = findReviewedAsrRuleMatch(
    "Me oi, con muon mua cai nay",
  );
  const negative = findReviewedAsrRuleMatch(
    "Con khong muon mua cai nay",
  );

  assert.equal(positive?.matchType, "asr_folded");
  assert.equal(positive?.rule.english, "Mom, I want to buy this.");
  assert.equal(negative?.rule.english, "I don't want to buy this.");
  assert.equal(findReviewedExactRule("Me oi, con muon mua cai nay"), null);
  assert.equal(
    findReviewedAsrRuleMatch("Me oi, con muon mua cai nay nhe"),
    null,
  );
});

test("exact normalization ignores compatibility and invisible formatting only", () => {
  assert.equal(
    normalizeVietnameseForExactMatch("Ｃｏｎ\u200B muốn   đi sở thú!!!"),
    normalizeVietnameseForExactMatch("Con muốn đi sở thú."),
  );
});

test("V1 prompt encodes the release-blocking faithful translation rules", () => {
  const prompt = buildEnglishInstruction("outside", 6);

  assert.match(prompt, /Preserve the speaker, addressee, pronouns/i);
  assert.match(prompt, /Preserve the original speech act/i);
  assert.match(prompt, /Do not summarize, simplify, paraphrase/i);
  assert.match(prompt, /If the source is incomplete/i);
  assert.match(prompt, /Mom, I want to buy this\./);
  assert.match(prompt, /Mom, can we buy this\?/);
  assert.match(prompt, /I don't want to buy this\./);
  assert.match(prompt, /sentence-final "với" marks a polite request/i);
  assert.match(prompt, /"chỗ này" means "this part\/this"/i);
  assert.match(prompt, /"Cây bút" means "pen"/i);
  assert.match(prompt, /bố\/ba = Dad/i);
  assert.match(prompt, /Preserve every explicit color, number, time and place/i);
  assert.match(prompt, /Dad, please take me to school\./);
  assert.match(prompt, /Teacher, how do you read this part\?/);
});

test("fidelity guard rejects obvious semantic loss before caching", () => {
  assert.deepEqual(
    findMissingTranslationRequirements(
      "Bố ơi, ngày mai con không muốn đi công viên.",
      "Brother, tomorrow I don't want to go to kindergarten.",
    ),
    ["kinship_dad", "place_park"],
  );
  assert.deepEqual(
    findMissingTranslationRequirements(
      "Mẹ ơi, con muốn mua cây bút màu tím này.",
      "Mom, I want to buy this pen.",
    ),
    ["color_purple"],
  );
  assert.deepEqual(
    findMissingTranslationRequirements(
      "Bố ơi, ngày mai con không muốn đi công viên.",
      "Dad, tomorrow I don't want to go to the park.",
    ),
    [],
  );
});

test("online text generation has no OpenAI client or fallback", async () => {
  const llmSource = await readFile(new URL("./llm.ts", import.meta.url), "utf8");

  assert.doesNotMatch(llmSource, /getOpenAIClient/);
  assert.doesNotMatch(llmSource, /api\.openai\.com/);
  assert.doesNotMatch(llmSource, /fallbackProvider/);
});

test("online LLM fast path cannot use legacy keyword or semantic outputs", async () => {
  const llmSource = await readFile(new URL("./llm.ts", import.meta.url), "utf8");

  assert.doesNotMatch(llmSource, /keywordIntentRules/);
  assert.doesNotMatch(llmSource, /findSemanticIntent/);
  assert.doesNotMatch(llmSource, /semantic_cache/);
  assert.match(llmSource, /findReviewedAsrRuleMatch/);
});

test("Cloudflare is the only online text provider", async () => {
  const llmSource = await readFile(new URL("./llm.ts", import.meta.url), "utf8");

  assert.match(llmSource, /translateVietnameseWithCloudflare/);
  assert.match(llmSource, /provider: "cloudflare"/);
  assert.doesNotMatch(llmSource, /translateWithOpenAI/);
  assert.doesNotMatch(llmSource, /fallbackProvider/);
});

test("prompt, rule and text cache use explicit V1 versions", () => {
  assert.match(TRANSLATION_POLICY_VERSION, /^v1-/);
  assert.match(PROMPT_VERSION, /^v1-/);
  assert.match(RULE_VERSION, /^v1-/);
  assert.match(TEXT_CACHE_VERSION, /^v1-/);
  assert.equal(
    new Set([
      TRANSLATION_POLICY_VERSION,
      PROMPT_VERSION,
      RULE_VERSION,
      TEXT_CACHE_VERSION,
    ]).size,
    4,
  );
});

test("translation output guard rejects provider instructions before caching or TTS", () => {
  assert.equal(
    normalizeTranslationOutput(
      "The child is 4 years old. However, you didn't provide a Vietnamese utterance for me to translate. Please provide the utterance.",
    ),
    null,
  );
  assert.equal(
    normalizeTranslationOutput(
      "Please provide the Vietnamese sentence you would like me to translate.",
    ),
    null,
  );
  assert.equal(
    normalizeTranslationOutput("Translation: I want some water."),
    "I want some water.",
  );
});

test("device manifest publishes reviewed rules as exact full-sentence samples", async () => {
  const manifest = await getOfflineIntentManifest(500);
  const exactRule = manifest.items.find((item) => item.id === "exact-V1-001");
  const aliasRule = manifest.items.find(
    (item) => item.id === "exact-V1-HIST-005",
  );

  assert.ok(exactRule);
  assert.deepEqual(exactRule.samples, ["Mẹ ơi, con muốn mua cái này."]);
  assert.equal(exactRule.englishText, "Mom, I want to buy this.");
  assert.match(exactRule.audioUrl, /^\/api\/audio\/stream\?text=/);
  assert.ok(aliasRule);
  assert.deepEqual(aliasRule.samples, [
    "Con muốn đi sở thú.",
    "Con muốn đi vườn thú.",
  ]);
});
