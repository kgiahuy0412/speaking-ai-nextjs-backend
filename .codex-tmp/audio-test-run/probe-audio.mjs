import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(
  "D:/Code/HuaMei/App_noi/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM/MIỀN BẮC",
);
const outputPath = path.resolve(
  "D:/Code/HuaMei/App_noi/be/3_23th7/speaking-ai-nextjs-backend/.codex-tmp/audio-test-run/audio-probe-results.json",
);
const supportedExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav", ".webm"]);

async function listFiles(directory = root) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

async function probeFile(filePath) {
  const stat = await fs.stat(filePath);
  const base = {
    relativePath: path.relative(root, filePath),
    absolutePath: filePath,
    bytes: stat.size,
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name,bit_rate:stream=codec_name,codec_type,sample_rate,channels",
        "-of",
        "json",
        filePath,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const data = JSON.parse(stdout);
    const audioStream = (data.streams ?? []).find((stream) => stream.codec_type === "audio") ?? null;
    const durationSeconds = Number(data.format?.duration);
    return {
      ...base,
      valid: Boolean(audioStream) && Number.isFinite(durationSeconds) && durationSeconds > 0,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      formatName: data.format?.format_name ?? null,
      bitRate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
      codec: audioStream?.codec_name ?? null,
      sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
      channels: audioStream?.channels ?? null,
      error: stderr.trim() || null,
    };
  } catch (error) {
    return {
      ...base,
      valid: false,
      durationSeconds: null,
      formatName: null,
      bitRate: null,
      codec: null,
      sampleRate: null,
      channels: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const files = await listFiles();
files.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right), "vi", { numeric: true }));

const concurrency = 8;
const results = new Array(files.length);
let nextIndex = 0;

async function worker() {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= files.length) return;
    results[index] = await probeFile(files[index]);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const validResults = results.filter((item) => item.valid);
const durations = validResults.map((item) => item.durationSeconds).filter(Number.isFinite);
const payload = {
  root,
  generatedAt: new Date().toISOString(),
  summary: {
    total: results.length,
    valid: validResults.length,
    invalid: results.length - validResults.length,
    totalDurationSeconds: durations.reduce((sum, value) => sum + value, 0),
    minDurationSeconds: durations.length ? Math.min(...durations) : null,
    maxDurationSeconds: durations.length ? Math.max(...durations) : null,
    codecs: Object.fromEntries(
      [...new Set(validResults.map((item) => item.codec))].sort().map((codec) => [codec, validResults.filter((item) => item.codec === codec).length]),
    ),
  },
  results,
};

await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, summary: payload.summary }));
