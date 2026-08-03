import { getReusableAudioUrl, saveReusableAudio } from "@/lib/storage/audio";
import type { AudioSource } from "@/types/conversation";
import {
  getConfiguredTtsProfile,
  getTtsFallbackProfile,
  requestEnglishSpeech,
  type EnglishSpeechResult,
  type TtsProfile,
} from "./aiProvider";

export type AudioSynthesisResult = {
  audioUrl: string;
  source: AudioSource;
  byteLength?: number;
};

const ttsGlobal = globalThis as typeof globalThis & {
  __aiSpeakingInFlightSynthesis?: Map<
    string,
    Promise<AudioSynthesisResult>
  >;
  __aiSpeakingAudioMissTokens?: Map<
    string,
    { normalizedText: string; expiresAt: number }
  >;
};
const inFlightSynthesis =
  ttsGlobal.__aiSpeakingInFlightSynthesis ??=
    new Map<string, Promise<AudioSynthesisResult>>();
const audioMissTokens =
  ttsGlobal.__aiSpeakingAudioMissTokens ??=
    new Map<string, { normalizedText: string; expiresAt: number }>();

export function getTtsProfile() {
  return getConfiguredTtsProfile();
}

function normalizeEnglishAudioText(englishText: string) {
  return englishText.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function getAudioDescriptor(englishText: string, profile = getTtsProfile()) {
  return {
    text: normalizeEnglishAudioText(englishText),
    model: profile.model,
    voice: profile.voice,
    speed: profile.speed,
    extension: profile.extension,
  };
}

function getSynthesisKey(englishText: string) {
  return JSON.stringify(getAudioDescriptor(englishText));
}

export async function getEnglishAudioCacheUrl(
  englishText: string,
  profile?: TtsProfile,
) {
  const targetProfile = profile ?? getTtsProfile();
  const primaryUrl = await getReusableAudioUrl(
    getAudioDescriptor(englishText, targetProfile),
  );

  if (primaryUrl || profile) {
    return primaryUrl;
  }

  const fallbackProfile = getTtsFallbackProfile(targetProfile);
  return fallbackProfile
    ? getReusableAudioUrl(getAudioDescriptor(englishText, fallbackProfile))
    : null;
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
    normalizedText: normalizeEnglishAudioText(englishText),
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
      entry.normalizedText === normalizeEnglishAudioText(englishText),
  );
}

async function getCachedProfileAudioUrl(
  englishText: string,
  profile: TtsProfile,
) {
  const primaryUrl = await getEnglishAudioCacheUrl(englishText, profile);

  if (primaryUrl) {
    return primaryUrl;
  }

  const fallbackProfile = getTtsFallbackProfile(profile);
  return fallbackProfile
    ? getEnglishAudioCacheUrl(englishText, fallbackProfile)
    : null;
}

type EnglishAudioCacheFillClaim =
  | {
      owner: false;
      completion: Promise<AudioSynthesisResult>;
    }
  | {
      owner: true;
      completion: Promise<AudioSynthesisResult>;
      cacheResponse: (
        speech: EnglishSpeechResult,
        preserveOriginalResponse: boolean,
      ) => Promise<AudioSynthesisResult>;
      fail: (error: unknown) => void;
    };

/**
 * Coordinates all TTS callers for the same sentence/profile. The owner starts
 * exactly one provider request; concurrent stream or warm-up callers wait for
 * the durable cache result instead of paying for duplicate synthesis.
 */
export function claimEnglishAudioCacheFill(
  englishText: string,
): EnglishAudioCacheFillClaim {
  const synthesisKey = getSynthesisKey(englishText);
  const activeSynthesis = inFlightSynthesis.get(synthesisKey);

  if (activeSynthesis) {
    return { owner: false, completion: activeSynthesis };
  }

  let resolveCompletion!: (result: AudioSynthesisResult) => void;
  let rejectCompletion!: (error: unknown) => void;
  let settled = false;
  const completion = new Promise<AudioSynthesisResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // The owner can return a streaming response before the fill completes. Keep
  // a rejection handler attached even when no concurrent caller is waiting.
  void completion.catch(() => undefined);
  inFlightSynthesis.set(synthesisKey, completion);

  const clear = () => {
    if (inFlightSynthesis.get(synthesisKey) === completion) {
      inFlightSynthesis.delete(synthesisKey);
    }
  };

  return {
    owner: true,
    completion,
    cacheResponse(speech, preserveOriginalResponse) {
      if (settled) {
        return completion;
      }
      settled = true;
      const cacheResponse = preserveOriginalResponse
        ? speech.response.clone()
        : speech.response;

      void cacheResponse
        .arrayBuffer()
        .then(async (audio) => ({
          audioUrl: await saveReusableAudio(
            getAudioDescriptor(englishText, speech.profile),
            audio,
          ),
          source: speech.source,
          byteLength: audio.byteLength,
        } satisfies AudioSynthesisResult))
        .then(
          (result) => {
            resolveCompletion(result);
            clear();
          },
          (error) => {
            rejectCompletion(error);
            clear();
          },
        );

      return completion;
    },
    fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      rejectCompletion(error);
      clear();
    },
  };
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

  const claim = claimEnglishAudioCacheFill(englishText);
  if (!claim.owner) {
    return claim.completion;
  }

  try {
    const speech = await requestEnglishSpeech(englishText, profile);
    return await claim.cacheResponse(speech, false);
  } catch (error) {
    claim.fail(error);
    throw error;
  }
}
