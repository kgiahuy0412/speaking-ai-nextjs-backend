export type AudioSessionAsrSnapshot = {
  sampleRate: number;
  channelCount: number;
  bitsPerSample: number;
  pcmByteLength: number;
  chunkCount?: number;
};

export type SharedAudioSessionAsrResult = {
  sourceText: string;
  asrLatencyMs: number;
  waitLatencyMs: number;
  joined: boolean;
};

type SharedAudioSessionAsrValue = {
  sourceText: string;
  asrLatencyMs: number;
};

type AudioSessionAsrFlight = {
  promise: Promise<SharedAudioSessionAsrValue>;
  expiresAt: number;
};

type AudioSessionAsrGlobalState = typeof globalThis & {
  __aiSpeakingAudioSessionAsrFlights?: Map<string, AudioSessionAsrFlight>;
};

const state = globalThis as AudioSessionAsrGlobalState;
const flights = state.__aiSpeakingAudioSessionAsrFlights ??= new Map();
const completedFlightTtlMs = 30_000;
const maximumFlights = 128;

function flightKey(audioSessionId: string, snapshot: AudioSessionAsrSnapshot) {
  return [
    audioSessionId,
    snapshot.chunkCount ?? -1,
    snapshot.pcmByteLength,
    snapshot.sampleRate,
    snapshot.channelCount,
    snapshot.bitsPerSample,
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
 * Shares terminal-preview and finalize ASR when both refer to the exact same
 * PCM snapshot. A resolved transcript remains reusable briefly so a route
 * arriving just after the owner does not call the provider again.
 */
export async function transcribeAudioSessionOnce(input: {
  audioSessionId: string;
  snapshot: AudioSessionAsrSnapshot;
  transcribe: () => Promise<string>;
}): Promise<SharedAudioSessionAsrResult> {
  const startedAt = performance.now();
  const key = flightKey(input.audioSessionId, input.snapshot);
  prune();
  const existing = flights.get(key);
  if (existing) {
    const value = await existing.promise;
    return {
      ...value,
      waitLatencyMs: Math.round(performance.now() - startedAt),
      joined: true,
    };
  }

  const asrStartedAt = performance.now();
  const flight: AudioSessionAsrFlight = {
    expiresAt: Date.now() + completedFlightTtlMs,
    promise: Promise.resolve({ sourceText: "", asrLatencyMs: 0 }),
  };
  flight.promise = input
    .transcribe()
    .then((sourceText) => {
      flight.expiresAt = Date.now() + completedFlightTtlMs;
      return {
        sourceText,
        asrLatencyMs: Math.round(performance.now() - asrStartedAt),
      };
    })
    .catch((error: unknown) => {
      if (flights.get(key) === flight) flights.delete(key);
      throw error;
    });
  // Every owner awaits this promise below; the catch also makes failed work
  // immediately retryable instead of caching a rejected operation.
  flights.set(key, flight);

  const value = await flight.promise;
  return {
    ...value,
    waitLatencyMs: Math.round(performance.now() - startedAt),
    joined: false,
  };
}

export function resetAudioSessionAsrFlightsForTesting() {
  flights.clear();
}
