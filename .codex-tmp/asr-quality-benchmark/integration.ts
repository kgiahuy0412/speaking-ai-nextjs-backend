import fs from "node:fs/promises";
import path from "node:path";
import { transcribeVietnamese } from "../../src/lib/ai/asr";

const roots = {
  north:
    "C:/Users/DELL/Downloads/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM/MIỀN BẮC",
  central:
    "C:/Users/DELL/Downloads/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM/MIỀN TRUNG",
};

const samples = [
  [roots.north, "B-46-G-01", "Câu 6.m4a"],
  [roots.north, "B-46-G-01", "Câu 13.m4a"],
  [roots.north, "B-46-T-02", "Câu 18.m4a"],
  [roots.central, "T-1114-G-01", "10.m4a"],
] as const;

async function main() {
  const results = [];
  for (const [root, group, fileName] of samples) {
  const filePath = path.join(root, group, fileName);
  const bytes = await fs.readFile(filePath);
  const audioFile = new File([bytes], fileName, { type: "audio/mp4" });
  const startedAt = performance.now();

    try {
      const transcript = await transcribeVietnamese({
      requestId: `benchmark-${group}-${fileName}`,
      context: "home",
      childAge: 6,
      targetLanguage: "en",
      audioFile,
      asrMode: "batch_chunks",
    });
      results.push({
        group,
        fileName,
        transcript,
        latencyMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      results.push({
        group,
        fileName,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
        latencyMs: Math.round(performance.now() - startedAt),
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

void main();
