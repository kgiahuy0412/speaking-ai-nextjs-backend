import assert from "node:assert/strict";
import test from "node:test";
import { repairVietnameseChildTranscript } from "./transcriptRepair";

test("repairs a confused child subject at the beginning of speech", () => {
  assert.equal(
    repairVietnameseChildTranscript("Có muốn uống nước."),
    "Con muốn uống nước.",
  );
  assert.equal(
    repairVietnameseChildTranscript("có không thích món này"),
    "con không thích món này",
  );
});

test("repairs a confused child subject after a direct address", () => {
  assert.equal(
    repairVietnameseChildTranscript("Mẹ ơi, có muốn đi ngủ."),
    "Mẹ ơi, con muốn đi ngủ.",
  );
  assert.equal(
    repairVietnameseChildTranscript("Cô ơi có cần bút chì."),
    "Cô ơi con cần bút chì.",
  );
});

test("keeps legitimate uses of có, con and cô unchanged", () => {
  assert.equal(
    repairVietnameseChildTranscript("Có thể giúp con không?"),
    "Có thể giúp con không?",
  );
  assert.equal(
    repairVietnameseChildTranscript("Con có một câu hỏi."),
    "Con có một câu hỏi.",
  );
  assert.equal(
    repairVietnameseChildTranscript("Cô muốn con đọc bài."),
    "Cô muốn con đọc bài.",
  );
});
