import fs from "node:fs/promises";
import path from "node:path";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const apiToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN?.trim();
const model =
  process.env.CLOUDFLARE_WORKERS_AI_MODEL?.trim() ||
  "@cf/openai/whisper-large-v3-turbo";

if (!accountId || !apiToken) {
  throw new Error("Cloudflare Workers AI is not configured.");
}

const northRoot =
  "C:/Users/DELL/Downloads/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM/MIỀN BẮC";
const centralRoot =
  "C:/Users/DELL/Downloads/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM/MIỀN TRUNG";

const samples = [
  [northRoot, "B-46-G-01", "Câu 6.m4a", "Con thích ăn cơm"],
  [northRoot, "B-46-G-01", "Câu 13.m4a", "Con thấy con mèo"],
  [northRoot, "B-46-G-01", "Câu 17.m4a", "Con muốn uống nước"],
  [northRoot, "B-46-T-02", "Câu 16.m4a", "Mẹ ơi con cần giúp"],
  [northRoot, "B-46-T-02", "Câu 17.m4a", "Con muốn uống nước"],
  [northRoot, "B-46-T-02", "Câu 18.m4a", "Con không hiểu"],
  [centralRoot, "T-1114-G-01", "1.m4a", "Con tên là Bé Mây"],
  [centralRoot, "T-1114-G-01", "9.m4a", "Cô chú nói chậm lại nhé"],
  [centralRoot, "T-1114-G-01", "10.m4a", "Con muốn nghe lại"],
  [centralRoot, "T-1114-G-01", "13.m4a", "Con thấy con mèo"],
  [centralRoot, "T-1114-G-01", "16.m4a", "Mẹ ơi con cần giúp"],
  [centralRoot, "T-1114-G-01", "19.m4a", "Cô chú nói chậm lại nhé"],
].map(([root, group, fileName, expected]) => ({
  group,
  fileName,
  expected,
  filePath: process.env.NORMALIZED_AUDIO_DIR
    ? path.join(
        process.env.NORMALIZED_AUDIO_DIR,
        `${group}-${path.parse(fileName).name}.wav`,
      )
    : path.join(root, group, fileName),
}));

const baseOptions = {
  task: "transcribe",
  language: "vi",
  vad_filter: true,
  condition_on_previous_text: false,
  no_speech_threshold: 0.55,
  compression_ratio_threshold: 2.2,
  log_prob_threshold: -0.8,
};

const variants = [
  { name: "baseline", options: baseOptions },
  {
    name: "tuned_decode",
    options: {
      ...baseOptions,
      beam_size: 10,
      hallucination_silence_threshold: 0.8,
    },
  },
  {
    name: "child_context",
    options: {
      ...baseOptions,
      beam_size: 10,
      hallucination_silence_threshold: 0.8,
      initial_prompt:
        "Trẻ em Việt Nam nói câu ngắn: con, mẹ, bố, cô, chú, bạn, Bé Mây, uống nước, ăn cơm, đi chơi, nghe lại, quả bóng, con mèo.",
    },
  },
  {
    name: "vocabulary_context",
    options: {
      ...baseOptions,
      beam_size: 10,
      hallucination_silence_threshold: 0.8,
      initial_prompt:
        "con; mẹ; bố; cô; chú; bạn; Bé Mây; uống nước; ăn cơm; đi chơi; nghe lại; quả bóng; con mèo",
    },
  },
].filter(
  (variant) =>
    !process.env.BENCHMARK_VARIANT ||
    variant.name === process.env.BENCHMARK_VARIANT,
);

function normalize(text) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("vi")
    .replace(/[.,!?;:'“”\"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

async function transcribe(sample, variant) {
  const startedAt = performance.now();
  const bytes = await fs.readFile(sample.filePath);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: bytes.toString("base64"),
        ...variant.options,
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const payload = await response.json().catch(() => null);
  const actual =
    typeof payload?.result?.text === "string" ? payload.result.text.trim() : "";
  const normalizedExpected = normalize(sample.expected);
  const normalizedActual = normalize(actual);
  const distance = editDistance(normalizedActual, normalizedExpected);
  return {
    variant: variant.name,
    group: sample.group,
    fileName: sample.fileName,
    expected: sample.expected,
    actual,
    exact: normalizedActual === normalizedExpected,
    charErrorRate: Number(
      (distance / Math.max(normalizedExpected.length, 1)).toFixed(4),
    ),
    latencyMs: Math.round(performance.now() - startedAt),
    ok: response.ok && payload?.success !== false && Boolean(actual),
    status: response.status,
  };
}

const jobs = samples.flatMap((sample) =>
  variants.map((variant) => () => transcribe(sample, variant)),
);
const results = [];
const concurrency = 3;
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const jobIndex = cursor;
    cursor += 1;
    try {
      results[jobIndex] = await jobs[jobIndex]();
    } catch (error) {
      results[jobIndex] = { error: error?.message ?? String(error) };
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));

const summary = variants.map((variant) => {
  const rows = results.filter((row) => row.variant === variant.name);
  return {
    variant: variant.name,
    samples: rows.length,
    successful: rows.filter((row) => row.ok).length,
    exact: rows.filter((row) => row.exact).length,
    meanCharErrorRate: Number(
      (
        rows.reduce((sum, row) => sum + row.charErrorRate, 0) /
        Math.max(rows.length, 1)
      ).toFixed(4),
    ),
    meanLatencyMs: Math.round(
      rows.reduce((sum, row) => sum + row.latencyMs, 0) /
        Math.max(rows.length, 1),
    ),
  };
});

console.log(JSON.stringify({ summary, results }, null, 2));
