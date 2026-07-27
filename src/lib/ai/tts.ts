import { getReusableAudioUrl, saveReusableAudio } from "@/lib/storage/audio";
import type { AudioSource } from "@/types/conversation";
import {
  getConfiguredTtsProfile,
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

export async function prepareEnglishAudio(englishText: string) {
  const profile = getTtsProfile();
  const cachedUrl = await getEnglishAudioCacheUrl(englishText, profile);

  if (cachedUrl) {
    return {
      audioUrl: cachedUrl,
      source: "cache",
    } satisfies AudioSynthesisResult;
  }

  return {
    audioUrl: getEnglishAudioStreamUrl(englishText),
    source:
      profile.provider === "openai" ? "openai_tts" : "cloudflare_tts",
  } satisfies AudioSynthesisResult;
}

export async function synthesizeEnglishAudio(
  englishText: string,
): Promise<AudioSynthesisResult> {
  const profile = getTtsProfile();
  const cachedUrl = await getEnglishAudioCacheUrl(englishText, profile);

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
        getAudioDescriptor(englishText, profile),
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
