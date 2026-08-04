import { containsUnexpectedEastAsianScript } from "./languageValidation";

// Translation models sometimes return instructions or an explanation instead
// of the requested sentence. Never cache or synthesize those responses.
const metaResponsePatterns = [
  /\byou (?:did not|didn't|have not|haven't) provide\b/i,
  /\bplease provide (?:the )?(?:vietnamese|utterance|sentence|text)\b/i,
  /\b(?:vietnamese|source) (?:utterance|sentence|text).*(?:missing|not provided)\b/i,
  /\b(?:as an ai|i (?:cannot|can't|am unable to) translate)\b/i,
  /\bhere(?:'s| is) (?:the )?(?:english )?translation\b/i,
];

export function normalizeTranslationOutput(text: string) {
  let value = text.trim();

  value = value.replace(/^(english|translation)\s*:\s*/i, "").trim();

  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }

  if (
    !value ||
    value.length > 500 ||
    containsUnexpectedEastAsianScript(value) ||
    /^(vietnamese|source)\s*:/i.test(value) ||
    metaResponsePatterns.some((pattern) => pattern.test(value))
  ) {
    return null;
  }

  return value;
}
