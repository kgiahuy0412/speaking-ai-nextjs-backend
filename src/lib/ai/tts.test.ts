import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let testRoot = "";
let originalWorkingDirectory = "";
let claimEnglishAudioCacheFill:
  typeof import("./tts").claimEnglishAudioCacheFill;
let readGeneratedAudioFile:
  typeof import("../storage/audio").readGeneratedAudioFile;

before(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "ai-speaking-tts-fill-"));
  originalWorkingDirectory = process.cwd();
  process.chdir(testRoot);
  process.env.AUDIO_STORAGE_BACKEND = "local";
  process.env.PERSISTENCE_BACKEND = "local";
  process.env.AI_TTS_PRIMARY_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  ({ claimEnglishAudioCacheFill } = await import("./tts"));
  ({ readGeneratedAudioFile } = await import("../storage/audio"));
});

after(async () => {
  process.chdir(originalWorkingDirectory);
  await rm(testRoot, { recursive: true, force: true });
});

test("cache fill survives cancellation of the client response branch", async () => {
  const text = "This audio is cached even when playback stops.";
  const owner = claimEnglishAudioCacheFill(text);
  const joined = claimEnglishAudioCacheFill(text);

  assert.equal(owner.owner, true);
  assert.equal(joined.owner, false);
  assert.ok(owner.owner);

  const response = new Response(Buffer.from("complete mp3 bytes"), {
    headers: { "content-type": "audio/mpeg" },
  });
  const completion = owner.cacheResponse(
    {
      response,
      source: "openai_tts",
      profile: {
        provider: "openai",
        model: "test-tts-model",
        voice: "test-voice",
        speed: 1,
        extension: "mp3",
      },
    },
    true,
  );

  void response.body?.cancel("client stopped playback");
  const [ownerResult, joinedResult] = await Promise.all([
    completion,
    joined.completion,
  ]);

  assert.equal(ownerResult.audioUrl, joinedResult.audioUrl);
  const fileName = decodeURIComponent(ownerResult.audioUrl.split("/").at(-1)!);
  assert.equal(
    (await readGeneratedAudioFile(fileName))?.toString(),
    "complete mp3 bytes",
  );
});
