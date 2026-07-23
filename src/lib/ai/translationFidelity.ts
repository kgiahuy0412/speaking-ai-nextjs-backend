type FidelityRequirement = {
  id: string;
  sourceMatches: (source: string) => boolean;
  englishPattern: RegExp;
};

function normalizedWords(text: string) {
  return ` ${text
    .toLocaleLowerCase("vi")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function containsPhrase(source: string, phrase: string) {
  return source.includes(` ${phrase} `);
}

function containsAnyPhrase(source: string, phrases: string[]) {
  return phrases.some((phrase) => containsPhrase(source, phrase));
}

const requirements: FidelityRequirement[] = [
  {
    id: "kinship_mom",
    sourceMatches: (source) =>
      containsAnyPhrase(source, ["mẹ", "má"]),
    englishPattern: /\b(?:mom|mommy|mother)\b/i,
  },
  {
    id: "kinship_dad",
    sourceMatches: (source) =>
      containsPhrase(source, "bố") ||
      containsAnyPhrase(source, ["ba ơi", "nhé ba", "nha ba"]),
    englishPattern: /\b(?:dad|daddy|father)\b/i,
  },
  {
    id: "kinship_grandpa",
    sourceMatches: (source) => containsPhrase(source, "ông ơi"),
    englishPattern: /\b(?:grandpa|grandfather)\b/i,
  },
  {
    id: "kinship_grandma",
    sourceMatches: (source) =>
      containsAnyPhrase(source, ["bà ơi", "ngoại ơi", "nội ơi"]),
    englishPattern: /\b(?:grandma|grandmother)\b/i,
  },
  {
    id: "time_tomorrow",
    sourceMatches: (source) => containsPhrase(source, "ngày mai"),
    englishPattern: /\btomorrow\b/i,
  },
  {
    id: "time_yesterday",
    sourceMatches: (source) => containsPhrase(source, "hôm qua"),
    englishPattern: /\byesterday\b/i,
  },
  {
    id: "time_today",
    sourceMatches: (source) =>
      containsAnyPhrase(source, ["hôm nay", "bữa nay"]),
    englishPattern: /\btoday\b/i,
  },
  {
    id: "place_park",
    sourceMatches: (source) => containsPhrase(source, "công viên"),
    englishPattern: /\bpark\b/i,
  },
  {
    id: "place_school",
    sourceMatches: (source) => containsPhrase(source, "trường"),
    englishPattern: /\bschool\b/i,
  },
  {
    id: "object_pen",
    sourceMatches: (source) =>
      containsAnyPhrase(source, ["cây bút", "cái bút"]) &&
      !containsAnyPhrase(source, ["bút chì", "bút màu"]),
    englishPattern: /\bpen\b/i,
  },
  {
    id: "color_purple",
    sourceMatches: (source) => containsPhrase(source, "màu tím"),
    englishPattern: /\bpurple\b/i,
  },
  {
    id: "color_red",
    sourceMatches: (source) => containsPhrase(source, "màu đỏ"),
    englishPattern: /\bred\b/i,
  },
  {
    id: "color_green",
    sourceMatches: (source) =>
      containsAnyPhrase(source, ["màu xanh lá", "màu xanh lá cây"]),
    englishPattern: /\bgreen\b/i,
  },
  {
    id: "color_blue",
    sourceMatches: (source) =>
      containsAnyPhrase(source, ["màu xanh dương", "màu xanh da trời"]),
    englishPattern: /\bblue\b/i,
  },
  {
    id: "explicit_negation",
    sourceMatches: (source) =>
      containsAnyPhrase(source, [
        "không muốn",
        "không thích",
        "không hiểu",
        "không biết",
        "không phải",
        "không có",
        "chưa",
        "đừng",
        "hổng",
      ]),
    englishPattern: /\b(?:not|no|never|yet)\b|n['’]t\b/i,
  },
];

export function findMissingTranslationRequirements(
  vietnameseText: string,
  englishText: string,
) {
  const source = normalizedWords(vietnameseText);

  return requirements
    .filter(
      (requirement) =>
        requirement.sourceMatches(source) &&
        !requirement.englishPattern.test(englishText),
    )
    .map((requirement) => requirement.id);
}

