import assert from "node:assert/strict";
import test from "node:test";
import { getAudioWarmupRuleLimit } from "./audioWarmup";

test("warms the complete reviewed corpus by default", () => {
  const previous = process.env.AUDIO_WARMUP_RULE_LIMIT;
  delete process.env.AUDIO_WARMUP_RULE_LIMIT;
  try {
    assert.equal(getAudioWarmupRuleLimit(), 10_000);
  } finally {
    if (previous === undefined) {
      delete process.env.AUDIO_WARMUP_RULE_LIMIT;
    } else {
      process.env.AUDIO_WARMUP_RULE_LIMIT = previous;
    }
  }
});

test("keeps an explicit smaller warm-up useful for manual batches", () => {
  assert.equal(getAudioWarmupRuleLimit(250), 250);
});

test("caps accidental oversized warm-up requests", () => {
  assert.equal(getAudioWarmupRuleLimit(50_000), 10_000);
});
