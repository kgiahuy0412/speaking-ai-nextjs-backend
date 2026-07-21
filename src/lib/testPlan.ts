import type { PracticeContext } from "@/types/conversation";
import { keywordIntentRules, phraseRules } from "@/lib/ai/phraseRules";
import { semanticIntentRules } from "@/lib/ai/semanticIntents";

export type TestSentenceGroup = "A" | "B" | "C";

export type MvpTestSentence = {
  id: string;
  group: TestSentenceGroup;
  text: string;
  expectedMode: "rule" | "ai" | "fallback";
};

export const testGroupLabels: Record<TestSentenceGroup, string> = {
  A: "A - cau rule/keyword/fuzzy",
  B: "B - cau tu do",
  C: "C - cau can kiem tra",
};

const exploratoryTestSentences: Record<PracticeContext, MvpTestSentence[]> = {
  home: [
    { id: "home-b-01", group: "B", text: "Con muon me doc truyen cho con", expectedMode: "rule" },
    { id: "home-b-02", group: "B", text: "Con muon bo choi voi con", expectedMode: "rule" },
    { id: "home-b-03", group: "B", text: "Con khong thich mon nay", expectedMode: "ai" },
    { id: "home-b-04", group: "B", text: "Con muon xem phim hoat hinh", expectedMode: "rule" },
    { id: "home-b-05", group: "B", text: "Con lam roi nuoc ra ban", expectedMode: "rule" },
    { id: "home-c-01", group: "C", text: "Con", expectedMode: "fallback" },
    { id: "home-c-02", group: "C", text: "Cai kia do me", expectedMode: "rule" },
    { id: "home-c-03", group: "C", text: "Con muon cai nay cai kia", expectedMode: "rule" },
  ],
  school: [
    { id: "school-b-01", group: "B", text: "Co oi con co the hoi bai nay khong", expectedMode: "ai" },
    { id: "school-b-02", group: "B", text: "Ban lay do cua con", expectedMode: "rule" },
    { id: "school-b-03", group: "B", text: "Con muon choi voi ban kia", expectedMode: "rule" },
    { id: "school-b-04", group: "B", text: "Con khong nghe ro co noi gi", expectedMode: "rule" },
    { id: "school-b-05", group: "B", text: "Con can them thoi gian", expectedMode: "rule" },
    { id: "school-c-01", group: "C", text: "Con", expectedMode: "fallback" },
    { id: "school-c-02", group: "C", text: "But sach vo gi do", expectedMode: "ai" },
    { id: "school-c-03", group: "C", text: "Khong biet", expectedMode: "ai" },
  ],
  outside: [
    { id: "outside-b-01", group: "B", text: "Con muon xem con robot kia", expectedMode: "rule" },
    { id: "outside-b-02", group: "B", text: "Cho con di cong vien duoc khong", expectedMode: "rule" },
    { id: "outside-b-03", group: "B", text: "Dong nguoi qua con so", expectedMode: "rule" },
    { id: "outside-b-04", group: "B", text: "Con muon chup anh voi cai nay", expectedMode: "rule" },
    { id: "outside-b-05", group: "B", text: "Con khong thay me dau", expectedMode: "rule" },
    { id: "outside-c-01", group: "C", text: "Con", expectedMode: "fallback" },
    { id: "outside-c-02", group: "C", text: "Cai nay kia", expectedMode: "rule" },
    { id: "outside-c-03", group: "C", text: "Di di di", expectedMode: "ai" },
  ],
};

function buildRuleTestSentences(context: PracticeContext): MvpTestSentence[] {
  const phraseTests = phraseRules[context].map((rule, index) => ({
    id: `${context}-a-phrase-${index + 1}`,
    group: "A" as const,
    text: rule.vietnamese,
    expectedMode: "rule" as const,
  }));

  const keywordTests = keywordIntentRules[context].map((rule, index) => ({
    id: `${context}-a-keyword-${index + 1}`,
    group: "A" as const,
    text: rule.sample,
    expectedMode: "rule" as const,
  }));
  const semanticTests = semanticIntentRules[context].flatMap((rule, index) =>
    rule.samples.slice(0, 1).map((sample) => ({
      id: `${context}-a-semantic-${index + 1}`,
      group: "A" as const,
      text: sample,
      expectedMode: "rule" as const,
    })),
  );

  return [...phraseTests, ...keywordTests, ...semanticTests];
}

export const mvpTestPlan: Record<PracticeContext, MvpTestSentence[]> = {
  home: [...buildRuleTestSentences("home"), ...exploratoryTestSentences.home],
  school: [
    ...buildRuleTestSentences("school"),
    ...exploratoryTestSentences.school,
  ],
  outside: [
    ...buildRuleTestSentences("outside"),
    ...exploratoryTestSentences.outside,
  ],
};
