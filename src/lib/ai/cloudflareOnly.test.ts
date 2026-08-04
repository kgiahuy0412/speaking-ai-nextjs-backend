import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const runtimeFiles = [
  new URL("./asr.ts", import.meta.url),
  new URL("./llm.ts", import.meta.url),
  new URL("./aiProvider.ts", import.meta.url),
  new URL(
    "../../app/api/realtime/transcription-session/route.ts",
    import.meta.url,
  ),
];

test("AI runtime is Cloudflare-only", async () => {
  const sources = await Promise.all(
    runtimeFiles.map((file) => readFile(file, "utf8")),
  );
  const runtimeSource = sources.join("\n");

  assert.doesNotMatch(runtimeSource, /getOpenAIClient/);
  assert.doesNotMatch(runtimeSource, /api\.openai\.com/);
  assert.doesNotMatch(runtimeSource, /OPENAI_API_KEY/);
  assert.doesNotMatch(runtimeSource, /fallbackProvider:\s*["']openai["']/);
});

test("OpenAI SDK is not a direct dependency", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };

  assert.equal(packageJson.dependencies?.openai, undefined);
});
