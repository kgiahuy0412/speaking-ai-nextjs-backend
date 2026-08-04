import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAudioCheckWorkbook,
  type AudioCheckWorkbookRow,
} from "@/lib/client/exportAudioCheckWorkbook";

const sampleRow: AudioCheckWorkbookRow = {
  audioPath: "ThuMuc/BeA/cau-chao.wav",
  fileName: "cau-chao.wav",
  evaluation: "Lỗi",
  errorReason: "Sai chính tả",
  processingStatus: "Đã nhận diện",
  vietnameseText: "Con chào mẹ",
  englishText: "Hello, Mom.",
  recognitionMode: "Chế độ tiêu chuẩn",
  context: "Ở nhà",
  asrMs: 123,
  totalMs: 456,
  chunkCount: 1,
  fileSizeBytes: 2048,
  technicalError: "",
  conversationId: "conversation-1",
};

test("builds a valid stored ZIP container with the Excel workbook parts", () => {
  const workbook = buildAudioCheckWorkbook([sampleRow]);
  const view = new DataView(
    workbook.buffer,
    workbook.byteOffset,
    workbook.byteLength,
  );
  const decoded = new TextDecoder().decode(workbook);

  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(
    view.getUint32(workbook.byteLength - 22, true),
    0x06054b50,
  );
  assert.match(decoded, /\[Content_Types\]\.xml/);
  assert.match(decoded, /xl\/worksheets\/sheet1\.xml/);
  assert.match(decoded, /ThuMuc\/BeA\/cau-chao\.wav/);
  assert.match(decoded, /Sai chính tả/);
  assert.match(decoded, /autoFilter ref="A1:O2"/);
});
