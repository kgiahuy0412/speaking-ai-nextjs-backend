import assert from "node:assert/strict";
import test from "node:test";
import { findReviewedAsrRuleMatch } from "./exactRules";
import {
  excludedRegionalVocabularyV1,
  reviewedRegionalVocabularyV1,
} from "./regionalVocabulary";
import {
  regionalChildSpeechRulesV1,
  repairVietnameseTranscriptWithCorpus,
} from "./transcriptCorpusRepair";

test("regional rollout contains exactly 100 reviewed child sentences", () => {
  assert.equal(regionalChildSpeechRulesV1.length, 100);
  assert.equal(new Set(regionalChildSpeechRulesV1.map((rule) => rule.id)).size, 100);
  assert.ok(regionalChildSpeechRulesV1.some((rule) => rule.id === "V1-CHILD-001"));
  assert.ok(regionalChildSpeechRulesV1.some((rule) => rule.id === "AIV0-0099"));
});

test("regional workbook rollout keeps only reviewed, context-safe entries", () => {
  assert.equal(reviewedRegionalVocabularyV1.length, 46);
  assert.equal(excludedRegionalVocabularyV1.length, 6);
  assert.equal(
    new Set(reviewedRegionalVocabularyV1.map((entry) => entry.sourceRow)).size,
    46,
  );
});

test("all 100 rollout sentences recover from missing Vietnamese diacritics", () => {
  for (const rule of regionalChildSpeechRulesV1) {
    const withoutDiacritics = rule.vietnamese
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/đ/giu, (letter) => (letter === "Đ" ? "D" : "d"));
    const repaired = repairVietnameseTranscriptWithCorpus(withoutDiacritics);
    assert.equal(repaired.text, rule.vietnamese, rule.id);
    assert.equal(repaired.ruleId, rule.id, rule.id);
  }
});

test("repairs observed happy-sentence variants to one canonical rule", () => {
  for (const source of [
    "Hom nay con rat vui",
    "Hôm nay con zất vui.",
    "Hôm nay con dất vui.",
    "Hôm nay con gất vui.",
    "Hôm nay con gấc vui.",
    "Hôm nay còn rất vui.",
    "Họm này cũng rất vui.",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, "Hôm nay con rất vui.", source);
    assert.equal(repaired.ruleId, "V1-CHILD-001", source);
    assert.equal(
      findReviewedAsrRuleMatch(repaired.text)?.rule.english,
      "Today, I'm very happy.",
      source,
    );
  }
});

test("repairs common regional and child-pronunciation substitutions", () => {
  const cases = new Map([
    ["Con mún uống nước.", "Con muốn uống nước."],
    ["Con nàm đổ nước rồi.", "Con làm đổ nước rồi."],
    ["Con xợ quá.", "Con sợ quá."],
    ["Con muốn chơi cầu chượt.", "Con muốn chơi cầu trượt."],
  ]);

  for (const [source, expected] of cases) {
    assert.equal(repairVietnameseTranscriptWithCorpus(source).text, expected);
  }
});

test("repairs reviewed North, Central, and South whole-sentence aliases", () => {
  const cases = new Map([
    ["Bữa ni con rất bui.", "Hôm nay con rất vui."],
    ["Con mần đổ nác rầu.", "Con làm đổ nước rồi."],
    ["Má giùm con mặc áo nha.", "Mẹ giúp con mặc áo nhé."],
    ["Con muốn đi cầu.", "Con muốn đi vệ sinh."],
    ["Con cần một cây viết chì.", "Con cần một cây bút chì."],
    ["Con đếm được năm trái banh.", "Con đếm được năm quả bóng."],
    [
      "Con kiếm hổng ra đôi vớ của con.",
      "Con không tìm thấy đôi tất của con.",
    ],
    ["Con nỏ ưng món ni.", "Con không thích món này."],
    ["Con tự cột dây giày được.", "Con tự buộc dây giày được."],
    ["Con chùi bàn được hông?", "Con lau bàn được không?"],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "regional_alias", source);
  }
});

test("does not force unrelated, negated, or legitimate sentences into corpus", () => {
  for (const source of [
    "Con thích quả gấc.",
    "Hôm nay con rất buồn.",
    "Con không muốn ăn cơm.",
    "Bố muốn uống cà phê.",
    "Bữa ni mẹ rất buồn.",
    "Con khoái quả gấc.",
    "Cô o ơi.",
  ]) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, source);
    assert.equal(repaired.repaired, false);
  }
});
