import type { PracticeContext } from "@/types/conversation";
import { normalizeVietnamese } from "@/lib/normalize";

export type SemanticIntentRule = {
  intent: string;
  english: string;
  samples: string[];
  anyKeywords?: string[];
  blockedKeywords?: string[];
  minScore?: number;
};

export type SemanticIntentMatch = {
  intent: string;
  englishText: string;
  score: number;
  sample: string;
};

const fillerTokens = new Set([
  "con",
  "oi",
  "a",
  "nhe",
  "nha",
  "di",
  "muon",
  "can",
  "cho",
  "voi",
  "qua",
  "lam",
  "la",
  "do",
]);

const sharedSemanticIntentRules: SemanticIntentRule[] = [
  {
    intent: "thank_you",
    english: "Thank you.",
    samples: [
      "con cam on",
      "cam on",
      "cam on me",
      "cam on co",
      "con cam on nhieu",
    ],
    anyKeywords: ["cam on"],
    minScore: 0.7,
  },
  {
    intent: "sorry",
    english: "I'm sorry.",
    samples: ["con xin loi", "xin loi", "loi con", "con sai roi"],
    anyKeywords: ["xin loi", "loi con"],
    minScore: 0.7,
  },
  {
    intent: "hello",
    english: "Hello.",
    samples: ["xin chao", "chao co", "chao thay", "hello"],
    anyKeywords: ["xin chao", "chao", "hello"],
    minScore: 0.75,
  },
  {
    intent: "goodbye",
    english: "Goodbye.",
    samples: ["tam biet", "bye bye", "con chao tam biet"],
    anyKeywords: ["tam biet", "bye"],
    minScore: 0.75,
  },
  {
    intent: "want_drink",
    english: "I want a drink.",
    samples: ["con muon uong", "muon uong gi do", "cho con uong"],
    anyKeywords: ["muon uong", "cho con uong"],
    blockedKeywords: ["thuoc", "khong muon uong", "khong uong"],
    minScore: 0.8,
  },
  {
    intent: "hungry_fuzzy",
    english: "I'm hungry.",
    samples: ["doi qua", "doi bung qua", "an me oi", "con muon an gi do"],
    anyKeywords: ["doi bung", "con doi", "dang doi", "an me oi", "muon an"],
    blockedKeywords: ["an kem", "kem"],
    minScore: 0.8,
  },
  {
    intent: "ice_cream_fuzzy",
    english: "I want some ice cream.",
    samples: ["con muon an kem", "an kem duoc khong", "kem me oi"],
    anyKeywords: ["an kem", "kem"],
    minScore: 0.8,
  },
  {
    intent: "bathroom_fuzzy",
    english: "I need to go to the bathroom.",
    samples: ["con muon di ve sinh", "mac tieu", "buon tieu", "di toilet"],
    anyKeywords: ["ve sinh", "mac tieu", "buon tieu", "toilet"],
    minScore: 0.75,
  },
  {
    intent: "window_near_fuzzy",
    english: "I want to stand near the window.",
    samples: [
      "con muon dung gan cua so",
      "dung gan cua so",
      "gan cua so",
      "ra gan cua so",
    ],
    anyKeywords: ["gan cua so"],
    minScore: 0.75,
  },
  {
    intent: "photo_with_statue_fuzzy",
    english: "Mom, please take a picture of me with that statue.",
    samples: [
      "me chup cho con voi buc tuong kia",
      "chup cho con voi buc tuong",
      "chup voi buc tuong kia",
      "chup hinh voi buc tuong",
    ],
    anyKeywords: [
      "chup cho con voi buc tuong",
      "chup voi buc tuong",
      "chup hinh voi buc tuong",
    ],
    minScore: 0.75,
  },
  {
    intent: "see_statue_fuzzy",
    english: "I want to see that statue.",
    samples: [
      "con muon nhin buc tuong kia",
      "nhin buc tuong kia",
      "xem buc tuong kia",
      "buc tuong dep qua",
    ],
    anyKeywords: ["nhin buc tuong", "xem buc tuong", "buc tuong dep"],
    minScore: 0.75,
  },
  {
    intent: "yellow_fish_fuzzy",
    english: "I want to see that yellow fish.",
    samples: [
      "con muon xem con ca mau vang kia",
      "con muon nhin con ca mau vang kia",
      "xem con ca mau vang kia",
      "nhin con ca mau vang",
    ],
    anyKeywords: ["ca mau vang", "con ca mau vang"],
    minScore: 0.75,
  },
  {
    intent: "airplane_sky_fuzzy",
    english: "I want to see the airplane in the sky.",
    samples: [
      "con muon nhin may bay tren troi",
      "con muon nhin cai may bay tren troi",
      "nhin may bay tren troi",
      "xem may bay tren troi",
      "may bay tren troi",
    ],
    anyKeywords: ["may bay"],
    blockedKeywords: ["nhin thay", "con thay"],
    minScore: 0.75,
  },
  {
    intent: "why_dark_fast_fuzzy",
    english: "Mom, why does it get dark so fast?",
    samples: [
      "me oi sao troi toi nhanh vay",
      "sao troi toi nhanh vay",
      "tai sao troi toi nhanh vay",
      "troi toi nhanh qua",
    ],
    anyKeywords: ["troi toi"],
    minScore: 0.75,
  },
  {
    intent: "elevator_fuzzy",
    english: "Can we take the elevator?",
    samples: [
      "me oi minh co the di thang may duoc khong",
      "minh co the di thang may duoc khong",
      "di thang may duoc khong",
      "con muon di thang may",
    ],
    anyKeywords: ["thang may"],
    minScore: 0.75,
  },
  {
    intent: "photo_with_me_fuzzy",
    english: "Please take a picture of me.",
    samples: ["chup cho con", "chup hinh cho con", "chup voi con"],
    anyKeywords: ["chup cho con", "chup hinh cho con", "chup voi con"],
    minScore: 0.75,
  },
  {
    intent: "repeat_please",
    english: "Can you say that again, please?",
    samples: ["noi lai di", "con khong nghe ro", "nhac lai di"],
    anyKeywords: ["noi lai", "khong nghe ro", "nhac lai"],
    minScore: 0.75,
  },
];

export const semanticIntentRules: Record<PracticeContext, SemanticIntentRule[]> = {
  home: [
    ...sharedSemanticIntentRules,
    {
      intent: "story_fuzzy",
      english: "Mom, please read me a story.",
      samples: ["doc truyen di", "me doc truyen", "ke truyen cho con"],
      anyKeywords: ["doc truyen", "ke truyen"],
      minScore: 0.75,
    },
    {
      intent: "cartoon_fuzzy",
      english: "I want to watch cartoons.",
      samples: ["xem phim hoat hinh", "xem hoat hinh", "bat phim cho con"],
      anyKeywords: ["phim hoat hinh", "xem hoat hinh", "xem phim"],
      minScore: 0.75,
    },
    {
      intent: "play_with_parent_fuzzy",
      english: "Please play with me.",
      samples: ["choi voi con", "bo choi voi con", "me choi voi con"],
      anyKeywords: ["choi voi con", "bo choi", "me choi"],
      minScore: 0.75,
    },
    {
      intent: "this_one_fuzzy",
      english: "I want this one.",
      samples: ["con muon cai nay", "lay cai nay", "cai nay me oi"],
      anyKeywords: ["cai nay"],
      minScore: 0.8,
    },
    {
      intent: "that_one_fuzzy",
      english: "I want that one.",
      samples: ["con muon cai kia", "lay cai kia", "cai kia me oi"],
      anyKeywords: ["cai kia"],
      minScore: 0.8,
    },
    {
      intent: "hug_fuzzy",
      english: "I need a hug.",
      samples: ["om con", "me om con", "con can om"],
      anyKeywords: ["om con", "can om"],
      blockedKeywords: ["bi om"],
      minScore: 0.75,
    },
  ],
  school: [
    ...sharedSemanticIntentRules,
    {
      intent: "teacher_help_fuzzy",
      english: "Teacher, I need help, please.",
      samples: ["co oi giup con", "thay oi giup con", "con can co giup"],
      anyKeywords: ["co oi", "thay oi", "giup con"],
      minScore: 0.75,
    },
    {
      intent: "pencil_fuzzy",
      english: "I need a pencil, please.",
      samples: ["con can but", "cho con muon but", "but chi dau"],
      anyKeywords: ["but", "but chi"],
      minScore: 0.8,
    },
    {
      intent: "friend_problem_fuzzy",
      english: "My friend took my thing.",
      samples: ["ban lay do cua con", "ban giu do con", "ban khong tra do"],
      anyKeywords: ["ban lay", "giu do", "khong tra do"],
      minScore: 0.75,
    },
    {
      intent: "cant_do_fuzzy",
      english: "I can't do it yet.",
      samples: ["con khong lam duoc", "kho qua con khong lam duoc"],
      anyKeywords: ["khong lam duoc", "kho qua"],
      minScore: 0.75,
    },
  ],
  outside: [
    ...sharedSemanticIntentRules,
    {
      intent: "water_park_fuzzy",
      english: "Can we go to the water park?",
      samples: [
        "con muon di cong vien nuoc",
        "di cong vien nuoc",
        "cho con di cong vien nuoc",
      ],
      anyKeywords: ["cong vien nuoc"],
      minScore: 0.75,
    },
    {
      intent: "where_go_fuzzy",
      english: "Where are we going today?",
      samples: ["hom nay di dau", "minh di dau vay", "di choi dau"],
      anyKeywords: ["di dau", "di choi dau"],
      minScore: 0.75,
    },
    {
      intent: "take_photo_fuzzy",
      english: "I want to take a picture.",
      samples: ["chup anh me oi", "con muon chup anh", "chup hinh cho con"],
      anyKeywords: ["chup anh", "chup hinh"],
      minScore: 0.75,
    },
    {
      intent: "see_robot_fuzzy",
      english: "I want to see the robot.",
      samples: ["con muon xem con robot", "xem con robot", "xem robot kia"],
      anyKeywords: ["xem con robot", "xem robot"],
      minScore: 0.75,
    },
    {
      intent: "buy_fuzzy",
      english: "Can we buy this?",
      samples: ["mua cai nay duoc khong", "con muon mua cai nay", "mua cho con"],
      anyKeywords: ["muon mua", "mua cai nay", "mua cho con"],
      minScore: 0.75,
    },
    {
      intent: "lost_mom_fuzzy",
      english: "I can't see Mom.",
      samples: ["me dau roi", "con khong thay me", "lac me roi"],
      anyKeywords: ["me dau", "khong thay me", "lac me"],
      minScore: 0.75,
    },
    {
      intent: "crowd_scared_fuzzy",
      english: "There are too many people. I'm scared.",
      samples: ["dong nguoi qua con so", "nhieu nguoi qua", "con so dong nguoi"],
      anyKeywords: ["dong nguoi", "nhieu nguoi"],
      minScore: 0.75,
    },
  ],
};

function containsKeyword(normalizedText: string, keyword: string) {
  const normalizedKeyword = normalizeVietnamese(keyword);
  return ` ${normalizedText} `.includes(` ${normalizedKeyword} `);
}

function hasBlockedKeyword(
  normalizedText: string,
  blockedKeywords: string[] = [],
) {
  return blockedKeywords.some((keyword) =>
    containsKeyword(normalizedText, keyword),
  );
}

function hasAnyKeyword(normalizedText: string, anyKeywords: string[] = []) {
  if (anyKeywords.length === 0) {
    return true;
  }

  return anyKeywords.some((keyword) => containsKeyword(normalizedText, keyword));
}

function getMeaningfulTokens(text: string) {
  return normalizeVietnamese(text)
    .split(" ")
    .filter((token) => token && !fillerTokens.has(token));
}

function scoreSample(normalizedText: string, sample: string) {
  const normalizedSample = normalizeVietnamese(sample);

  if (
    normalizedSample.length >= 6 &&
    (normalizedText.includes(normalizedSample) ||
      normalizedSample.includes(normalizedText))
  ) {
    return 1;
  }

  const inputTokens = getMeaningfulTokens(normalizedText);
  const sampleTokens = getMeaningfulTokens(sample);

  if (inputTokens.length === 0 || sampleTokens.length === 0) {
    return 0;
  }

  const inputSet = new Set(inputTokens);
  const intersection = sampleTokens.filter((token) => inputSet.has(token));

  return intersection.length / Math.min(inputTokens.length, sampleTokens.length);
}

function scoreRule(normalizedText: string, rule: SemanticIntentRule) {
  const inputTokens = new Set(normalizedText.split(" "));
  const keywordTokens = new Set(
    (rule.anyKeywords ?? []).flatMap((keyword) =>
      normalizeVietnamese(keyword).split(" "),
    ),
  );

  if (
    ["khong", "chua"].some(
      (token) => inputTokens.has(token) && !keywordTokens.has(token),
    ) ||
    hasBlockedKeyword(normalizedText, rule.blockedKeywords) ||
    !hasAnyKeyword(normalizedText, rule.anyKeywords)
  ) {
    return null;
  }

  const scoredSamples = rule.samples.map((sample) => ({
    sample,
    score: scoreSample(normalizedText, sample),
  }));
  const bestSample = scoredSamples.sort((a, b) => b.score - a.score)[0];

  if (!bestSample || bestSample.score < (rule.minScore ?? 0.8)) {
    return null;
  }

  return {
    intent: rule.intent,
    englishText: rule.english,
    score: bestSample.score,
    sample: bestSample.sample,
  } satisfies SemanticIntentMatch;
}

export function findSemanticIntent(
  vietnameseText: string,
  context: PracticeContext,
) {
  const normalizedText = normalizeVietnamese(vietnameseText);

  if (!normalizedText) {
    return null;
  }

  const matches = semanticIntentRules[context]
    .map((rule) => scoreRule(normalizedText, rule))
    .filter((match): match is SemanticIntentMatch => Boolean(match))
    .sort((a, b) => b.score - a.score);

  return matches[0] ?? null;
}

export function getSemanticIntentAudioTexts(context: PracticeContext) {
  return [
    ...new Set(semanticIntentRules[context].map((rule) => rule.english)),
  ];
}
