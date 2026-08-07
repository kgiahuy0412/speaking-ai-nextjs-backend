import assert from "node:assert/strict";
import test from "node:test";
import {
  findReviewedAsrRuleMatch,
  normalizeVietnameseForExactMatch,
} from "./exactRules";
import {
  buildReviewedRegionalAliases,
  excludedRegionalVocabularyV1,
  reviewedRegionalVocabularyV1,
} from "./regionalVocabulary";
import {
  regionalChildSpeechRulesV1,
  regionalCorpusMatchRulesV1,
  regionalCorpusRulesV1,
  regionalCorpusRuntimeStats,
  repairVietnameseTranscriptWithCorpus,
} from "./transcriptCorpusRepair";
import {
  findObservedChildSpeechAlias,
  observedChildSpeechAliases,
  observedChildSpeechAliasRuntimeStats,
} from "./observedChildSpeechAliases";

test("regional rollout contains exactly 100 reviewed child sentences", () => {
  assert.equal(regionalChildSpeechRulesV1.length, 100);
  assert.equal(new Set(regionalChildSpeechRulesV1.map((rule) => rule.id)).size, 100);
  assert.ok(regionalChildSpeechRulesV1.some((rule) => rule.id === "V1-CHILD-001"));
  assert.ok(regionalChildSpeechRulesV1.some((rule) => rule.id === "AIV0-0099"));
});

test("regional workbook rollout keeps only reviewed, context-safe entries", () => {
  assert.equal(reviewedRegionalVocabularyV1.length, 141);
  assert.equal(excludedRegionalVocabularyV1.length, 6);
  assert.equal(
    new Set(reviewedRegionalVocabularyV1.map((entry) => entry.sourceRow)).size,
    141,
  );
});

test("regional exact-alias rollout covers the complete official corpus", () => {
  assert.equal(regionalCorpusRulesV1.length, 5_000);
  assert.equal(regionalCorpusMatchRulesV1.length, 4_913);
  assert.equal(regionalCorpusRuntimeStats.sourceRuleCount, 5_000);
  assert.equal(regionalCorpusRuntimeStats.uniqueCanonicalCount, 4_913);
  assert.ok(regionalCorpusRuntimeStats.exactAliasCount > 10_000);
  assert.ok(regionalCorpusRuntimeStats.foldedAliasCount > 10_000);
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

test("repairs observed Cloudflare child-speech errors without broad fuzzy matching", () => {
  const cases = new Map([
    ["Công mũ xem phim hòa cân", "Con muốn xem phim hoạt hình."],
    ["à con muốn xem phim hoặc hình", "Con muốn xem phim hoạt hình."],
    ["Con bị vẹn rồi", "Con mệt rồi."],
    ["Còn muốn đi sở thủ xìm càng hổ", "Con muốn đi sở thú xem con hổ."],
    ["Con học lớp xấu rồi", "Con học lớp sáu rồi."],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "observed_asr_alias", source);
  }
});

test("loads only unambiguous reviewed child-speech sentence aliases", () => {
  assert.equal(observedChildSpeechAliases.length, 797);
  assert.equal(observedChildSpeechAliasRuntimeStats.aliasCount, 797);
  assert.equal(observedChildSpeechAliasRuntimeStats.sourceRowCount, 958);
  assert.equal(
    observedChildSpeechAliasRuntimeStats.excludedAmbiguousSourceCount,
    12,
  );
  assert.equal(observedChildSpeechAliasRuntimeStats.excludedNoOpSourceCount, 3);
  assert.equal(
    observedChildSpeechAliasRuntimeStats.excludedNegationMismatchSourceCount,
    4,
  );
  assert.equal(
    observedChildSpeechAliasRuntimeStats.excludedProtectedRoleMismatchSourceCount,
    26,
  );
  assert.equal(
    observedChildSpeechAliasRuntimeStats.excludedPersonalNameSourceCount,
    14,
  );
  assert.equal(
    new Set(observedChildSpeechAliases.map((alias) => alias.id)).size,
    observedChildSpeechAliases.length,
  );
});

test("prefers reviewed child observations over broad accent-folded rules", () => {
  const cases = new Map([
    ["Con muốn ăn áo.", "Con muốn ăn táo."],
    ["Con muốn ăn côm.", "Con muốn ăn tôm."],
    ["Con thấy con èo.", "Con thấy con mèo."],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "observed_child_alias", source);
    assert.match(repaired.correctionId ?? "", /^CHILD-ASR-V1-[A-F0-9]{12}$/);
  }
});

test("does not auto-correct ambiguous or meaning-reversing workbook rows", () => {
  for (const source of [
    "Đây là cái báy.",
    "Con lấy cái báy.",
    "Không muốn nghe lại",
    "Anh không hiểu",
    "Con tên là bé My",
  ]) {
    assert.equal(findObservedChildSpeechAlias(source), null, source);
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.notEqual(repaired.strategy, "observed_child_alias", source);
  }
});

test("observed child aliases require an exact whole-sentence match", () => {
  assert.equal(findObservedChildSpeechAlias("Con muốn ăn côm thêm."), null);
  assert.equal(
    repairVietnameseTranscriptWithCorpus("Con muốn ăn côm thêm.").strategy,
    undefined,
  );
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

test("repairs regional aliases from every 500-row corpus batch", () => {
  const cases = new Map([
    ["Con bị đau ở ni.", "Con bị đau ở đây."],
    ["Con muốn ăn một trái chuối.", "Con muốn ăn một quả chuối."],
    [
      "Lát nựa, con sẽ ăn một trái chuối.",
      "Lát nữa, con sẽ ăn một quả chuối.",
    ],
    [
      "Sau nớ, con sẽ ăn một trái chuối.",
      "Sau đó, con sẽ ăn một quả chuối.",
    ],
    ["Bữa ni, con muốn chọn áo đặng mặc.", "Hôm nay, con muốn chọn áo để mặc."],
    ["Sau nớ, con sẽ chùi khô tay.", "Sau đó, con sẽ lau khô tay."],
    ["Con muốn kêu má khi cần.", "Con muốn gọi mẹ khi cần."],
    ["Con thường kêu mạ khi cần.", "Con thường gọi mẹ khi cần."],
    ["Con muốn uống nác khi khát.", "Con muốn uống nước khi khát."],
    [
      "Ở nhà, con thường uống nác khi khát.",
      "Ở nhà, con thường uống nước khi khát.",
    ],
  ]);

  for (const [source, expected] of cases) {
    const repaired = repairVietnameseTranscriptWithCorpus(source);
    assert.equal(repaired.text, expected, source);
    assert.equal(repaired.strategy, "regional_alias", source);
  }
});

test("every unambiguous generated regional alias returns its corpus sentence", () => {
  const canonicalByVietnamese = new Map(
    regionalCorpusMatchRulesV1.map((rule) => [
      normalizeVietnameseForExactMatch(rule.vietnamese),
      rule,
    ]),
  );
  let checkedAliases = 0;

  for (const rule of regionalCorpusMatchRulesV1) {
    for (const alias of buildReviewedRegionalAliases(rule.vietnamese)) {
      const canonicalCollision = canonicalByVietnamese.get(
        normalizeVietnameseForExactMatch(alias),
      );
      if (canonicalCollision && canonicalCollision.id !== rule.id) continue;

      const repaired = repairVietnameseTranscriptWithCorpus(alias);
      assert.equal(repaired.text, rule.vietnamese, `${rule.id}: ${alias}`);
      checkedAliases += 1;
    }
  }

  assert.equal(
    regionalCorpusRuntimeStats.exactAliasCount - checkedAliases,
    buildReviewedRegionalAliases("Hôm nay con rất vui.").length,
  );
});

test("does not create context-invalid workbook aliases", () => {
  const cases = [
    ["Theo mình, nhóm nên dùng hình ảnh này.", "hình hình"],
    ["Con sẽ sắp xếp để không ảnh hưởng việc học.", "hình hưởng"],
    ["Con quên mang hộp bút.", "hộp cây viết"],
    ["Con muốn cất đồ chơi.", "đồ nhởi"],
    ["Mình đang học về cách giảm ô nhiễm.", "dù nhiễm"],
    ["Con nghe thấy tiếng chuông.", "nghe chộ"],
    ["Mình rẽ trái ở ngã tư nhé.", "rẽ trấy"],
    ["Con học về lời nói lịch sự.", "học dìa"],
    ["Con muốn tham gia câu lạc bộ.", "đậu phộng"],
    ["Cô cho em xem lại ví dụ được không ạ?", "bóp dụ"],
    ["Con muốn chơi xích đu.", "sên đu"],
    ["Trong lớp, em muốn đọc to câu trả lời.", "đọc bự"],
  ] as const;

  for (const [canonical, invalidFragment] of cases) {
    assert.ok(
      buildReviewedRegionalAliases(canonical).every(
        (alias) => !alias.includes(invalidFragment),
      ),
      `${canonical} -> ${invalidFragment}`,
    );
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
