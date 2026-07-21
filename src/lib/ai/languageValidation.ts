const unexpectedEastAsianScript =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function containsUnexpectedEastAsianScript(text: string) {
  return unexpectedEastAsianScript.test(text);
}
