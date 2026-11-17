/**
 * Korean particles after a name the app inserts (audit #10): 이/가, 을/를, 은/는, 와/과, (으)로 chosen by
 * how the word is read aloud. A Hangul syllable by its final consonant; a digit as read in Korean
 * (영 일 이 삼 사 오 육 칠 팔 구; 10, 100… end in 십, 백, 천, 만 — all with a final consonant like 영);
 * Latin letters where their Korean reading is well defined: a short abbreviation or file extension
 * letter by letter (PDF 피디에프, MD 엠디), a few names the app shows (Claude 클로드, Slack 슬랙…).
 * Anything else gets the written-out form: "(이)가", "을(를)", "은(는)", "와(과)", "(으)로".
 * Closing quotes and brackets after the word (「…」, (…), "…") are looked through.
 */
export type ParticlePair = "이/가" | "을/를" | "은/는" | "와/과" | "으로/로";

/** null: no final consonant; "ㄹ": final ㄹ (takes 로, not 으로); "other": any other final consonant. */
type Final = null | "ㄹ" | "other";

/** Letters read one by one: does the letter's Korean name end in a consonant (엘 엠 엔 알)? */
const LETTER_FINAL: Record<string, Final> = { l: "ㄹ", m: "other", n: "other", r: "ㄹ" };
/** Digits as read in Korean: 영(ㅇ) 일(ㄹ) 이 삼(ㅁ) 사 오 육(ㄱ) 칠(ㄹ) 팔(ㄹ) 구. */
const DIGIT_FINAL: Record<string, Final> = { "0": "other", "1": "ㄹ", "3": "other", "6": "other", "7": "ㄹ", "8": "ㄹ" };
/** Names the app shows whose Korean reading is settled (lower case). */
const WORD_FINAL: Record<string, Final> = {
  claude: null, codex: null, gemini: null, telegram: "other", slack: "other", workbench: null, dropbox: null,
  github: null, google: "ㄹ", word: null, excel: "ㄹ", powerpoint: null, obsidian: "other", notion: "other",
  chrome: "other", tailscale: "ㄹ", zotero: null, paseo: null, doory: null, git: null, ieumoffice: null,
  // Telegram bot names must end in "bot" (봇): @wb_class_bot을.
  bot: "other",
};
const CLOSERS = /[\s」』)\]}>"'”’`.,!?…·]+$/u;

function finalOf(word: string): Final | undefined {
  const text = word.replace(CLOSERS, "");
  const last = [...text].at(-1);
  if (!last) return undefined;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return jong === 0 ? null : jong === 8 ? "ㄹ" : "other";
  }
  if (/[0-9]/.test(last)) return DIGIT_FINAL[last] ?? null;
  const token = /[A-Za-z]+$/.exec(text)?.[0];
  if (!token) return undefined;
  const lower = token.toLowerCase();
  if (lower in WORD_FINAL) return WORD_FINAL[lower];
  // An extension (after a dot) or an abbreviation in capitals, up to five letters: read letter by letter.
  const extension = text.length > token.length && text[text.length - token.length - 1] === ".";
  if ((extension || token === token.toUpperCase()) && token.length <= 5) return LETTER_FINAL[lower.at(-1)!] ?? null;
  return undefined;
}

const UNKNOWN: Record<ParticlePair, string> = { "이/가": "(이)가", "을/를": "을(를)", "은/는": "은(는)", "와/과": "와(과)", "으로/로": "(으)로" };

/** [after a final consonant, after none] */
const FORMS: Record<Exclude<ParticlePair, "으로/로">, [string, string]> = { "이/가": ["이", "가"], "을/를": ["을", "를"], "은/는": ["은", "는"], "와/과": ["과", "와"] };

/** The particle alone that follows `word`. */
export function particle(word: string, pair: ParticlePair): string {
  const final = finalOf(word);
  if (final === undefined) return UNKNOWN[pair];
  if (pair === "으로/로") return final === null || final === "ㄹ" ? "로" : "으로";
  const [withFinal, without] = FORMS[pair];
  return final === null ? without : withFinal;
}

/** `word` followed by its particle: withParticle("강의안", "을/를") → "강의안을". */
export function withParticle(word: string, pair: ParticlePair): string {
  return `${word}${particle(word, pair)}`;
}
