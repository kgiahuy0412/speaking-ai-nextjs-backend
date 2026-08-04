export type WhisperSegment = {
  avg_logprob?: unknown;
  no_speech_prob?: unknown;
  compression_ratio?: unknown;
};

export type TranscriptQualityContext = {
  utteranceDurationMs?: number;
};

const promptEchoFragments = [
  "vietnamese child speaking",
  "short everyday phrases",
  "preserve every word",
  "preserve the addressee",
  "question form",
  "translated naturally and faithfully",
];

// Whisper can produce these stock phrases from silence, television audio or
// steady background noise. They are not useful utterances in the child
// communication flow, so do not let them reach translation or TTS.
const commonHallucinationFragments = [
  "amara org",
  "cam on cac ban da theo doi",
  "cam on cac ban da xem",
  "cam on cac ban da xem video nay",
  "cam on moi nguoi da theo doi",
  "dang ky kenh",
  "hay subscribe cho kenh",
  "hen gap lai cac ban trong video",
  "khong bo lo nhung video hap dan",
  "phu de duoc thuc hien",
  "thanks for watching",
  "ung ho kenh cua minh",
];

// Keep these patterns specific enough that legitimate phrases such as
// "Con muốn xem video" or "Hẹn gặp lại mẹ" are still accepted. These
// combinations are stock Whisper completions observed repeatedly in noisy or
// low-speech child recordings, not useful communication utterances.
const commonHallucinationPatterns = [
  /\b(?:hay )?subscribe (?:cho )?kenh\b/u,
  /\b(?:hay )?dang ky kenh\b/u,
  /\bung ho kenh(?: cua minh)?\b/u,
  /\bkhong bo lo (?:nhung )?video\b/u,
  /\bcam on (?:cac ban|moi nguoi).*\b(?:xem|theo doi)\b.*\bvideo\b/u,
  /\bhen gap lai\b.*\bvideo(?: tiep theo)?\b/u,
  /\bphu de\b.*\b(?:thuc hien|boi)\b/u,
  /\bamara org\b/u,
];

const commonEnglishWords = new Set([
  "a",
  "am",
  "and",
  "are",
  "child",
  "everyday",
  "form",
  "good",
  "hello",
  "how",
  "i",
  "is",
  "morning",
  "need",
  "negation",
  "please",
  "preserve",
  "question",
  "short",
  "speaking",
  "thank",
  "the",
  "to",
  "want",
  "word",
  "you",
]);

function compact(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactWithoutVietnameseDiacritics(value: string) {
  return compact(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/g, "d");
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function hasVietnameseDiacritics(value: string) {
  return /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu.test(
    value,
  );
}

function looksEnglishOnly(value: string, words: string[]) {
  if (words.length < 2 || hasVietnameseDiacritics(value)) {
    return false;
  }

  const englishWords = words.filter((word) => commonEnglishWords.has(word));
  return englishWords.length >= 2 && englishWords.length / words.length >= 0.6;
}

function looksRepetitive(words: string[]) {
  if (words.length < 6) {
    return false;
  }

  const uniqueRatio = new Set(words).size / words.length;
  const repeatedTail = words
    .slice(-6)
    .every((word) => word === words[words.length - 1]);
  return uniqueRatio < 0.3 || repeatedTail;
}

function looksLikeCommonHallucination(value: string) {
  return (
    commonHallucinationFragments.some((fragment) => value.includes(fragment)) ||
    commonHallucinationPatterns.some((pattern) => pattern.test(value))
  );
}

export function getVietnameseTranscriptQualityIssue(
  transcript: string,
  segments: unknown[] = [],
  context: TranscriptQualityContext = {},
) {
  const normalized = compact(transcript);
  const normalizedWithoutDiacritics =
    compactWithoutVietnameseDiacritics(transcript);
  const words = normalized ? normalized.split(" ") : [];

  if (!normalized) {
    return "empty" as const;
  }
  if (words.length > 45) {
    return "too_long" as const;
  }
  if (promptEchoFragments.some((fragment) => normalized.includes(fragment))) {
    return "prompt_echo" as const;
  }
  if (looksLikeCommonHallucination(normalizedWithoutDiacritics)) {
    return "common_hallucination" as const;
  }
  if (looksEnglishOnly(normalized, words)) {
    return "unexpected_english" as const;
  }
  if (looksRepetitive(words)) {
    return "repetitive" as const;
  }

  const utteranceDurationMs = finiteNumber(context.utteranceDurationMs);
  if (utteranceDurationMs && utteranceDurationMs > 0) {
    const durationSeconds = utteranceDurationMs / 1000;
    const plausibleWordLimit = Math.max(
      8,
      Math.ceil(durationSeconds * 4.5) + 3,
    );
    if (words.length > plausibleWordLimit) {
      return "implausible_speaking_rate" as const;
    }
  }

  const qualitySegments = segments.filter(
    (segment): segment is WhisperSegment =>
      Boolean(segment) && typeof segment === "object",
  );
  const logProbabilities = qualitySegments
    .map((segment) => finiteNumber(segment.avg_logprob))
    .filter((value): value is number => value !== undefined);
  const noSpeechProbabilities = qualitySegments
    .map((segment) => finiteNumber(segment.no_speech_prob))
    .filter((value): value is number => value !== undefined);
  const compressionRatios = qualitySegments
    .map((segment) => finiteNumber(segment.compression_ratio))
    .filter((value): value is number => value !== undefined);

  const meanLogProbability =
    logProbabilities.length > 0
      ? logProbabilities.reduce((sum, value) => sum + value, 0) /
        logProbabilities.length
      : undefined;
  const meanNoSpeechProbability =
    noSpeechProbabilities.length > 0
      ? noSpeechProbabilities.reduce((sum, value) => sum + value, 0) /
        noSpeechProbabilities.length
      : undefined;

  if (
    meanNoSpeechProbability !== undefined &&
    (meanNoSpeechProbability >= 0.72 ||
      (Math.max(...noSpeechProbabilities) >= 0.9 &&
        meanLogProbability !== undefined &&
        meanLogProbability < -0.45))
  ) {
    return "no_speech" as const;
  }
  if (meanLogProbability !== undefined && meanLogProbability < -0.8) {
    return "low_log_probability" as const;
  }
  if (compressionRatios.some((value) => value > 2.4)) {
    return "high_compression" as const;
  }

  return null;
}
