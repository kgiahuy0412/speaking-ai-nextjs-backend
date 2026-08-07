import observedChildSpeechAliasesV1 from "./observedChildSpeechAliasesV1.json";
import { normalizeVietnameseForExactMatch } from "./exactRules";

export type ObservedChildSpeechAlias = {
  id: string;
  source: string;
  canonical: string;
  sampleCount: number;
  sourceRows: readonly number[];
};

type ObservedChildSpeechAliasDataset = {
  version: string;
  sourceWorkbook: string;
  sourceSheet: string;
  generatedFromRows: number;
  excluded: {
    ambiguousSourceCount: number;
    noOpSourceCount: number;
    negationMismatchSourceCount: number;
    protectedRoleMismatchSourceCount: number;
    personalNameSourceCount: number;
  };
  entries: ObservedChildSpeechAlias[];
};

const dataset = observedChildSpeechAliasesV1 as ObservedChildSpeechAliasDataset;
const aliasByExactTranscript = new Map<string, ObservedChildSpeechAlias>();

for (const alias of dataset.entries) {
  const normalizedSource = normalizeVietnameseForExactMatch(alias.source);
  const normalizedCanonical = normalizeVietnameseForExactMatch(
    alias.canonical,
  );

  if (!normalizedSource || !normalizedCanonical) {
    throw new Error(`Empty observed child-speech alias: ${alias.id}`);
  }
  if (normalizedSource === normalizedCanonical) {
    throw new Error(`No-op observed child-speech alias: ${alias.id}`);
  }
  if (normalizedSource.split(" ").length < 3) {
    throw new Error(`Observed child-speech alias is too short: ${alias.id}`);
  }

  const existing = aliasByExactTranscript.get(normalizedSource);
  if (
    existing &&
    normalizeVietnameseForExactMatch(existing.canonical) !==
      normalizedCanonical
  ) {
    throw new Error(
      `Conflicting observed child-speech aliases: ${existing.id} and ${alias.id}`,
    );
  }
  aliasByExactTranscript.set(normalizedSource, alias);
}

export const observedChildSpeechAliasRuntimeStats = {
  version: dataset.version,
  sourceRowCount: dataset.generatedFromRows,
  aliasCount: aliasByExactTranscript.size,
  excludedAmbiguousSourceCount: dataset.excluded.ambiguousSourceCount,
  excludedNoOpSourceCount: dataset.excluded.noOpSourceCount,
  excludedNegationMismatchSourceCount:
    dataset.excluded.negationMismatchSourceCount,
  excludedProtectedRoleMismatchSourceCount:
    dataset.excluded.protectedRoleMismatchSourceCount,
  excludedPersonalNameSourceCount: dataset.excluded.personalNameSourceCount,
} as const;

export const observedChildSpeechAliases = [...aliasByExactTranscript.values()];

export function findObservedChildSpeechAlias(transcript: string) {
  if (process.env.CHILD_SPEECH_ALIASES_ENABLED === "false") {
    return null;
  }
  return (
    aliasByExactTranscript.get(
      normalizeVietnameseForExactMatch(transcript),
    ) ?? null
  );
}
