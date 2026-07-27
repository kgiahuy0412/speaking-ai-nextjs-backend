import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let testRoot = "";
let originalWorkingDirectory = "";
let readGeneratedAudioFile: typeof import("./audio").readGeneratedAudioFile;

before(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "ai-speaking-audio-"));
  originalWorkingDirectory = process.cwd();
  process.chdir(testRoot);
  ({ readGeneratedAudioFile } = await import("./audio"));
  await mkdir(path.join(testRoot, "public", "generated-audio"), {
    recursive: true,
  });
  await writeFile(
    path.join(testRoot, "public", "generated-audio", "runtime-cache.mp3"),
    Buffer.from("runtime audio"),
  );
});

after(async () => {
  process.chdir(originalWorkingDirectory);
  await rm(testRoot, { recursive: true, force: true });
});

test("reads audio generated after the application build", async () => {
  assert.equal(
    (await readGeneratedAudioFile("runtime-cache.mp3"))?.toString(),
    "runtime audio",
  );
});

test("returns null for missing or unsafe generated audio paths", async () => {
  assert.equal(await readGeneratedAudioFile("missing.mp3"), null);
  assert.equal(await readGeneratedAudioFile("../outside.mp3"), null);
  assert.equal(await readGeneratedAudioFile("folder/audio.mp3"), null);
});
