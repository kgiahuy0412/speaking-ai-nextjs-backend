import type { PracticeContext } from "@/types/conversation";

export const PROMPT_VERSION = "mvp-context-v3-short";

export const contextLabels: Record<PracticeContext, string> = {
  home: "O nha",
  school: "Truoc / sau gio hoc",
  outside: "Ra ngoai",
};

export const sampleVietnameseByContext: Record<PracticeContext, string[]> = {
  home: ["Con muon uong nuoc", "Con doi roi", "Giup con voi"],
  school: ["Con quen sach roi", "Con can but chi", "Con khong hieu bai"],
  outside: ["Con muon mua cai nay", "Con bi lac", "Con can giup do"],
};

export function buildEnglishInstruction(context: PracticeContext, childAge = 6) {
  return `Context: ${contextLabels[context]}. Age: ${childAge}. Rewrite the Vietnamese child's utterance as one short, simple English sentence the child can say. Keep the child's intent/question; do not answer it. English only, no quotes. If readable, never ask to repeat.`;
}
