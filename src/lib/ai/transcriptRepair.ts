const childPredicatePattern =
  "muốn|cần|không|bị|thấy|đang|sẽ|đã|chưa|làm|thích|khát|đói|no|đau|buồn|vui|nhớ|sợ|nóng|lạnh|quên|mất|xin|cảm|tự";

const confusedChildSubjectPattern = new RegExp(
  `^((?:(?:mẹ|má|bố|ba|cô|thầy)\\s+ơi[,.!?]?\\s+)?)(có)(?=\\s+(?:${childPredicatePattern})\\b)`,
  "iu",
);

function matchCase(source: string, replacement: string) {
  return source === source.toLocaleUpperCase("vi")
    ? replacement.toLocaleUpperCase("vi")
    : source[0] === source[0]?.toLocaleUpperCase("vi")
      ? `${replacement[0]?.toLocaleUpperCase("vi")}${replacement.slice(1)}`
      : replacement;
}

export function repairVietnameseChildTranscript(text: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    return trimmed;
  }

  return trimmed.replace(
    confusedChildSubjectPattern,
    (_match, prefix: string, confusedSubject: string) =>
      `${prefix}${matchCase(confusedSubject, "con")}`,
  );
}
