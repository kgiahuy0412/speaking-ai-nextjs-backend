import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const rootDir = "D:/Code/HuaMei/App_noi/be/3_23th7/speaking-ai-nextjs-backend";
const outputDir = path.join(rootDir, "outputs", "019fb364-d28b-7721-9b51-7382188672bf");
const previewDir = path.join(rootDir, ".codex-tmp", "019fb364-d28b-7721-9b51-7382188672bf", "previews");
const outputPath = path.join(outputDir, "speaking-audio-test-report.xlsx");

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Tổng quan");
const tests = workbook.worksheets.add("Kiểm thử audio");
const lists = workbook.worksheets.add("Danh mục");

const colors = {
  navy: "#17365D",
  blue: "#2F75B5",
  paleBlue: "#D9EAF7",
  teal: "#0F6B78",
  green: "#2E7D32",
  paleGreen: "#E2F0D9",
  red: "#C62828",
  paleRed: "#FCE4D6",
  amber: "#B26A00",
  paleAmber: "#FFF2CC",
  gray: "#5B6573",
  paleGray: "#EEF1F4",
  white: "#FFFFFF",
  border: "#CBD5E1",
  text: "#1F2937",
};

function styleTitle(sheet, rangeAddress, text) {
  const range = sheet.getRange(rangeAddress);
  range.merge();
  range.values = [[text]];
  range.format = {
    fill: colors.navy,
    font: { name: "Aptos Display", size: 20, bold: true, color: colors.white },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  range.format.rowHeight = 34;
}

function styleSection(range) {
  range.format = {
    fill: colors.paleBlue,
    font: { name: "Aptos", size: 11, bold: true, color: colors.navy },
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: colors.border },
  };
}

function addCard(sheet, columns, label, formula, fill, valueColor, numberFormat = "0") {
  const [startColumn, endColumn] = columns.split(":");
  const labelRange = sheet.getRange(`${startColumn}8:${endColumn}8`);
  labelRange.merge();
  labelRange.values = [[label]];
  labelRange.format = {
    fill,
    font: { name: "Aptos", size: 10, bold: true, color: colors.gray },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: colors.border },
  };

  const valueRange = sheet.getRange(`${startColumn}9:${endColumn}10`);
  valueRange.merge();
  valueRange.formulas = [[formula]];
  valueRange.format = {
    fill,
    font: { name: "Aptos Display", size: 22, bold: true, color: valueColor },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    numberFormat,
    borders: { preset: "outside", style: "thin", color: colors.border },
  };
}

// ----- Tổng quan -----
summary.showGridLines = false;
styleTitle(summary, "A1:J1", "BÁO CÁO KIỂM THỬ TÍNH NĂNG LUYỆN NÓI BẰNG AUDIO");
summary.getRange("A3:J3").merge();
summary.getRange("A3:J3").values = [["File này là nguồn báo cáo chính. Mỗi dòng ở sheet “Kiểm thử audio” tương ứng với một lần kiểm thử."]];
summary.getRange("A3:J3").format = {
  fill: "#EAF2F8",
  font: { name: "Aptos", size: 10, italic: true, color: colors.navy },
  wrapText: true,
  verticalAlignment: "center",
};
summary.getRange("A3:J3").format.rowHeight = 28;

summary.getRange("A5:B6").values = [
  ["Dự án", "Speaking AI"],
  ["Ngày tạo mẫu", new Date("2026-07-31T00:00:00+07:00")],
];
summary.getRange("A5:A6").format = {
  fill: colors.paleGray,
  font: { name: "Aptos", bold: true, color: colors.text },
};
summary.getRange("B5:B6").format = { font: { name: "Aptos", color: colors.text } };
summary.getRange("B6").format.numberFormat = "yyyy-mm-dd";
summary.getRange("A5:B6").format.borders = { preset: "outside", style: "thin", color: colors.border };

addCard(summary, "A:B", "TỔNG SỐ LẦN TEST", "=COUNTA('Kiểm thử audio'!$C$5:$C$204)", colors.paleBlue, colors.navy);
addCard(summary, "C:D", "ĐẠT", "=COUNTIF('Kiểm thử audio'!$I$5:$I$204,\"Đạt\")", colors.paleGreen, colors.green);
addCard(summary, "E:F", "LỖI", "=COUNTIF('Kiểm thử audio'!$I$5:$I$204,\"Lỗi\")", colors.paleRed, colors.red);
addCard(summary, "G:H", "BỊ CHẶN", "=COUNTIF('Kiểm thử audio'!$I$5:$I$204,\"Bị chặn\")", colors.paleAmber, colors.amber);
addCard(summary, "I:J", "TỶ LỆ ĐẠT", "=IF(A9=0,0,C9/A9)", "#E8F3F1", colors.teal, "0.0%");

summary.getRange("A13:J13").merge();
summary.getRange("A13:J13").values = [["CÁCH GHI NHẬN KẾT QUẢ"]];
styleSection(summary.getRange("A13:J13"));
const instructions = [
  ["1", "Điền một dòng cho mỗi lần chạy audio; không gộp nhiều file audio vào cùng một dòng."],
  ["2", "Nếu có lỗi, ghi rõ tên audio, bước tái hiện, kết quả thực tế, thông báo lỗi và đường dẫn bằng chứng."],
  ["3", "Chọn Trạng thái và Mức độ lỗi từ danh sách thả xuống để số liệu Tổng quan cập nhật tự động."],
  ["4", "Sau khi sửa lỗi, điền Ngày kiểm tra lại và Kết quả kiểm tra lại; giữ nguyên dữ liệu lần test ban đầu."],
];
summary.getRange("A14:B17").values = instructions;
summary.getRange("A14:A17").format = {
  fill: colors.navy,
  font: { name: "Aptos", bold: true, color: colors.white },
  horizontalAlignment: "center",
  verticalAlignment: "center",
};
summary.getRange("B14:B17").format = {
  font: { name: "Aptos", color: colors.text },
  wrapText: true,
  verticalAlignment: "center",
};
summary.getRange("A14:B17").format.borders = { preset: "inside", style: "thin", color: colors.border };
summary.getRange("B14:B17").format.rowHeight = 30;

summary.getRange("A20:C20").values = [["Mức độ lỗi", "Số lượng", "Ý nghĩa"]];
summary.getRange("E20:G20").values = [["Trạng thái", "Số lượng", "Ý nghĩa"]];
for (const address of ["A20:C20", "E20:G20"]) {
  summary.getRange(address).format = {
    fill: colors.blue,
    font: { name: "Aptos", bold: true, color: colors.white },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
}
summary.getRange("A21:A25").values = [["Không áp dụng"], ["Thấp"], ["Trung bình"], ["Cao"], ["Nghiêm trọng"]];
summary.getRange("B21:B25").formulas = [
  ["=COUNTIF('Kiểm thử audio'!$J$5:$J$204,A21)"],
  ["=COUNTIF('Kiểm thử audio'!$J$5:$J$204,A22)"],
  ["=COUNTIF('Kiểm thử audio'!$J$5:$J$204,A23)"],
  ["=COUNTIF('Kiểm thử audio'!$J$5:$J$204,A24)"],
  ["=COUNTIF('Kiểm thử audio'!$J$5:$J$204,A25)"],
];
summary.getRange("C21:C25").values = [
  ["Không có lỗi"],
  ["Ảnh hưởng nhỏ, có cách tránh"],
  ["Ảnh hưởng một phần luồng test"],
  ["Chức năng chính sai hoặc khó sử dụng"],
  ["Không thể tiếp tục hoặc mất dữ liệu"],
];
summary.getRange("E21:E25").values = [["Chưa kiểm tra"], ["Đạt"], ["Lỗi"], ["Bị chặn"], ["Không ổn định"]];
summary.getRange("F21:F25").formulas = [
  ["=COUNTIF('Kiểm thử audio'!$I$5:$I$204,E21)"],
  ["=COUNTIF('Kiểm thử audio'!$I$5:$I$204,E22)"],
  ["=COUNTIF('Kiểm thử audio'!$I$5:$I$204,E23)"],
  ["=COUNTIF('Kiểm thử audio'!$I$5:$I$204,E24)"],
  ["=COUNTIF('Kiểm thử audio'!$I$5:$I$204,E25)"],
];
summary.getRange("G21:G25").values = [
  ["Chưa chạy audio"],
  ["Hoạt động đúng kỳ vọng"],
  ["Có lỗi tái hiện được"],
  ["Không thể hoàn tất do phụ thuộc"],
  ["Kết quả thay đổi giữa các lần chạy"],
];
for (const address of ["A21:C25", "E21:G25"]) {
  summary.getRange(address).format = {
    font: { name: "Aptos", size: 10, color: colors.text },
    wrapText: true,
    verticalAlignment: "center",
    borders: {
      insideHorizontal: { style: "thin", color: colors.border },
      bottom: { style: "thin", color: colors.border },
    },
  };
}
summary.getRange("B21:B25").format.numberFormat = "0";
summary.getRange("F21:F25").format.numberFormat = "0";
summary.freezePanes.freezeRows(1);
summary.getRange("A1:J1").format.font = { name: "Aptos Display", size: 20, bold: true, color: colors.white };
summary.getRange("A:A").format.columnWidth = 16;
summary.getRange("B:B").format.columnWidth = 42;
summary.getRange("C:C").format.columnWidth = 29;
summary.getRange("D:D").format.columnWidth = 3;
summary.getRange("E:E").format.columnWidth = 17;
summary.getRange("F:F").format.columnWidth = 12;
summary.getRange("G:G").format.columnWidth = 34;
summary.getRange("H:H").format.columnWidth = 3;
summary.getRange("I:J").format.columnWidth = 15;

// ----- Kiểm thử audio -----
tests.showGridLines = false;
styleTitle(tests, "A1:V1", "CHI TIẾT KIỂM THỬ AUDIO");
tests.getRange("A2:V2").merge();
tests.getRange("A2:V2").values = [["Nhập một dòng cho mỗi lần test. Các cột có danh sách thả xuống: Ngôn ngữ, Trạng thái, Mức độ lỗi và Kết quả kiểm tra lại."]];
tests.getRange("A2:V2").format = {
  fill: "#EAF2F8",
  font: { name: "Aptos", size: 10, italic: true, color: colors.navy },
  wrapText: true,
  verticalAlignment: "center",
};
tests.getRange("A2:V2").format.rowHeight = 28;

const headers = [[
  "Mã test",
  "Ngày kiểm tra",
  "Tên file audio",
  "Đường dẫn audio",
  "Ngôn ngữ",
  "Nội dung kỳ vọng",
  "Thời lượng (giây)",
  "Nguồn phát / thiết bị vào",
  "Trạng thái",
  "Mức độ lỗi",
  "Bước tái hiện",
  "Kết quả mong đợi",
  "Kết quả thực tế",
  "Thông báo lỗi",
  "Log / API liên quan",
  "Đường dẫn bằng chứng",
  "Nguyên nhân dự đoán",
  "Đề xuất xử lý",
  "Người kiểm tra",
  "Ngày kiểm tra lại",
  "Kết quả kiểm tra lại",
  "Ghi chú",
]];
tests.getRange("A4:V4").values = headers;
tests.getRange("A4:V4").format = {
  fill: colors.blue,
  font: { name: "Aptos", size: 10, bold: true, color: colors.white },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  wrapText: true,
};
tests.getRange("A4:V4").format.rowHeight = 38;

const blankRows = Array.from({ length: 200 }, () => Array(22).fill(null));
tests.getRange("A5:V204").values = blankRows;
tests.getRange("A5:V204").format = {
  font: { name: "Aptos", size: 10, color: colors.text },
  verticalAlignment: "top",
  wrapText: true,
};
tests.getRange("B5:B204").format.numberFormat = "yyyy-mm-dd";
tests.getRange("G5:G204").format.numberFormat = "0.0";
tests.getRange("T5:T204").format.numberFormat = "yyyy-mm-dd";
tests.getRange("A5:A204").format.horizontalAlignment = "center";
tests.getRange("E5:E204").format.horizontalAlignment = "center";
tests.getRange("G5:J204").format.horizontalAlignment = "center";
tests.getRange("S5:U204").format.horizontalAlignment = "center";

tests.getRange("E5:E204").dataValidation = {
  rule: { type: "list", values: ["Tiếng Anh", "Tiếng Việt", "Tiếng Trung", "Khác"] },
};
tests.getRange("I5:I204").dataValidation = {
  rule: { type: "list", values: ["Chưa kiểm tra", "Đạt", "Lỗi", "Bị chặn", "Không ổn định"] },
};
tests.getRange("J5:J204").dataValidation = {
  rule: { type: "list", values: ["Không áp dụng", "Thấp", "Trung bình", "Cao", "Nghiêm trọng"] },
};
tests.getRange("U5:U204").dataValidation = {
  rule: { type: "list", values: ["Chưa kiểm tra lại", "Đạt", "Còn lỗi", "Không tái hiện"] },
};

tests.getRange("I5:I204").conditionalFormats.add("containsText", {
  text: "Đạt",
  format: { fill: colors.paleGreen, font: { bold: true, color: colors.green } },
});
tests.getRange("I5:I204").conditionalFormats.add("containsText", {
  text: "Lỗi",
  format: { fill: colors.paleRed, font: { bold: true, color: colors.red } },
});
tests.getRange("I5:I204").conditionalFormats.add("containsText", {
  text: "Bị chặn",
  format: { fill: colors.paleAmber, font: { bold: true, color: colors.amber } },
});
tests.getRange("I5:I204").conditionalFormats.add("containsText", {
  text: "Không ổn định",
  format: { fill: "#FCE4EC", font: { bold: true, color: "#AD1457" } },
});
tests.getRange("J5:J204").conditionalFormats.add("containsText", {
  text: "Nghiêm trọng",
  format: { fill: "#7F0000", font: { bold: true, color: colors.white } },
});
tests.getRange("J5:J204").conditionalFormats.add("containsText", {
  text: "Cao",
  format: { fill: colors.paleRed, font: { bold: true, color: colors.red } },
});
tests.getRange("U5:U204").conditionalFormats.add("containsText", {
  text: "Còn lỗi",
  format: { fill: colors.paleRed, font: { bold: true, color: colors.red } },
});
tests.getRange("U5:U204").conditionalFormats.add("containsText", {
  text: "Đạt",
  format: { fill: colors.paleGreen, font: { bold: true, color: colors.green } },
});

const testsTable = tests.tables.add("A4:V204", true, "AudioTestTable");
testsTable.style = "TableStyleMedium2";
testsTable.showBandedRows = true;
testsTable.showFilterButton = true;
tests.freezePanes.freezeRows(4);
tests.freezePanes.freezeColumns(3);

const widths = [12, 14, 26, 38, 15, 34, 16, 28, 17, 17, 42, 34, 34, 34, 42, 36, 36, 36, 20, 18, 20, 34];
for (let index = 0; index < widths.length; index += 1) {
  tests.getRangeByIndexes(0, index, 204, 1).format.columnWidth = widths[index];
}
tests.getRange("A5:V204").format.rowHeight = 30;

// ----- Danh mục -----
lists.showGridLines = false;
styleTitle(lists, "A1:H1", "DANH MỤC VÀ QUY ƯỚC BÁO CÁO");
lists.getRange("A3:B3").values = [["Trạng thái", "Định nghĩa"]];
lists.getRange("A4:B8").values = [
  ["Chưa kiểm tra", "Audio chưa được chạy qua luồng luyện nói."],
  ["Đạt", "Kết quả đúng với nội dung và hành vi mong đợi."],
  ["Lỗi", "Có sai lệch tái hiện được từ audio hoặc ứng dụng."],
  ["Bị chặn", "Không thể hoàn tất do quyền, thiết bị, dịch vụ hoặc phụ thuộc khác."],
  ["Không ổn định", "Cùng audio nhưng kết quả thay đổi đáng kể giữa các lần chạy."],
];
lists.getRange("D3:E3").values = [["Mức độ lỗi", "Định nghĩa"]];
lists.getRange("D4:E8").values = [
  ["Không áp dụng", "Dùng khi không có lỗi."],
  ["Thấp", "Ảnh hưởng nhỏ, không cản trở luồng chính."],
  ["Trung bình", "Ảnh hưởng một phần chức năng hoặc cần cách tránh."],
  ["Cao", "Chức năng chính hoạt động sai hoặc khó sử dụng."],
  ["Nghiêm trọng", "Không thể tiếp tục, sai dữ liệu nghiêm trọng hoặc mất dữ liệu."],
];
lists.getRange("G3:H3").values = [["Kết quả kiểm tra lại", "Định nghĩa"]];
lists.getRange("G4:H7").values = [
  ["Chưa kiểm tra lại", "Chưa chạy lại sau khi sửa."],
  ["Đạt", "Lỗi đã được sửa và không còn tái hiện."],
  ["Còn lỗi", "Lỗi vẫn tái hiện sau khi sửa."],
  ["Không tái hiện", "Không thể tái hiện lại lỗi trong lần kiểm tra này."],
];
for (const address of ["A3:B3", "D3:E3", "G3:H3"]) {
  lists.getRange(address).format = {
    fill: colors.blue,
    font: { name: "Aptos", bold: true, color: colors.white },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
}
for (const address of ["A4:B8", "D4:E8", "G4:H7"]) {
  lists.getRange(address).format = {
    font: { name: "Aptos", size: 10, color: colors.text },
    wrapText: true,
    verticalAlignment: "top",
    borders: {
      insideHorizontal: { style: "thin", color: colors.border },
      bottom: { style: "thin", color: colors.border },
    },
  };
}
lists.getRange("A4:A8").format.font = { name: "Aptos", bold: true, color: colors.text };
lists.getRange("D4:D8").format.font = { name: "Aptos", bold: true, color: colors.text };
lists.getRange("G4:G7").format.font = { name: "Aptos", bold: true, color: colors.text };
lists.getRange("A:A").format.columnWidth = 19;
lists.getRange("B:B").format.columnWidth = 44;
lists.getRange("C:C").format.columnWidth = 4;
lists.getRange("D:D").format.columnWidth = 19;
lists.getRange("E:E").format.columnWidth = 44;
lists.getRange("F:F").format.columnWidth = 4;
lists.getRange("G:G").format.columnWidth = 22;
lists.getRange("H:H").format.columnWidth = 44;
lists.getRange("A4:H8").format.rowHeight = 34;
lists.freezePanes.freezeRows(3);

// ----- Verification and export -----
const checks = {};
checks.summary = (await workbook.inspect({
  kind: "table",
  range: "Tổng quan!A1:J25",
  include: "values,formulas",
  tableMaxRows: 25,
  tableMaxCols: 10,
  maxChars: 7000,
})).ndjson;
checks.tests = (await workbook.inspect({
  kind: "table",
  range: "Kiểm thử audio!A1:V8",
  include: "values,formulas",
  tableMaxRows: 8,
  tableMaxCols: 22,
  maxChars: 6000,
})).ndjson;
checks.errors = (await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
  maxChars: 3000,
})).ndjson;

for (const [sheetName, fileName, range] of [
  ["Tổng quan", "tong-quan.png", "A1:J25"],
  ["Kiểm thử audio", "kiem-thu-audio.png", "A1:V12"],
  ["Danh mục", "danh-muc.png", "A1:H8"],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1.5, format: "png" });
  await fs.writeFile(path.join(previewDir, fileName), new Uint8Array(await preview.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);
await fs.writeFile(path.join(previewDir, "verification.json"), JSON.stringify(checks, null, 2), "utf8");

console.log(JSON.stringify({ outputPath, previewDir, checks }, null, 2));
