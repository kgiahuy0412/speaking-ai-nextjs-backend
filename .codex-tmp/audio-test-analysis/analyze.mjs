import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const workbookPath = "D:/tong_hop_check_am_thanh_tieu_chuan.xlsx";
const input = await FileBlob.load(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const sheets = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 4000,
});
console.log("=== SHEETS ===");
console.log(sheets.ndjson);

const overview = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 12000,
  tableMaxRows: 20,
  tableMaxCols: 20,
  tableMaxCellChars: 200,
});
console.log("=== OVERVIEW ===");
console.log(overview.ndjson);

const sheet = workbook.worksheets.getItem("Dữ liệu tổng hợp");
const values = sheet.getUsedRange(true).values;
const headers = values[0].map((value) => String(value ?? "").trim());
const rows = values.slice(1).map((row, index) => {
  const item = { __row: index + 2 };
  headers.forEach((header, columnIndex) => {
    item[header] = row[columnIndex] ?? null;
  });
  return item;
});

function textValue(value) {
  return String(value ?? "").trim();
}

function compactVietnamese(value) {
  return textValue(value)
    .normalize("NFKC")
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function percentile(numbers, ratio) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function summarize(groupRows) {
  const correctRows = groupRows.filter((row) => textValue(row["Đánh giá"]) === "Đúng");
  const errors = groupRows.filter((row) => textValue(row["Đánh giá"]) === "Lỗi");
  const unreviewed = groupRows.filter((row) => textValue(row["Đánh giá"]) === "Chưa đánh giá");
  const processingErrors = groupRows.filter((row) => textValue(row["Đánh giá"]) === "Lỗi xử lý");
  const asr = groupRows.map((row) => Number(row["ASR (ms)"])).filter(Number.isFinite);
  const totalTime = groupRows.map((row) => Number(row["Tổng thời gian (ms)"])).filter(Number.isFinite);
  const bytes = groupRows.map((row) => Number(row["Dung lượng (byte)"])).filter(Number.isFinite);
  const errorTypes = {};
  for (const row of errors) {
    const key = textValue(row["Loại lỗi"]) || "Không phân loại";
    errorTypes[key] = (errorTypes[key] ?? 0) + 1;
  }
  return {
    total: groupRows.length,
    correct: correctRows.length,
    errors: errors.length,
    unreviewed: unreviewed.length,
    processingErrors: processingErrors.length,
    reviewedAccuracy: Number((correctRows.length / Math.max(1, correctRows.length + errors.length)).toFixed(4)),
    reviewedErrorRate: Number((errors.length / Math.max(1, correctRows.length + errors.length)).toFixed(4)),
    endToEndPassRate: Number((correctRows.length / Math.max(1, groupRows.length)).toFixed(4)),
    errorTypes,
    technicalFailures: groupRows.filter((row) => textValue(row["Lỗi kỹ thuật"])).length,
    averageAsrMs: asr.length ? Math.round(asr.reduce((a, b) => a + b, 0) / asr.length) : null,
    p95AsrMs: percentile(asr, 0.95),
    averageTotalMs: totalTime.length ? Math.round(totalTime.reduce((a, b) => a + b, 0) / totalTime.length) : null,
    averageBytes: bytes.length ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length) : null,
  };
}

function groupedBy(keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

const sourceGroups = groupedBy((row) => textValue(row["Tệp nguồn"]));
const fileGroups = groupedBy((row) => textValue(row["Tên file"]));
function promptNumber(row) {
  const raw = textValue(row["Tên file"])
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const match = raw.match(/(?:cau\s*)?0?(20|1[0-9]|[1-9])(?!\d)/);
  return match ? Number(match[1]) : null;
}
const promptGroups = groupedBy((row) => promptNumber(row) ?? "unknown");
const regionGroups = groupedBy((row) => {
  const source = textValue(row["Tệp nguồn"]).toLocaleUpperCase("vi");
  if (source.includes("MIỀN BẮC")) return "Miền Bắc";
  if (source.includes("MIỀN TRUNG")) return "Miền Trung";
  if (source.includes("MIỀN NAM")) return "Miền Nam";
  return "Không xác định";
});

const sourceSummary = [...sourceGroups.entries()]
  .map(([source, groupRows]) => ({ source, ...summarize(groupRows) }))
  .sort((a, b) => b.reviewedErrorRate - a.reviewedErrorRate || b.errors - a.errors || a.source.localeCompare(b.source, "vi"));

const fileSummary = [...fileGroups.entries()]
  .map(([file, groupRows]) => {
    const correctRows = groupRows.filter((row) => textValue(row["Đánh giá"]) !== "Lỗi");
    const transcriptCounts = new Map();
    for (const row of correctRows) {
      const raw = textValue(row["Tiếng Việt nhận diện"]);
      const normalized = compactVietnamese(raw);
      if (!normalized) continue;
      const current = transcriptCounts.get(normalized) ?? { count: 0, example: raw };
      current.count += 1;
      transcriptCounts.set(normalized, current);
    }
    const topTranscripts = [...transcriptCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    return { file, ...summarize(groupRows), likelyExpectedTranscript: topTranscripts[0]?.example ?? null, topCorrectTranscripts: topTranscripts };
  })
  .sort((a, b) => b.reviewedErrorRate - a.reviewedErrorRate || Number.parseInt(a.file) - Number.parseInt(b.file));

const regionSummary = [...regionGroups.entries()]
  .map(([region, groupRows]) => ({ region, ...summarize(groupRows) }))
  .sort((a, b) => b.reviewedErrorRate - a.reviewedErrorRate);

const ageGroups = groupedBy((row) => {
  const source = textValue(row["Tệp nguồn"]);
  return source.match(/[BTN]-(46|710|1114)-[GT]-\d+/i)?.[1] ?? "unknown";
});
const byAgeCode = [...ageGroups.entries()]
  .map(([ageCode, groupRows]) => ({ ageCode, ...summarize(groupRows) }))
  .sort((a, b) => b.reviewedErrorRate - a.reviewedErrorRate);

const speakerCodeGroups = groupedBy((row) => {
  const source = textValue(row["Tệp nguồn"]);
  return source.match(/[BTN]-(?:46|710|1114)-([GT])-\d+/i)?.[1]?.toUpperCase() ?? "unknown";
});
const bySpeakerCode = [...speakerCodeGroups.entries()]
  .map(([speakerCode, groupRows]) => ({ speakerCode, ...summarize(groupRows) }))
  .sort((a, b) => b.reviewedErrorRate - a.reviewedErrorRate);

const promptSummary = [...promptGroups.entries()]
  .map(([prompt, groupRows]) => {
    const correctGroupRows = groupRows.filter((row) => textValue(row["Đánh giá"]) === "Đúng");
    const transcriptCounts = new Map();
    for (const row of correctGroupRows) {
      const raw = textValue(row["Tiếng Việt nhận diện"]);
      const normalized = compactVietnamese(raw);
      if (!normalized) continue;
      const current = transcriptCounts.get(normalized) ?? { count: 0, example: raw };
      current.count += 1;
      transcriptCounts.set(normalized, current);
    }
    const topCorrectTranscripts = [...transcriptCounts.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    return {
      prompt,
      ...summarize(groupRows),
      likelyExpectedTranscript: topCorrectTranscripts[0]?.example ?? null,
      topCorrectTranscripts,
    };
  })
  .sort((a, b) => b.reviewedErrorRate - a.reviewedErrorRate || Number(a.prompt) - Number(b.prompt));

const expectedByFile = new Map(fileSummary.map((item) => [item.file, item.likelyExpectedTranscript]));
const expectedByPrompt = new Map(promptSummary.map((item) => [item.prompt, item.likelyExpectedTranscript]));

const hallucinationPattern = /(?:subscribe.*k[eê]nh|lala\s*school|kh[oô]ng b[oỏ] l[oỡ].*video|c[aả]m [oơ]n c[aá]c b[aạ]n [dđ][aã] theo d[oõ]i|h[eẹ]n g[aặ]p l[aạ]i.*(?:c[aá]c b[aạ]n|video)|video ti[eế]p theo)/iu;
const knownHallucinationRows = rows.filter((row) => hallucinationPattern.test(textValue(row["Tiếng Việt nhận diện"])));
const technicalErrorRows = rows
  .filter((row) => textValue(row["Đánh giá"]) === "Lỗi xử lý" || textValue(row["Lỗi kỹ thuật"]))
  .map((row) => ({
    row: row.__row,
    source: row["Tệp nguồn"],
    audioPath: row["Đường dẫn audio"],
    file: row["Tên file"],
    status: row["Trạng thái xử lý"],
    technicalError: row["Lỗi kỹ thuật"],
  }));
const errorRows = rows
  .filter((row) => textValue(row["Đánh giá"]) === "Lỗi")
  .map((row) => ({
    row: row.__row,
    source: row["Tệp nguồn"],
    audioPath: row["Đường dẫn audio"],
    file: row["Tên file"],
    prompt: promptNumber(row),
    likelyExpectedTranscript: expectedByPrompt.get(promptNumber(row)) ?? expectedByFile.get(textValue(row["Tên file"])) ?? null,
    recognizedVietnamese: row["Tiếng Việt nhận diện"],
    generatedEnglish: row["Tiếng Anh"],
    errorType: row["Loại lỗi"],
    processingStatus: row["Trạng thái xử lý"],
    asrMs: row["ASR (ms)"],
    totalMs: row["Tổng thời gian (ms)"],
    bytes: row["Dung lượng (byte)"],
    technicalError: row["Lỗi kỹ thuật"],
  }));

const correctRows = rows.filter((row) => textValue(row["Đánh giá"]) === "Đúng");
const failedRows = rows.filter((row) => textValue(row["Đánh giá"]) === "Lỗi");
const analysis = {
  overall: summarize(rows),
  evaluationCounts: Object.fromEntries([...groupedBy((row) => textValue(row["Đánh giá"]) || "Trống").entries()].map(([key, groupRows]) => [key, groupRows.length])),
  statusCounts: Object.fromEntries([...groupedBy((row) => textValue(row["Trạng thái xử lý"]) || "Trống").entries()].map(([key, groupRows]) => [key, groupRows.length])),
  errorTypeCounts: Object.fromEntries([...groupedBy((row) => textValue(row["Loại lỗi"]) || "Không lỗi").entries()].map(([key, groupRows]) => [key, groupRows.length])),
  correctVsError: {
    correct: summarize(correctRows),
    error: summarize(failedRows),
  },
  byRegion: regionSummary,
  byAgeCode,
  bySpeakerCode,
  bySource: sourceSummary,
  byPromptFile: fileSummary,
  byPromptNumber: promptSummary,
  knownHallucinations: {
    count: knownHallucinationRows.length,
    errorCount: knownHallucinationRows.filter((row) => textValue(row["Đánh giá"]) === "Lỗi").length,
    nonErrorExamples: knownHallucinationRows
      .filter((row) => textValue(row["Đánh giá"]) !== "Lỗi")
      .map((row) => ({ row: row.__row, evaluation: row["Đánh giá"], source: row["Tệp nguồn"], audioPath: row["Đường dẫn audio"], transcript: row["Tiếng Việt nhận diện"] })),
    byPrompt: Object.fromEntries([...new Map([...groupedBy((row) => promptNumber(row) ?? "unknown").entries()].map(([key, groupRows]) => [key, groupRows.filter((row) => hallucinationPattern.test(textValue(row["Tiếng Việt nhận diện"]))).length])).entries()].filter(([, count]) => count > 0)),
  },
  technicalErrorRows,
  errorRows,
};

console.log("=== ANALYSIS ===");
await fs.writeFile("analysis.json", JSON.stringify(analysis, null, 2), "utf8");
console.log(JSON.stringify({
  overall: analysis.overall,
  evaluationCounts: analysis.evaluationCounts,
  statusCounts: analysis.statusCounts,
  errorTypeCounts: analysis.errorTypeCounts,
  correctVsError: analysis.correctVsError,
  byRegion: analysis.byRegion,
  byAgeCode: analysis.byAgeCode,
  bySpeakerCode: analysis.bySpeakerCode,
  worstSources: analysis.bySource.slice(0, 12),
  byPromptNumber: analysis.byPromptNumber,
  knownHallucinations: analysis.knownHallucinations,
  technicalErrorRows: analysis.technicalErrorRows,
}, null, 2));

const preview = await workbook.render({
  sheetName: "Dữ liệu tổng hợp",
  range: "A1:P35",
  scale: 1,
  format: "png",
});
await fs.writeFile("preview.png", new Uint8Array(await preview.arrayBuffer()));

if (process.argv.includes("--audio")) {
  const execFileAsync = promisify(execFile);
  const ffmpeg = "C:/Users/DELL/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe";
  const audioRoot = "D:/Code/HuaMei/App_noi/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM";
  const work = rows.map((row) => {
    const source = textValue(row["Tệp nguồn"]).toLocaleUpperCase("vi");
    const region = source.includes("MIỀN BẮC")
      ? "MIỀN BẮC"
      : source.includes("MIỀN TRUNG")
        ? "MIỀN TRUNG"
        : source.includes("MIỀN NAM")
          ? "MIỀN NAM"
          : null;
    return { row, region, audioPath: region ? path.join(audioRoot, region, textValue(row["Đường dẫn audio"])) : null };
  });

  async function probe(item) {
    if (!item.audioPath) return { row: item.row.__row, error: "missing_region" };
    try {
      const { stderr } = await execFileAsync(ffmpeg, [
        "-hide_banner",
        "-nostats",
        "-i",
        item.audioPath,
        "-af",
        "silencedetect=noise=-45dB:d=0.15,volumedetect",
        "-f",
        "null",
        "NUL",
      ], { maxBuffer: 1024 * 1024 });
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const durationSeconds = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : null;
      const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      const maxMatch = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
      const silenceDurations = [...stderr.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
      const silenceSeconds = silenceDurations.reduce((sum, value) => sum + value, 0);
      return {
        row: item.row.__row,
        evaluation: textValue(item.row["Đánh giá"]),
        source: textValue(item.row["Tệp nguồn"]),
        prompt: promptNumber(item.row),
        durationSeconds,
        meanDb: meanMatch ? Number(meanMatch[1]) : null,
        peakDb: maxMatch ? Number(maxMatch[1]) : null,
        silenceSeconds: Number(silenceSeconds.toFixed(3)),
        silenceRatio: durationSeconds ? Number(Math.min(1, silenceSeconds / durationSeconds).toFixed(4)) : null,
        error: null,
      };
    } catch (error) {
      return { row: item.row.__row, source: textValue(item.row["Tệp nguồn"]), error: error.message };
    }
  }

  const audioResults = new Array(work.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < work.length) {
      const index = nextIndex++;
      audioResults[index] = await probe(work[index]);
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => worker()));

  function acousticSummary(items) {
    const valid = items.filter((item) => !item.error && Number.isFinite(item.meanDb));
    const average = (key) => valid.length
      ? Number((valid.reduce((sum, item) => sum + item[key], 0) / valid.length).toFixed(3))
      : null;
    const sortedMean = valid.map((item) => item.meanDb).sort((a, b) => a - b);
    return {
      total: items.length,
      valid: valid.length,
      failed: items.length - valid.length,
      averageDurationSeconds: average("durationSeconds"),
      averageMeanDb: average("meanDb"),
      medianMeanDb: sortedMean.length ? sortedMean[Math.floor(sortedMean.length / 2)] : null,
      averagePeakDb: average("peakDb"),
      averageSilenceRatio: average("silenceRatio"),
    };
  }

  const groupAudio = (keyFn) => {
    const groups = new Map();
    for (const item of audioResults) {
      const key = keyFn(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return Object.fromEntries([...groups.entries()].map(([key, items]) => [key, acousticSummary(items)]));
  };
  function pearson(pairs) {
    const valid = pairs.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (valid.length < 2) return null;
    const meanX = valid.reduce((sum, [x]) => sum + x, 0) / valid.length;
    const meanY = valid.reduce((sum, [, y]) => sum + y, 0) / valid.length;
    let numerator = 0;
    let denominatorX = 0;
    let denominatorY = 0;
    for (const [x, y] of valid) {
      numerator += (x - meanX) * (y - meanY);
      denominatorX += (x - meanX) ** 2;
      denominatorY += (y - meanY) ** 2;
    }
    return Number((numerator / Math.sqrt(denominatorX * denominatorY)).toFixed(4));
  }
  const volumeBand = (item) => item.meanDb <= -32 ? "<= -32 dB" : item.meanDb <= -28 ? "-32 đến -28 dB" : item.meanDb <= -24 ? "-28 đến -24 dB" : "> -24 dB";
  const reviewedAudio = audioResults.filter((item) => item.evaluation === "Đúng" || item.evaluation === "Lỗi");
  const volumeBandQuality = Object.fromEntries([...new Set(reviewedAudio.map(volumeBand))].map((band) => {
    const items = reviewedAudio.filter((item) => volumeBand(item) === band);
    const correct = items.filter((item) => item.evaluation === "Đúng").length;
    const errors = items.filter((item) => item.evaluation === "Lỗi").length;
    return [band, { total: items.length, correct, errors, reviewedAccuracy: Number((correct / Math.max(1, correct + errors)).toFixed(4)), ...acousticSummary(items) }];
  }));
  const sourceAcousticQuality = sourceSummary.map((quality) => ({
    ...quality,
    ...acousticSummary(audioResults.filter((item) => item.source === quality.source)),
  }));
  const acousticAnalysis = {
    overall: acousticSummary(audioResults),
    byEvaluation: groupAudio((item) => item.evaluation || "unknown"),
    byAgeCode: groupAudio((item) => item.source?.match(/[BTN]-(46|710|1114)-[GT]-\d+/i)?.[1] ?? "unknown"),
    byRegion: groupAudio((item) => item.source?.includes("MIỀN BẮC") ? "Miền Bắc" : item.source?.includes("MIỀN TRUNG") ? "Miền Trung" : item.source?.includes("MIỀN NAM") ? "Miền Nam" : "unknown"),
    volumeBandQuality,
    correlations: {
      rowMeanDbVsError: pearson(reviewedAudio.map((item) => [item.meanDb, item.evaluation === "Lỗi" ? 1 : 0])),
      sourceMeanDbVsReviewedErrorRate: pearson(sourceAcousticQuality.map((item) => [item.averageMeanDb, item.reviewedErrorRate])),
      sourceSilenceRatioVsReviewedErrorRate: pearson(sourceAcousticQuality.map((item) => [item.averageSilenceRatio, item.reviewedErrorRate])),
    },
    quietestSources: [...new Set(audioResults.map((item) => item.source).filter(Boolean))]
      .map((source) => ({ source, ...acousticSummary(audioResults.filter((item) => item.source === source)) }))
      .sort((a, b) => a.averageMeanDb - b.averageMeanDb)
      .slice(0, 12),
    results: audioResults,
  };
  await fs.writeFile("acoustic-analysis.json", JSON.stringify(acousticAnalysis, null, 2), "utf8");
  console.log("=== ACOUSTIC ANALYSIS ===");
  console.log(JSON.stringify({
    overall: acousticAnalysis.overall,
    byEvaluation: acousticAnalysis.byEvaluation,
    byAgeCode: acousticAnalysis.byAgeCode,
    byRegion: acousticAnalysis.byRegion,
    volumeBandQuality: acousticAnalysis.volumeBandQuality,
    correlations: acousticAnalysis.correlations,
    quietestSources: acousticAnalysis.quietestSources,
  }, null, 2));
}
