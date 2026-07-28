import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let testRoot = "";
let originalWorkingDirectory = "";
let readGeneratedAudioFile: typeof import("./audio").readGeneratedAudioFile;
let getReusableAudioUrl: typeof import("./audio").getReusableAudioUrl;
let getCachedAudio: typeof import("../../app/api/audio/cache/[fileName]/route").GET;
let headCachedAudio: typeof import("../../app/api/audio/cache/[fileName]/route").HEAD;

before(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "ai-speaking-audio-"));
  originalWorkingDirectory = process.cwd();
  process.chdir(testRoot);
  ({ readGeneratedAudioFile, getReusableAudioUrl } = await import("./audio"));
  ({ GET: getCachedAudio, HEAD: headCachedAudio } = await import(
    "../../app/api/audio/cache/[fileName]/route"
  ));
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
  await rm(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
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

test("returns local cached audio through the CORS-enabled API route", async () => {
  assert.equal(
    await getReusableAudioUrl({
      text: "runtime cache",
      model: "test-model",
      voice: "test-voice",
      speed: 1,
      extension: "mp3",
    }),
    null,
  );

  const { getReusableAudioFileName } = await import("./audio");
  const descriptor = {
    text: "runtime cache",
    model: "test-model",
    voice: "test-voice",
    speed: 1,
    extension: "mp3",
  };
  const fileName = getReusableAudioFileName(descriptor);
  await writeFile(
    path.join(testRoot, "public", "generated-audio", fileName),
    Buffer.from("cached speech"),
  );

  assert.equal(
    await getReusableAudioUrl(descriptor),
    `/api/audio/cache/${fileName}`,
  );
});

test("serves cached audio byte ranges required by Safari", async () => {
  const context = {
    params: Promise.resolve({ fileName: "runtime-cache.mp3" }),
  };
  const response = await getCachedAudio(
    new Request("http://localhost/api/audio/cache/runtime-cache.mp3", {
      headers: { Range: "bytes=0-6" },
    }),
    context,
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 0-6/13");
  assert.equal(response.headers.get("content-length"), "7");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "runtime");
});

test("returns 416 for an unsatisfied cached audio range", async () => {
  const context = {
    params: Promise.resolve({ fileName: "runtime-cache.mp3" }),
  };
  const response = await getCachedAudio(
    new Request("http://localhost/api/audio/cache/runtime-cache.mp3", {
      headers: { Range: "bytes=99-100" },
    }),
    context,
  );

  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */13");
});

test("returns cached audio metadata without a body for HEAD", async () => {
  const context = {
    params: Promise.resolve({ fileName: "runtime-cache.mp3" }),
  };
  const response = await headCachedAudio(
    new Request("http://localhost/api/audio/cache/runtime-cache.mp3", {
      method: "HEAD",
    }),
    context,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "13");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});
