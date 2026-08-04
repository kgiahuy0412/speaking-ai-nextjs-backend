export type AudioCheckWorkbookRow = {
  audioPath: string;
  fileName: string;
  evaluation: string;
  errorReason: string;
  processingStatus: string;
  vietnameseText: string;
  englishText: string;
  recognitionMode: string;
  context: string;
  asrMs: number | null;
  totalMs: number | null;
  chunkCount: number | null;
  fileSizeBytes: number;
  technicalError: string;
  conversationId: string;
};

type ZipSource = {
  name: string;
  content: string;
};

type ZipEntry = {
  nameBytes: Uint8Array;
  contentBytes: Uint8Array;
  crc: number;
  offset: number;
};

const encoder = new TextEncoder();
const xlsxMimeType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(
    offset,
    value,
    true,
  );
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(
    offset,
    value >>> 0,
    true,
  );
}

function concatBytes(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function getDosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date:
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  };
}

function createStoredZip(files: ZipSource[]) {
  const now = getDosDateTime(new Date());
  const entries: ZipEntry[] = [];
  const localParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = encoder.encode(file.content);
    const crc = crc32(contentBytes);
    const localHeader = new Uint8Array(30 + nameBytes.byteLength);

    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, now.time);
    writeUint16(localHeader, 12, now.date);
    writeUint32(localHeader, 14, crc);
    writeUint32(localHeader, 18, contentBytes.byteLength);
    writeUint32(localHeader, 22, contentBytes.byteLength);
    writeUint16(localHeader, 26, nameBytes.byteLength);
    writeUint16(localHeader, 28, 0);
    localHeader.set(nameBytes, 30);

    entries.push({ nameBytes, contentBytes, crc, offset: localOffset });
    localParts.push(localHeader, contentBytes);
    localOffset += localHeader.byteLength + contentBytes.byteLength;
  }

  const centralParts: Uint8Array[] = [];
  let centralSize = 0;
  for (const entry of entries) {
    const centralHeader = new Uint8Array(46 + entry.nameBytes.byteLength);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, now.time);
    writeUint16(centralHeader, 14, now.date);
    writeUint32(centralHeader, 16, entry.crc);
    writeUint32(centralHeader, 20, entry.contentBytes.byteLength);
    writeUint32(centralHeader, 24, entry.contentBytes.byteLength);
    writeUint16(centralHeader, 28, entry.nameBytes.byteLength);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, entry.offset);
    centralHeader.set(entry.nameBytes, 46);
    centralParts.push(centralHeader);
    centralSize += centralHeader.byteLength;
  }

  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, 0x06054b50);
  writeUint16(endRecord, 4, 0);
  writeUint16(endRecord, 6, 0);
  writeUint16(endRecord, 8, entries.length);
  writeUint16(endRecord, 10, entries.length);
  writeUint32(endRecord, 12, centralSize);
  writeUint32(endRecord, 16, localOffset);
  writeUint16(endRecord, 20, 0);

  return concatBytes([...localParts, ...centralParts, endRecord]);
}

function escapeXml(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function textCell(reference: string, value: string, style: number) {
  return (
    '<c r="' +
    reference +
    '" s="' +
    style +
    '" t="inlineStr"><is><t xml:space="preserve">' +
    escapeXml(value) +
    "</t></is></c>"
  );
}

function numberCell(reference: string, value: number | null) {
  return value === null
    ? textCell(reference, "", 2)
    : '<c r="' + reference + '" s="3"><v>' + String(value) + "</v></c>";
}

function evaluationStyle(value: string) {
  if (value === "Đúng") return 4;
  if (value === "Lỗi" || value === "Lỗi xử lý") return 5;
  if (value === "Chưa đánh giá") return 6;
  return 7;
}

function buildWorksheet(rows: AudioCheckWorkbookRow[]) {
  const headers = [
    "Đường dẫn audio",
    "Tên file",
    "Đánh giá",
    "Loại lỗi",
    "Trạng thái xử lý",
    "Tiếng Việt nhận diện",
    "Tiếng Anh",
    "Chế độ",
    "Ngữ cảnh",
    "ASR (ms)",
    "Tổng thời gian (ms)",
    "Số chunks",
    "Dung lượng (byte)",
    "Lỗi kỹ thuật",
    "Conversation ID",
  ];
  const widths = [42, 24, 18, 22, 20, 38, 38, 28, 16, 14, 20, 14, 20, 38, 38];
  const headerCells = headers
    .map((header, index) => textCell(columnName(index) + "1", header, 1))
    .join("");
  const dataRows = rows
    .map((row, rowIndex) => {
      const excelRow = rowIndex + 2;
      const textValues = [
        row.audioPath,
        row.fileName,
        row.evaluation,
        row.errorReason,
        row.processingStatus,
        row.vietnameseText,
        row.englishText,
        row.recognitionMode,
        row.context,
      ];
      const leadingCells = textValues
        .map((value, columnIndex) =>
          textCell(
            columnName(columnIndex) + String(excelRow),
            value,
            columnIndex === 2 ? evaluationStyle(row.evaluation) : 2,
          ),
        )
        .join("");
      const numericCells = [
        numberCell("J" + String(excelRow), row.asrMs),
        numberCell("K" + String(excelRow), row.totalMs),
        numberCell("L" + String(excelRow), row.chunkCount),
        numberCell("M" + String(excelRow), row.fileSizeBytes),
      ].join("");
      const trailingCells =
        textCell("N" + String(excelRow), row.technicalError, 2) +
        textCell("O" + String(excelRow), row.conversationId, 2);
      return (
        '<row r="' +
        String(excelRow) +
        '" ht="42" customHeight="1">' +
        leadingCells +
        numericCells +
        trailingCells +
        "</row>"
      );
    })
    .join("");
  const columns = widths
    .map(
      (width, index) =>
        '<col min="' +
        String(index + 1) +
        '" max="' +
        String(index + 1) +
        '" width="' +
        String(width) +
        '" customWidth="1"/>',
    )
    .join("");
  const lastRow = Math.max(1, rows.length + 1);

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    "<cols>" +
    columns +
    "</cols>" +
    '<sheetData><row r="1" ht="28" customHeight="1">' +
    headerCells +
    "</row>" +
    dataRows +
    "</sheetData>" +
    '<autoFilter ref="A1:O' +
    String(lastRow) +
    '"/>' +
    "</worksheet>"
  );
}

const contentTypesXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  "</Types>";

const rootRelationshipsXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const workbookXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Kết quả audio" sheetId="1" r:id="rId1"/></sheets>' +
  "</workbook>";

const workbookRelationshipsXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

const stylesXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2">' +
  '<font><sz val="11"/><color theme="1"/><name val="Aptos"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>' +
  "</fonts>" +
  '<fills count="7">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill>' +
  "</fills>" +
  '<borders count="2">' +
  "<border><left/><right/><top/><bottom/><diagonal/></border>" +
  '<border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>' +
  "</borders>" +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

export function buildAudioCheckWorkbook(rows: AudioCheckWorkbookRow[]) {
  return createStoredZip([
    { name: "[Content_Types].xml", content: contentTypesXml },
    { name: "_rels/.rels", content: rootRelationshipsXml },
    { name: "xl/workbook.xml", content: workbookXml },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: workbookRelationshipsXml,
    },
    { name: "xl/styles.xml", content: stylesXml },
    { name: "xl/worksheets/sheet1.xml", content: buildWorksheet(rows) },
  ]);
}

export function downloadAudioCheckWorkbook(
  rows: AudioCheckWorkbookRow[],
  fileName: string,
) {
  const bytes = buildAudioCheckWorkbook(rows);
  const blob = new Blob([bytes], { type: xlsxMimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
