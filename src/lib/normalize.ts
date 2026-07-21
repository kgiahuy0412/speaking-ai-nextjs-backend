const tokenRepairs: Record<string, string> = {
  bc: "buc",
  chp: "chup",
  ci: "cai",
  duc: "duoc",
  khng: "khong",
  mnh: "minh",
  mun: "muon",
  my: "may",
  nhn: "nhin",
  qu: "qua",
  s: "so",
  th: "the",
  thy: "thay",
  tri: "troi",
  trn: "tren",
  tung: "tuong",
  vi: "voi",
};

function repairKnownCorruption(text: string) {
  return text
    .replace(/mu(?:\?|ï¿½|�)n/gi, "muon")
    .replace(/m(?:\?|ï¿½|�)nh/gi, "minh")
    .replace(/m(?:\?|ï¿½|�)y/gi, "may")
    .replace(/kh(?:\?|ï¿½|�)ng/gi, "khong")
    .replace(/ch(?:\?|ï¿½|�)p/gi, "chup")
    .replace(/t(?:\?|ï¿½|�)ng/gi, "tuong")
    .replace(/tr(?:\?|ï¿½|�)i/gi, "troi")
    .replace(/c(?:\?|ï¿½|�)(?=\s|$)/gi, "co")
    .replace(/th(?:\?|ï¿½|�)(?=\s|$)/gi, "the");
}

const windows1252Bytes = new Map<string, number>([
  ["€", 0x80],
  ["‚", 0x82],
  ["ƒ", 0x83],
  ["„", 0x84],
  ["…", 0x85],
  ["†", 0x86],
  ["‡", 0x87],
  ["ˆ", 0x88],
  ["‰", 0x89],
  ["Š", 0x8a],
  ["‹", 0x8b],
  ["Œ", 0x8c],
  ["Ž", 0x8e],
  ["‘", 0x91],
  ["’", 0x92],
  ["“", 0x93],
  ["”", 0x94],
  ["•", 0x95],
  ["–", 0x96],
  ["—", 0x97],
  ["˜", 0x98],
  ["™", 0x99],
  ["š", 0x9a],
  ["›", 0x9b],
  ["œ", 0x9c],
  ["ž", 0x9e],
  ["Ÿ", 0x9f],
]);

function decodeUtf8Mojibake(text: string) {
  if (!/(?:Ã|Â|Ä|Æ|áº|á»|ï¿½)/.test(text)) {
    return text;
  }

  const bytes: number[] = [];

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const byte = windows1252Bytes.get(character);

    if (byte !== undefined) {
      bytes.push(byte);
    } else if (codePoint <= 0xff) {
      bytes.push(codePoint);
    } else {
      return text;
    }
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return text;
  }
}

function repairCommonEncodingLoss(normalizedText: string) {
  const tokens = normalizedText.split(" ");

  return tokens
    .map((token, index) => {
      const nextToken = tokens[index + 1];

      if (
        token === "m" &&
        ["chp", "chup", "mnh", "minh", "oi"].includes(nextToken)
      ) {
        return "me";
      }

      if (token === "c" && nextToken === "th") {
        return "co";
      }

      return tokenRepairs[token] ?? token;
    })
    .join(" ");
}

export function normalizeVietnamese(text: string) {
  const normalizedText = repairKnownCorruption(decodeUtf8Mojibake(text))
    .toLowerCase()
    .replace(/[\u0111\u0110]/g, "d")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  return repairCommonEncodingLoss(normalizedText);
}
