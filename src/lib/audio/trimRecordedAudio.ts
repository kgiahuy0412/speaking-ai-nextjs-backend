export type SpeechBounds = {
  startSample: number;
  endSample: number;
  threshold: number;
};

export type TrimRecordedAudioResult = {
  blob: Blob;
  trimmed: boolean;
  reason:
    | "trimmed"
    | "no_audio_context"
    | "decode_failed"
    | "speech_not_found"
    | "saving_too_small";
  originalDurationMs?: number;
  retainedDurationMs?: number;
  threshold?: number;
};

const analysisWindowMs = 20;
const leadingPaddingMs = 240;
const trailingPaddingMs = 320;
const minimumUsefulSavingMs = 200;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

/**
 * Finds a conservative speech range using short-window RMS. Two active windows
 * are required around each edge so a single tap/click is not treated as speech.
 */
export function findSpeechBounds(
  channels: readonly Float32Array[],
  sampleRate: number,
  measuredNoiseFloor?: number,
): SpeechBounds | null {
  const sampleCount = channels.reduce(
    (minimum, channel) => Math.min(minimum, channel.length),
    Number.POSITIVE_INFINITY,
  );
  if (
    channels.length === 0 ||
    !Number.isFinite(sampleCount) ||
    sampleCount <= 0 ||
    sampleRate <= 0
  ) {
    return null;
  }

  const windowSamples = Math.max(
    1,
    Math.round((sampleRate * analysisWindowMs) / 1_000),
  );
  const rmsWindows: number[] = [];

  for (let start = 0; start < sampleCount; start += windowSamples) {
    const end = Math.min(sampleCount, start + windowSamples);
    let squaredTotal = 0;
    let valueCount = 0;

    for (const channel of channels) {
      for (let index = start; index < end; index += 1) {
        const value = channel[index] ?? 0;
        squaredTotal += value * value;
        valueCount += 1;
      }
    }

    rmsWindows.push(
      valueCount > 0 ? Math.sqrt(squaredTotal / valueCount) : 0,
    );
  }

  const quietPercentile = percentile(rmsWindows, 0.2);
  const usableMeasuredNoise =
    measuredNoiseFloor !== undefined && Number.isFinite(measuredNoiseFloor)
      ? Math.min(measuredNoiseFloor, quietPercentile || measuredNoiseFloor)
      : quietPercentile;
  const threshold = clamp(usableMeasuredNoise * 2.6, 0.01, 0.04);
  const active = rmsWindows.map((rms) => rms >= threshold);

  const hasNeighbourSupport = (index: number) => {
    let count = 0;
    for (
      let candidate = Math.max(0, index - 1);
      candidate <= Math.min(active.length - 1, index + 2);
      candidate += 1
    ) {
      if (active[candidate]) count += 1;
    }
    return count >= 2;
  };

  let firstActive = -1;
  let lastActive = -1;
  for (let index = 0; index < active.length; index += 1) {
    if (active[index] && hasNeighbourSupport(index)) {
      firstActive = index;
      break;
    }
  }
  for (let index = active.length - 1; index >= 0; index -= 1) {
    if (active[index] && hasNeighbourSupport(index)) {
      lastActive = index;
      break;
    }
  }

  if (firstActive < 0 || lastActive < firstActive) return null;

  const leadingPaddingSamples = Math.round(
    (sampleRate * leadingPaddingMs) / 1_000,
  );
  const trailingPaddingSamples = Math.round(
    (sampleRate * trailingPaddingMs) / 1_000,
  );

  return {
    startSample: Math.max(
      0,
      firstActive * windowSamples - leadingPaddingSamples,
    ),
    endSample: Math.min(
      sampleCount,
      (lastActive + 1) * windowSamples + trailingPaddingSamples,
    ),
    threshold,
  };
}

export function encodeMonoPcm16Wav(
  channels: readonly Float32Array[],
  sampleRate: number,
  startSample: number,
  endSample: number,
) {
  const sampleCount = Math.max(0, endSample - startSample);
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + sampleCount * bytesPerSample);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * bytesPerSample, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * bytesPerSample, true);

  for (let outputIndex = 0; outputIndex < sampleCount; outputIndex += 1) {
    const sourceIndex = startSample + outputIndex;
    let mixed = 0;
    for (const channel of channels) {
      mixed += channel[sourceIndex] ?? 0;
    }
    mixed = clamp(mixed / channels.length, -1, 1);
    view.setInt16(
      44 + outputIndex * bytesPerSample,
      mixed < 0 ? mixed * 0x8000 : mixed * 0x7fff,
      true,
    );
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export async function trimRecordedAudio(
  original: Blob,
  measuredNoiseFloor?: number,
): Promise<TrimRecordedAudioResult> {
  const audioWindow = window as Window &
    typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    };
  const AudioContextConstructor =
    audioWindow.AudioContext ?? audioWindow.webkitAudioContext;

  if (!AudioContextConstructor) {
    return { blob: original, trimmed: false, reason: "no_audio_context" };
  }

  const audioContext = new AudioContextConstructor();
  try {
    const encodedAudio = await original.arrayBuffer();
    const decodedAudio = await audioContext.decodeAudioData(encodedAudio);
    const channels = Array.from(
      { length: decodedAudio.numberOfChannels },
      (_, channel) => decodedAudio.getChannelData(channel),
    );
    const bounds = findSpeechBounds(
      channels,
      decodedAudio.sampleRate,
      measuredNoiseFloor,
    );
    const originalDurationMs = decodedAudio.duration * 1_000;

    if (!bounds) {
      return {
        blob: original,
        trimmed: false,
        reason: "speech_not_found",
        originalDurationMs,
      };
    }

    const retainedDurationMs =
      ((bounds.endSample - bounds.startSample) / decodedAudio.sampleRate) *
      1_000;
    if (originalDurationMs - retainedDurationMs < minimumUsefulSavingMs) {
      return {
        blob: original,
        trimmed: false,
        reason: "saving_too_small",
        originalDurationMs,
        retainedDurationMs,
        threshold: bounds.threshold,
      };
    }

    return {
      blob: encodeMonoPcm16Wav(
        channels,
        decodedAudio.sampleRate,
        bounds.startSample,
        bounds.endSample,
      ),
      trimmed: true,
      reason: "trimmed",
      originalDurationMs,
      retainedDurationMs,
      threshold: bounds.threshold,
    };
  } catch {
    return { blob: original, trimmed: false, reason: "decode_failed" };
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}
