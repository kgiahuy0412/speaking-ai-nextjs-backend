import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppError } from "@/lib/appError";
import {
  generateAiText,
  getConfiguredTtsProfile,
  getTextAiProfile,
  requestEnglishSpeech,
  transcribeVietnameseAudio,
} from "./aiProvider";

const originalFetch = globalThis.fetch;
const environmentKeys = [
  "OPENAI_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_WORKERS_AI_API_TOKEN",
  "CLOUDFLARE_ASR_MODEL",
  "CLOUDFLARE_TEXT_MODEL",
  "CLOUDFLARE_TTS_MODEL",
  "CLOUDFLARE_TTS_SPEAKER",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);

function restoreEnvironment() {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function configureCloudflare() {
  delete process.env.OPENAI_API_KEY;
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
}

afterEach(() => {
  restoreEnvironment();
  globalThis.fetch = originalFetch;
});

test("selects Cloudflare profiles when OpenAI is not configured", () => {
  configureCloudflare();

  assert.deepEqual(getTextAiProfile(), {
    provider: "cloudflare",
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
  });
  assert.deepEqual(getConfiguredTtsProfile(), {
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    voice: "luna",
    speed: 1,
    extension: "mp3",
  });
});

test("generates text through the Cloudflare OpenAI-compatible endpoint", async () => {
  configureCloudflare();
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions",
    );
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    assert.equal(body.model, "@cf/qwen/qwen3-30b-a3b-fp8");
    assert.match(body.messages[0].content, /^\/no_think/);

    return Response.json({
      choices: [{ message: { content: "I am thirsty." } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
  };

  const result = await generateAiText({
    instructions: "Translate naturally.",
    input: "Con khát nước.",
    maxOutputTokens: 64,
    timeoutMs: 5_000,
  });

  assert.deepEqual(result, {
    text: "I am thirsty.",
    provider: "cloudflare",
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    inputTokens: 10,
    outputTokens: 4,
  });
});

test("transcribes Vietnamese audio through Cloudflare Whisper", async () => {
  configureCloudflare();
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/openai/whisper-large-v3-turbo",
    );
    const body = JSON.parse(String(init?.body)) as {
      task: string;
      language: string;
      audio: string;
    };
    assert.equal(body.task, "transcribe");
    assert.equal(body.language, "vi");
    assert.equal(body.audio, Buffer.from("audio-bytes").toString("base64"));

    return Response.json({ result: { text: "Con khát nước." } });
  };

  const result = await transcribeVietnameseAudio(
    new File(["audio-bytes"], "speech.wav", { type: "audio/wav" }),
  );

  assert.deepEqual(result, {
    text: "Con khát nước.",
    provider: "cloudflare",
    model: "@cf/openai/whisper-large-v3-turbo",
  });
});

test("requests MP3 speech from Cloudflare", async () => {
  configureCloudflare();
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/deepgram/aura-1",
    );
    const body = JSON.parse(String(init?.body)) as {
      text: string;
      speaker: string;
      encoding: string;
    };
    assert.deepEqual(body, {
      text: "I am thirsty.",
      speaker: "luna",
      encoding: "mp3",
    });

    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "audio/mpeg" },
    });
  };

  const speech = await requestEnglishSpeech(
    "I am thirsty.",
    getConfiguredTtsProfile(),
  );

  assert.equal(speech.source, "cloudflare_tts");
  assert.deepEqual(
    new Uint8Array(await speech.response.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );
});

test("returns a clear configuration error when no AI provider exists", async () => {
  for (const key of environmentKeys) {
    delete process.env[key];
  }

  await assert.rejects(
    () =>
      generateAiText({
        instructions: "Translate naturally.",
        input: "Con khát nước.",
        maxOutputTokens: 64,
        timeoutMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "LLM_FAILED" &&
      error.status === 503,
  );
});
