import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let testRoot = "";
let originalWorkingDirectory = "";
let originalDatabaseUrl: string | undefined;
let getCachedAiEnglishText: typeof import("./textCache").getCachedAiEnglishText;
let removeAiEnglishText: typeof import("./textCache").removeAiEnglishText;
let saveAiEnglishText: typeof import("./textCache").saveAiEnglishText;

before(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "ai-speaking-text-cache-"));
  originalWorkingDirectory = process.cwd();
  originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.chdir(testRoot);
  ({
    getCachedAiEnglishText,
    removeAiEnglishText,
    saveAiEnglishText,
  } = await import("./textCache"));
});

after(async () => {
  process.chdir(originalWorkingDirectory);
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  await rm(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("AI text cache is shared across client devices", async () => {
  await saveAiEnglishText(
    "Con muốn đi sở thú.",
    "outside",
    6,
    "I want to go to the zoo.",
    "device-a",
    {
      textProvider: "cloudflare",
      textModel: "test-model",
    },
  );

  const fromAnotherDevice = await getCachedAiEnglishText(
    "CON MUỐN ĐI SỞ THÚ!",
    "outside",
    6,
    "device-b",
  );
  assert.equal(fromAnotherDevice?.englishText, "I want to go to the zoo.");
  assert.equal(fromAnotherDevice?.textProvider, "cloudflare");

  const stored = JSON.parse(
    await readFile(path.join(testRoot, "data", "ai-text-cache.json"), "utf8"),
  ) as Record<string, { clientId?: string }>;
  assert.equal(Object.keys(stored).length, 1);
  assert.equal(Object.values(stored)[0]?.clientId, undefined);
});

test("removing a rejected translation invalidates the shared entry", async () => {
  await saveAiEnglishText(
    "Con muốn đi sở thú.",
    "outside",
    6,
    "I want to go to the zoo.",
    "device-a",
  );
  assert.equal(
    await removeAiEnglishText("Con muốn đi sở thú.", "outside", "device-b"),
    1,
  );
  assert.equal(
    await getCachedAiEnglishText(
      "Con muốn đi sở thú.",
      "outside",
      6,
      "device-a",
    ),
    null,
  );
});
