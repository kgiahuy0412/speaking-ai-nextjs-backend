import { getReusableAudioUrl, saveReusableAudio } from "@/lib/storage/audio";
import type { AudioSource } from "@/types/conversation";
import {
  getConfiguredTtsProfile,
  requestEnglishSpeech,
  type EnglishSpeechResult,
  type TtsProfile,
} from "./aiProvider";

export type AudioSynthesisResult = {
  audioUrl: string;
  source: AudioSource;
  /// True when audioUrl points at durable reusable storage, including a
  /// provider miss that has just been synthesized and saved.
  cacheReady: boolean;
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
  __aiSpeakingActiveAudioStreams?: Map<string, ActiveEnglishAudioStream>;
};
const inFlightSynthesis =
  ttsGlobal.__aiSpeakingInFlightSynthesis ??=
    new Map<string, Promise<AudioSynthesisResult>>();
const audioMissTokens =
  ttsGlobal.__aiSpeakingAudioMissTokens ??=
    new Map<string, { normalizedText: string; expiresAt: number }>();
const activeAudioStreams =
  ttsGlobal.__aiSpeakingActiveAudioStreams ??=
    new Map<string, ActiveEnglishAudioStream>();

type ActiveEnglishAudioStream = {
  expiresAt: number;
  subscribe: (reused?: boolean) => Response;
};

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

function pruneActiveAudioStreams(now = Date.now()) {
  for (const [key, stream] of activeAudioStreams) {
    if (stream.expiresAt <= now) activeAudioStreams.delete(key);
  }
  while (activeAudioStreams.size > 128) {
    const oldestKey = activeAudioStreams.keys().next().value;
    if (oldestKey === undefined) break;
    activeAudioStreams.delete(oldestKey);
  }
}

/**
 * Fans one provider response out to the currently preloading Safari element
 * and any duplicate listener that arrives while durable cache storage is in
 * progress. Buffered chunks are replayed to late subscribers, so nobody waits
 * for cache completion and then performs an extra redirect/request.
 */
export function startEnglishAudioStream(
  englishText: string,
  speech: EnglishSpeechResult,
  options: { onFirstChunk?: () => void } = {},
) {
  pruneActiveAudioStreams();
  const key = getSynthesisKey(englishText);
  const existing = activeAudioStreams.get(key);
  if (existing) return existing.subscribe(true);

  const body = speech.response.body;
  if (!body) {
    throw new Error("TTS provider returned an empty audio stream.");
  }

  const bufferedChunks: Uint8Array[] = [];
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let completed = false;
  let streamError: unknown;
  let firstChunkSeen = false;
  const contentType =
    speech.response.headers.get("content-type") ?? "audio/mpeg";
  const active: ActiveEnglishAudioStream = {
    expiresAt: Date.now() + 15_000,
    subscribe: (reused = false) => {
      let subscriber:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          subscriber = controller;
          for (const chunk of bufferedChunks) controller.enqueue(chunk);
          if (streamError !== undefined) {
            controller.error(streamError);
          } else if (completed) {
            controller.close();
          } else {
            subscribers.add(controller);
          }
        },
        cancel() {
          if (subscriber) subscribers.delete(subscriber);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Audio-Source": speech.source,
          "X-Audio-Stream-Reused": reused ? "1" : "0",
        },
      });
    },
  };
  activeAudioStreams.set(key, active);

  const reader = body.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value.slice();
        bufferedChunks.push(chunk);
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          options.onFirstChunk?.();
        }
        for (const controller of subscribers) {
          try {
            controller.enqueue(chunk);
          } catch {
            subscribers.delete(controller);
          }
        }
      }
      completed = true;
      active.expiresAt = Date.now() + 15_000;
      for (const controller of subscribers) controller.close();
      subscribers.clear();
    } catch (error) {
      streamError = error;
      active.expiresAt = Date.now() + 1_000;
      for (const controller of subscribers) controller.error(error);
      subscribers.clear();
    }
  })();

  return active.subscribe();
}

export function subscribeEnglishAudioStream(englishText: string) {
  pruneActiveAudioStreams();
  return (
    activeAudioStreams.get(getSynthesisKey(englishText))?.subscribe(true) ?? null
  );
}

export async function getEnglishAudioCacheUrl(
  englishText: string,
  profile?: TtsProfile,
) {
  const targetProfile = profile ?? getTtsProfile();
  const primaryUrl = await getReusableAudioUrl(
    getAudioDescriptor(englishText, targetProfile),
  );

  return primaryUrl;
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
  return getEnglishAudioCacheUrl(englishText, profile);
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
          cacheReady: true,
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
      cacheReady: true,
    } satisfies AudioSynthesisResult;
  }

  return {
    audioUrl: getKnownMissAudioStreamUrl(englishText),
    source: "cloudflare_tts",
    cacheReady: false,
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
      cacheReady: true,
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
