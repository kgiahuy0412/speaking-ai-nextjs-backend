import { createHash } from "node:crypto";
import type { PracticeContext } from "@/types/conversation";
import { semanticIntentRules } from "./semanticIntents";
import { getEnglishAudioStreamUrl } from "./tts";
import { reviewedExactRulesV1 } from "./exactRules";

const contexts: PracticeContext[] = ["home", "school", "outside"];

export const offlineIntentPolicy = {
  confidenceThreshold: 0.88,
  marginThreshold: 0.15,
  stableUpdates: 3,
  earlyFallbackMs: 800,
} as const;

export type OfflineIntentManifestItem = {
  id: string;
  contexts: PracticeContext[];
  samples: string[];
  englishText: string;
  audioUrl: string;
};

type MutableIntent = {
  id: string;
  contexts: Set<PracticeContext>;
  samples: Set<string>;
  englishText: string;
};

function collectOfflineIntents() {
  const intents = new Map<string, MutableIntent>();

  for (const rule of reviewedExactRulesV1) {
    intents.set(`exact-${rule.id}`, {
      id: `exact-${rule.id}`,
      contexts: new Set(contexts),
      samples: new Set([rule.vietnamese]),
      englishText: rule.english,
    });
  }

  for (const context of contexts) {
    for (const rule of semanticIntentRules[context]) {
      const existing = intents.get(rule.intent);

      if (existing && existing.englishText !== rule.english) {
        continue;
      }

      const intent =
        existing ??
        {
          id: rule.intent,
          contexts: new Set<PracticeContext>(),
          samples: new Set<string>(),
          englishText: rule.english,
        };
      intent.contexts.add(context);
      rule.samples.forEach((sample) => intent.samples.add(sample));
      intents.set(rule.intent, intent);
    }
  }

  return [...intents.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export async function getOfflineIntentManifest(limit = 40) {
  const safeLimit = Math.min(500, Math.max(30, Math.round(limit)));
  const selected = collectOfflineIntents().slice(0, safeLimit);
  const items: OfflineIntentManifestItem[] = selected.map((intent) => ({
    id: intent.id,
    contexts: contexts.filter((context) => intent.contexts.has(context)),
    samples: [...intent.samples].sort((left, right) =>
      left.localeCompare(right),
    ),
    englishText: intent.englishText,
    audioUrl: getEnglishAudioStreamUrl(intent.englishText),
  }));
  const version = createHash("sha256")
    .update(JSON.stringify({ items, policy: offlineIntentPolicy }))
    .digest("hex")
    .slice(0, 16);

  return {
    version,
    sampleRate: 24_000,
    policy: offlineIntentPolicy,
    items,
  };
}
