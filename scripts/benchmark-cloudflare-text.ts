import { faithfulTranslationGoldenSet } from "../src/lib/ai/faithfulTranslationGoldenSet";
import { buildEnglishInstruction } from "../src/lib/ai/prompts";
import { findMissingTranslationRequirements } from "../src/lib/ai/translationFidelity";
import { translateVietnameseWithCloudflare } from "../src/lib/ai/cloudflareText";

const models = process.argv.slice(2);
if (models.length === 0) {
  models.push(
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "@cf/meta/llama-3.1-8b-instruct-fast",
  );
}

process.env.CLOUDFLARE_TEXT_TIMEOUT_MS ??= "6000";

function normalizeEnglish(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function benchmarkModel(model: string) {
  process.env.CLOUDFLARE_TEXT_MODEL = model;
  const results = new Array(faithfulTranslationGoldenSet.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < faithfulTranslationGoldenSet.length) {
      const index = nextIndex++;
      const testCase = faithfulTranslationGoldenSet[index];
      const startedAt = performance.now();
      try {
        const response = await translateVietnameseWithCloudflare(
          testCase.vietnamese,
          buildEnglishInstruction(testCase.context, 6),
        );
        const englishText = response.englishText.trim();
        const missing = findMissingTranslationRequirements(
          testCase.vietnamese,
          englishText,
        );
        results[index] = {
          id: testCase.id,
          latencyMs: Math.round(performance.now() - startedAt),
          englishText,
          exact:
            normalizeEnglish(englishText) ===
            normalizeEnglish(testCase.expectedEnglish),
          rejected:
            normalizeEnglish(englishText) ===
            normalizeEnglish(testCase.rejectedEnglish),
          missing,
        };
      } catch (error) {
        results[index] = {
          id: testCase.id,
          latencyMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
          exact: false,
          rejected: false,
          missing: ["provider_error"],
        };
      }
    }
  }

  await Promise.all([worker(), worker(), worker()]);
  const latencies = results.map((item) => item.latencyMs as number);
  const errorCount = results.filter((item) => item.error).length;
  const exactCount = results.filter((item) => item.exact).length;
  const unsafeCount = results.filter(
    (item) => item.rejected || item.missing.length > 0,
  ).length;

  return {
    model,
    total: results.length,
    errorCount,
    exactCount,
    exactRate: Number((exactCount / results.length).toFixed(3)),
    unsafeCount,
    safeRate: Number(((results.length - unsafeCount) / results.length).toFixed(3)),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    failures: results.filter(
      (item) => item.error || item.rejected || item.missing.length > 0,
    ),
  };
}

async function main() {
  const reports = [];
  for (const model of models) {
    reports.push(await benchmarkModel(model));
  }

  const baseline = reports[0];
  const recommendations = reports.slice(1).map((candidate) => ({
    model: candidate.model,
    eligible:
      candidate.errorCount === 0 &&
      candidate.safeRate >= baseline.safeRate &&
      candidate.exactRate >= baseline.exactRate - 0.02 &&
      candidate.p50Ms <= baseline.p50Ms * 0.85,
  }));

  console.log(JSON.stringify({ reports, recommendations }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
