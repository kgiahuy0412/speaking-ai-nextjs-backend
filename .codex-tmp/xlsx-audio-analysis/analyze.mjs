import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/DELL/Downloads/tong_hop_check_am_thanh_tieu_chuan.xlsx";
const outputDir = path.resolve(".codex-tmp/xlsx-audio-analysis/previews");

await fs.mkdir(outputDir, { recursive: true });
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const overview = await workbook.inspect({
  kind: "workbook,sheet,table,drawing",
  maxChars: 12000,
  tableMaxRows: 8,
  tableMaxCols: 12,
  tableMaxCellChars: 120,
});

const sheets = workbook.worksheets.items;
const details = [];
for (let index = 0; index < sheets.length; index += 1) {
  const sheet = sheets[index];
  const used = sheet.getUsedRange();
  const usedAddress = used?.address ?? null;
  const region = usedAddress
    ? await workbook.inspect({
        kind: "region",
        sheetId: sheet.name,
        range: usedAddress,
        maxChars: 30000,
        tableMaxRows: 120,
        tableMaxCols: 30,
        tableMaxCellChars: 220,
      })
    : null;
  const formulas = usedAddress
    ? await workbook.inspect({
        kind: "formula",
        sheetId: sheet.name,
        range: usedAddress,
        maxChars: 5000,
        options: { maxResults: 100 },
      })
    : null;

  let previewPath = null;
  try {
    const preview = await workbook.render({
      sheetName: sheet.name,
      autoCrop: "all",
      scale: 1.5,
      format: "png",
    });
    previewPath = path.join(outputDir, `sheet-${String(index + 1).padStart(2, "0")}.png`);
    await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
  } catch (error) {
    previewPath = `RENDER_ERROR: ${error?.message ?? String(error)}`;
  }

  details.push({
    index,
    name: sheet.name,
    usedAddress,
    region: region?.ndjson ?? null,
    formulas: formulas?.ndjson ?? null,
    previewPath,
  });
}

console.log(JSON.stringify({ overview: overview.ndjson, details }, null, 2));
