import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  deleteAudioSessionChunkObjects,
  getAudioSessionChunkObjectKey,
  putAudioSessionChunkObject,
  readAudioSessionChunkObject,
} from "./audioSessionR2";

const r2EnvironmentNames = [
  "CLOUDFLARE_R2_ACCOUNT_ID",
  "CLOUDFLARE_R2_ACCESS_KEY_ID",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_R2_BUCKET",
] as const;
const originalR2Environment = Object.fromEntries(
  r2EnvironmentNames.map((name) => [name, process.env[name]]),
);

before(() => {
  process.env.CLOUDFLARE_R2_ACCOUNT_ID = "account";
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "access";
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "secret";
  process.env.CLOUDFLARE_R2_BUCKET = "bucket";
});

after(() => {
  for (const name of r2EnvironmentNames) {
    const original = originalR2Environment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  delete (
    globalThis as typeof globalThis & { __aiSpeakingR2Client?: S3Client }
  ).__aiSpeakingR2Client;
});

test("R2 chunk keys isolate sessions and preserve sequence order", () => {
  const first = getAudioSessionChunkObjectKey(
    "audio_v2-r2-session-a",
    2,
    "a".repeat(64),
  );
  const later = getAudioSessionChunkObjectKey(
    "audio_v2-r2-session-a",
    12,
    "b".repeat(64),
  );

  assert.equal(
    first,
    `audio-sessions/audio_v2-r2-session-a/chunks/000002-${"a".repeat(64)}.part`,
  );
  assert.ok(first.localeCompare(later) < 0);
  assert.ok(!first.includes(".."));
});

test("R2 session chunks are private, readable and deleted in batches", async () => {
  const commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  const fakeClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      commands.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: {
            transformToByteArray: async () => Uint8Array.from([1, 2, 3]),
          },
        };
      }
      return {};
    },
  };
  (
    globalThis as typeof globalThis & { __aiSpeakingR2Client?: S3Client }
  ).__aiSpeakingR2Client = fakeClient as unknown as S3Client;

  const stored = await putAudioSessionChunkObject(
    "audio_v2-r2-test",
    0,
    "c".repeat(64),
    Buffer.from([1, 2, 3]),
  );
  const bytes = await readAudioSessionChunkObject(stored.key);
  await deleteAudioSessionChunkObjects([stored.key, stored.key]);

  assert.equal(stored.created, true);
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.deepEqual(
    commands.map((command) => command.name),
    ["PutObjectCommand", "GetObjectCommand", "DeleteObjectsCommand"],
  );
  assert.equal(commands[0].input.CacheControl, "private, no-store");
  assert.equal(commands[0].input.IfNoneMatch, "*");
  assert.deepEqual(commands[2].input.Delete, {
    Quiet: true,
    Objects: [{ Key: stored.key }],
  });
});
