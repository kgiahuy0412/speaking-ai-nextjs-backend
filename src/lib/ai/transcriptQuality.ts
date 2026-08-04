export type WhisperSegment = {
  avg_logprob?: unknown;
  no_speech_prob?: unknown;
  compression_ratio?: unknown;
};

const promptEchoFragments = [
  "vietnamese child speaking",
  "short everyday phrases",
  "preserve every word",
  "preserve the addressee",
  "question form",
  "translated naturally and faithfully",
];

const knownHallucinationPatterns = [
  /\b(?:subscribe|dang ky)\b.*\bkenh\b/u,
  /\blala\s*school\b/u,
  /\bkhong bo lo\b.*\bvideo\b/u,
  /\bung ho\b.*\bkenh\b/u,
  /\bcam on cac ban da theo doi\b/u,
  /\bhen gap lai\b.*\b(?:cac ban|video)\b/u,
  /\bvideo tiep theo\b/u,
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

function foldVietnamese(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gu, "d");
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
  if (words.length >= 2 && new Set(words).size === 1) {
    return true;
  }
  if (words.length < 6) {
    return false;
  }

  const uniqueRatio = new Set(words).size / words.length;
  const repeatedTail = words
    .slice(-6)
    .every((word) => word === words[words.length - 1]);
  return uniqueRatio < 0.3 || repeatedTail;
}

export function getVietnameseTranscriptQualityIssue(
  transcript: string,
  segments: unknown[] = [],
) {
  const normalized = compact(transcript);
  const folded = foldVietnamese(normalized);
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
  if (knownHallucinationPatterns.some((pattern) => pattern.test(folded))) {
    return "known_hallucination" as const;
  }
  if (looksEnglishOnly(normalized, words)) {
    return "unexpected_english" as const;
  }
  if (looksRepetitive(words)) {
    return "repetitive" as const;
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

  if (
    noSpeechProbabilities.length > 0 &&
    noSpeechProbabilities.every((value) => value >= 0.85)
  ) {
    return "no_speech" as const;
  }
  if (
    logProbabilities.length > 0 &&
    logProbabilities.reduce((sum, value) => sum + value, 0) /
      logProbabilities.length <
      -1
  ) {
    return "low_log_probability" as const;
  }
  if (compressionRatios.some((value) => value > 2.6)) {
    return "high_compression" as const;
  }

  return null;
}
