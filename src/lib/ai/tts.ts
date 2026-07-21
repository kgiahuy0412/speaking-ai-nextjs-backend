import { getReusableAudioUrl, saveReusableAudio } from "@/lib/storage/audio";
import { getOpenAIClient } from "./openai";

export type AudioSynthesisResult = {
  audioUrl: string;
  source: "cache" | "openai_tts";
};

const inFlightSynthesis = new Map<
  string,
  Promise<AudioSynthesisResult>
>();

export function getTtsProfile() {
  const configuredSpeed = Number(process.env.OPENAI_TTS_SPEED ?? 0.9);

  return {
    model: process.env.OPENAI_TTS_MODEL ?? "tts-1",
    voice: process.env.OPENAI_TTS_VOICE ?? "alloy",
    speed:
      Number.isFinite(configuredSpeed) &&
      configuredSpeed >= 0.25 &&
      configuredSpeed <= 4
        ? configuredSpeed
        : 0.9,
    extension: "mp3",
  };
}

function getAudioDescriptor(englishText: string) {
  return {
    text: englishText,
    ...getTtsProfile(),
  };
}

function getSynthesisKey(englishText: string) {
  return JSON.stringify(getAudioDescriptor(englishText));
}

export function getEnglishAudioCacheUrl(englishText: string) {
  return getReusableAudioUrl(getAudioDescriptor(englishText));
}

export async function prepareEnglishAudio(englishText: string) {
  const cachedUrl = await getEnglishAudioCacheUrl(englishText);

  if (cachedUrl) {
    return {
      audioUrl: cachedUrl,
      source: "cache",
    } satisfies AudioSynthesisResult;
  }

  return {
    audioUrl: `/api/audio/stream?text=${encodeURIComponent(englishText)}`,
    source: "openai_tts",
  } satisfies AudioSynthesisResult;
}

export async function synthesizeEnglishAudio(englishText: string) {
  const cachedUrl = await getEnglishAudioCacheUrl(englishText);

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
    const client = getOpenAIClient();
    const profile = getTtsProfile();
    const speech = await client.audio.speech.create({
      model: profile.model,
      voice: profile.voice,
      input: englishText,
      response_format: "mp3",
      speed: profile.speed,
    });
    const audio = await speech.arrayBuffer();

    return {
      audioUrl: await saveReusableAudio(
        getAudioDescriptor(englishText),
        audio,
      ),
      source: "openai_tts",
    } satisfies AudioSynthesisResult;
  })();
  inFlightSynthesis.set(synthesisKey, synthesis);

  try {
    return await synthesis;
  } finally {
    inFlightSynthesis.delete(synthesisKey);
  }
}
