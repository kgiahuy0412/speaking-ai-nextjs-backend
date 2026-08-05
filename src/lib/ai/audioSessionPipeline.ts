import type { ConversationRequest, PracticeContext } from "@/types/conversation";
import { transcribeVietnamese } from "./asr";
import {
  transcribeAudioSessionOnce,
  type AudioSessionAsrSnapshot,
} from "./audioSessionAsr";
import {
  prepareConversationPipeline,
  type PreparedConversationPipeline,
} from "./pipeline";

type PreparedAudioSessionPipelineValue = {
  pipeline: PreparedConversationPipeline;
  asrSharedFlightJoined: boolean;
  asrWaitLatencyMs: number;
};

export type PreparedAudioSessionPipeline =
  PreparedAudioSessionPipelineValue & {
    pipelineSharedFlightJoined: boolean;
  };

type AudioSessionPipelineFlight = {
  promise: Promise<PreparedAudioSessionPipelineValue>;
  expiresAt: number;
};

type AudioSessionPipelineGlobalState = typeof globalThis & {
  __aiSpeakingAudioSessionPipelineFlights?: Map<
    string,
    AudioSessionPipelineFlight
  >;
};

const state = globalThis as AudioSessionPipelineGlobalState;
const flights = state.__aiSpeakingAudioSessionPipelineFlights ??= new Map();
const completedFlightTtlMs = 30_000;
const maximumFlights = 128;

function flightKey(input: {
  audioSessionId: string;
  snapshot: AudioSessionAsrSnapshot;
  context: PracticeContext;
  childAge: number;
}) {
  return [
    input.audioSessionId,
    input.snapshot.chunkCount ?? -1,
    input.snapshot.pcmByteLength,
    input.snapshot.sampleRate,
    input.snapshot.channelCount,
    input.snapshot.bitsPerSample,
    input.context,
    input.childAge,
  ].join(":");
}

function prune(now = Date.now()) {
  for (const [key, flight] of flights) {
    if (flight.expiresAt <= now) flights.delete(key);
  }
  while (flights.size > maximumFlights) {
    const oldestKey = flights.keys().next().value;
    if (oldestKey === undefined) break;
    flights.delete(oldestKey);
  }
}

/**
 * Shares the complete terminal-preview pipeline for one exact PCM snapshot.
 * Finalize therefore joins ASR, controlled translation and the exact audio
 * stream URL already returned to Safari, rather than only joining ASR and
 * rebuilding the remaining stages.
 */
export function prepareAudioSessionPipelineOnce(input: {
  audioSessionId: string;
  snapshot: AudioSessionAsrSnapshot;
  request: ConversationRequest;
}): Promise<PreparedAudioSessionPipeline> {
  const context = input.request.context;
  const childAge = input.request.childAge ?? 6;
  const key = flightKey({
    audioSessionId: input.audioSessionId,
    snapshot: input.snapshot,
    context,
    childAge,
  });
  prune();
  const existing = flights.get(key);
  if (existing) {
    return existing.promise.then((value: PreparedAudioSessionPipelineValue) => ({
      ...value,
      pipelineSharedFlightJoined: true,
    }));
  }

  const operation: Promise<PreparedAudioSessionPipelineValue> = (async () => {
    const sharedAsr = await transcribeAudioSessionOnce({
      audioSessionId: input.audioSessionId,
      snapshot: input.snapshot,
      transcribe: () => transcribeVietnamese(input.request),
    });
    const pipeline = await prepareConversationPipeline(input.request, {
      deferTextCacheWrite: true,
      prefetchedTranscript: {
        sourceText: sharedAsr.sourceText,
        latencyMs: sharedAsr.asrLatencyMs,
      },
      // A terminal preview must hand Safari a playable stream immediately.
      // Durable cache storage continues independently in /api/audio/stream.
      streamAudioOnCacheMiss: true,
    });
    return {
      pipeline,
      asrSharedFlightJoined: sharedAsr.joined,
      asrWaitLatencyMs: sharedAsr.waitLatencyMs,
    };
  })();
  const flight: AudioSessionPipelineFlight = {
    expiresAt: Date.now() + completedFlightTtlMs,
    promise: operation,
  };
  const promise = operation.then(
    (value) => {
      flight.expiresAt = Date.now() + completedFlightTtlMs;
      return value;
    },
    (error: unknown) => {
      if (flights.get(key) === flight) flights.delete(key);
      throw error;
    },
  );
  flight.promise = promise;
  flights.set(key, flight);
  return promise.then((value: PreparedAudioSessionPipelineValue) => ({
    ...value,
    pipelineSharedFlightJoined: false,
  }));
}

export function resetAudioSessionPipelineFlightsForTesting() {
  flights.clear();
}
