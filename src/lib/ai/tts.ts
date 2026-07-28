import { getReusableAudioUrl, saveReusableAudio } from "@/lib/storage/audio";
import type { AudioSource } from "@/types/conversation";
import {
  getConfiguredTtsProfile,
  getTtsFallbackProfile,
  requestEnglishSpeech,
  type TtsProfile,
} from "./aiProvider";

export type AudioSynthesisResult = {
  audioUrl: string;
  source: AudioSource;
};

const inFlightSynthesis = new Map<
  string,
  Promise<AudioSynthesisResult>
>();

const ttsGlobal = globalThis as typeof globalThis & {
  __aiSpeakingAudioMissTokens?: Map<
    string,
    { normalizedText: string; expiresAt: number }
  >;
};
const audioMissTokens =
  ttsGlobal.__aiSpeakingAudioMissTokens ??=
    new Map<string, { normalizedText: string; expiresAt: number }>();

export function getTtsProfile() {
  return getConfiguredTtsProfile();
}

function getAudioDescriptor(englishText: string, profile = getTtsProfile()) {
  return {
    text: englishText,
    model: profile.model,
    voice: profile.voice,
    speed: profile.speed,
    extension: profile.extension,
  };
}

function getSynthesisKey(englishText: string) {
  return JSON.stringify(getAudioDescriptor(englishText));
}

export function getEnglishAudioCacheUrl(
  englishText: string,
  profile?: TtsProfile,
) {
  return getReusableAudioUrl(getAudioDescriptor(englishText, profile));
}

export function getEnglishAudioStreamUrl(englishText: string) {
  return `/api/audio/stream?text=${encodeURIComponent(englishText)}`;
}

function getKnownMissAudioStreamUrl(englishText: string) {
  const now = Date.now();
  for (const [token, entry] of audioMissTokens) {
    if (entry.expiresAt <= now) {
      audioMissTokens.delete(token);
    }
  }
  const token = crypto.randomUUID();
  audioMissTokens.set(token, {
    normalizedText: englishText.trim(),
    expiresAt: now + 30_000,
  });
  return `${getEnglishAudioStreamUrl(englishText)}&missToken=${token}`;
}

export function consumeKnownAudioCacheMiss(
  token: string | null,
  englishText: string,
) {
  if (!token) {
    return false;
  }
  const entry = audioMissTokens.get(token);
  audioMissTokens.delete(token);
  return Boolean(
    entry &&
      entry.expiresAt > Date.now() &&
      entry.normalizedText === englishText.trim(),
  );
}

async function getCachedProfileAudioUrl(
  englishText: string,
  profile: TtsProfile,
) {
  const fallbackProfile = getTtsFallbackProfile(profile);
  const [primaryUrl, fallbackUrl] = await Promise.all([
    getEnglishAudioCacheUrl(englishText, profile),
    fallbackProfile
      ? getEnglishAudioCacheUrl(englishText, fallbackProfile)
      : Promise.resolve(null),
  ]);
  return primaryUrl ?? fallbackUrl;
}

export async function prepareEnglishAudio(englishText: string) {
  const profile = getTtsProfile();
  const cachedUrl = await getCachedProfileAudioUrl(englishText, profile);

  if (cachedUrl) {
    return {
      audioUrl: cachedUrl,
      source: "cache",
    } satisfies AudioSynthesisResult;
  }

  return {
    audioUrl: getKnownMissAudioStreamUrl(englishText),
    source:
      profile.provider === "openai" ? "openai_tts" : "cloudflare_tts",
  } satisfies AudioSynthesisResult;
}

export async function synthesizeEnglishAudio(
  englishText: string,
): Promise<AudioSynthesisResult> {
  const profile = getTtsProfile();
  const cachedUrl = await getCachedProfileAudioUrl(englishText, profile);

  if (cachedUrl) {
    return {
      audioUrl: cachedUrl,
      source: "cache",
    } satisfies AudioSynthesisResult;
  }

  const synthesisKey = getSynthesisKey(englishText);
  const activeSynthesis = inFlightSynthesis.get(synthesisKey);

  if (activeSynthesis) {
    return activeSynthesis;
  }

  const synthesis = (async () => {
    const speech = await requestEnglishSpeech(englishText, profile);
    const audio = await speech.response.arrayBuffer();

    return {
      audioUrl: await saveReusableAudio(
        getAudioDescriptor(englishText, speech.profile),
        audio,
      ),
      source: speech.source,
    } satisfies AudioSynthesisResult;
  })();
  inFlightSynthesis.set(synthesisKey, synthesis);

  try {
    return await synthesis;
  } finally {
    inFlightSynthesis.delete(synthesisKey);
  }
}
