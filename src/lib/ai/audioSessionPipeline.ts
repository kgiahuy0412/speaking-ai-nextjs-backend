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

type LatestAudioSessionPipelineFlight = AudioSessionPipelineFlight & {
  snapshot: AudioSessionAsrSnapshot;
  context: PracticeContext;
  childAge: number;
  startedAt: number;
};

export type JoinableAudioSessionPipelineFlight = {
  snapshot: AudioSessionAsrSnapshot;
  startedAt: number;
  promise: Promise<PreparedAudioSessionPipeline>;
};

type AudioSessionPipelineGlobalState = typeof globalThis & {
  __aiSpeakingAudioSessionPipelineFlights?: Map<
    string,
    AudioSessionPipelineFlight
  >;
  __aiSpeakingLatestTerminalAudioSessionPipelineFlights?: Map<
    string,
    LatestAudioSessionPipelineFlight
  >;
};

const state = globalThis as AudioSessionPipelineGlobalState;
const flights = state.__aiSpeakingAudioSessionPipelineFlights ??= new Map();
const latestTerminalFlights =
  state.__aiSpeakingLatestTerminalAudioSessionPipelineFlights ??= new Map();
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
  for (const [audioSessionId, flight] of latestTerminalFlights) {
    if (flight.expiresAt <= now) latestTerminalFlights.delete(audioSessionId);
  }
}

function registerLatestTerminalFlight(input: {
  audioSessionId: string;
  snapshot: AudioSessionAsrSnapshot;
  context: PracticeContext;
  childAge: number;
  flight: AudioSessionPipelineFlight;
}) {
  const current = latestTerminalFlights.get(input.audioSessionId);
  const currentChunkCount = current?.snapshot.chunkCount ?? -1;
  const nextChunkCount = input.snapshot.chunkCount ?? -1;
  if (
    current &&
    (currentChunkCount > nextChunkCount ||
      (currentChunkCount === nextChunkCount &&
        current.snapshot.pcmByteLength > input.snapshot.pcmByteLength))
  ) {
    return;
  }
  latestTerminalFlights.set(input.audioSessionId, {
    ...input.flight,
    snapshot: { ...input.snapshot },
    context: input.context,
    childAge: input.childAge,
    startedAt: Date.now(),
  });
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
  terminalSnapshot?: boolean;
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
    if (input.terminalSnapshot) {
      registerLatestTerminalFlight({
        audioSessionId: input.audioSessionId,
        snapshot: input.snapshot,
        context,
        childAge,
        flight: existing,
      });
    }
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
      const latest = latestTerminalFlights.get(input.audioSessionId);
      if (latest?.promise === flight.promise) {
        latestTerminalFlights.delete(input.audioSessionId);
      }
      throw error;
    },
  );
  flight.promise = promise;
  flights.set(key, flight);
  if (input.terminalSnapshot) {
    registerLatestTerminalFlight({
      audioSessionId: input.audioSessionId,
      snapshot: input.snapshot,
      context,
      childAge,
      flight,
    });
  }
  return promise.then((value: PreparedAudioSessionPipelineValue) => ({
    ...value,
    pipelineSharedFlightJoined: false,
  }));
}

/**
 * Returns terminal-preview work as soon as the route has registered it, not
 * only after a BatchPrefetchCandidate has been fully materialized. Finalize
 * can validate the short PCM tail and join this complete ASR -> text -> audio
 * promise while it is still running.
 */
export function getLatestTerminalAudioSessionPipelineFlight(input: {
  audioSessionId: string;
  context: PracticeContext;
  childAge: number;
}): JoinableAudioSessionPipelineFlight | null {
  prune();
  const flight = latestTerminalFlights.get(input.audioSessionId);
  if (
    !flight ||
    flight.context !== input.context ||
    flight.childAge !== input.childAge
  ) {
    return null;
  }
  return {
    snapshot: { ...flight.snapshot },
    startedAt: flight.startedAt,
    promise: flight.promise.then((value: PreparedAudioSessionPipelineValue) => ({
      ...value,
      pipelineSharedFlightJoined: true,
    })),
  };
}

export function resetAudioSessionPipelineFlightsForTesting() {
  flights.clear();
  latestTerminalFlights.clear();
}
