import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCloudflareTextTranslationBody,
  CloudflareTextProviderError,
  translateVietnameseWithCloudflare,
} from "./cloudflareText";

test("builds a deterministic faithful-translation request for Cloudflare", () => {
  const body = buildCloudflareTextTranslationBody(
    "@cf/meta/llama-4-scout-17b-16e-instruct",
    "Translate faithfully. English only.",
    "Mẹ ơi, con muốn mua cái này.",
  );

  assert.equal(
    body.model,
    "@cf/meta/llama-4-scout-17b-16e-instruct",
  );
  assert.equal(body.temperature, 0);
  assert.equal(body.max_completion_tokens, 80);
  assert.deepEqual(body.messages, [
    { role: "system", content: "Translate faithfully. English only." },
    { role: "user", content: "Mẹ ơi, con muốn mua cái này." },
  ]);
});

test("parses a successful Cloudflare chat completion", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        { message: { content: "Mom, I want to buy this." } },
      ],
    });

  try {
    const result = await translateVietnameseWithCloudflare(
      "Mẹ ơi, con muốn mua cái này.",
      "Translate faithfully.",
    );
    assert.equal(result.englishText, "Mom, I want to buy this.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    if (originalToken === undefined) {
      delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = originalToken;
    }
  }
});

test("classifies Cloudflare rate limits so the router can fall back", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
  process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = "test-token";
  globalThis.fetch = async () =>
    Response.json({ errors: [{ code: 3036 }] }, { status: 429 });

  try {
    await assert.rejects(
      () =>
        translateVietnameseWithCloudflare(
          "Con muốn uống nước.",
          "Translate faithfully.",
        ),
      (error: unknown) =>
        error instanceof CloudflareTextProviderError &&
        error.reason === "rate_limited" &&
        error.status === 429,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    if (originalToken === undefined) {
      delete process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN = originalToken;
    }
  }
});
