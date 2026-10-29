import { stripJosa } from "./titles.ts";

// Text for the search index and the queries against it, Korean first and without any model.
//
// Two FTS5 tables hold every entry (search-index.ts):
//   search_words — a token stream built here: Hangul (and other CJK) runs as overlapping
//     two-character pairs ("채점기준" → 채점 점기 기준; a lone syllable stays as it is), every
//     other run of letters or digits as one lower-case word. A two-character Korean word is then
//     one token with its own bm25 weight, a longer one a phrase of pairs (the same as a substring
//     inside a run), and a split ("채점 기준") is a phrase of the parts, so spacing never decides.
//   search_text — the text itself, trigram-tokenised: substrings of three or more characters of
//     other scripts ("wright" in "playwright-cli"), and LIKE for what is left (one syllable).

/** Scripts written without spaces inside words: indexed as character pairs. */
const PAIRED = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const RUN = /[\p{L}\p{N}\p{M}]+/gu;
const SEGMENT = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

/** How search compares text: composed Unicode, lower case. */
export const fold = (text: string) => text.normalize("NFC").toLowerCase();

/** The tokens of a piece of text for search_words, in order. */
export function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const run of fold(text).matchAll(RUN)) {
    for (const segment of run[0].match(SEGMENT) ?? []) {
      if (!PAIRED.test(segment)) {
        out.push(segment);
        continue;
      }
      const characters = [...segment];
      if (characters.length === 1) out.push(segment);
      else for (let index = 0; index + 1 < characters.length; index += 1) out.push(characters[index]! + characters[index + 1]!);
    }
  }
  return out;
}

/** search_words' text for a field: its tokens joined by spaces (what unicode61 splits again). */
export const wordStream = (text: string) => wordTokens(text).join(" ");

/** One part of a query: a word, or a "quoted phrase". All parts must match (AND). */
export type QueryPart = {
  /** As typed. */
  raw: string;
  /** What is searched for: folded, Korean particle taken off ("기준을" → "기준"). */
  term: string;
  quoted: boolean;
  /** search_words alternatives (FTS5 phrases, any one may match), or empty. */
  words: string[];
  /** A search_text phrase (substring of 3+ characters), or null. */
  text: string | null;
  /** A LIKE needle when no index can take the part (a single syllable), or null. */
  like: string | null;
  /** Strings to mark in snippets (the term and the parts of a split). */
  needles: string[];
};

export type ParsedQuery = {
  parts: QueryPart[];
  /** search_words phrases for "the words as typed, together" (also joined): ranked higher, not required. */
  phrase: string[];
  /** Every string to mark in snippets. */
  needles: string[];
};

const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
const phraseOf = (tokens: string[], prefix = false) => (tokens.length ? `${quote(tokens.join(" "))}${prefix ? " *" : ""}` : null);
const onlyPaired = (text: string) => [...text].every((character) => PAIRED.test(character));
const hasPaired = (text: string) => PAIRED.test(text);
const plainWord = (text: string) => /^[\p{L}\p{N}\p{M}]+$/u.test(text);

/** Longest Korean word that is still split into two-part alternatives (longer ones are taken as typed). */
const MAX_SPLIT = 12;

/**
 * A run of paired-script characters as alternatives: the run itself, and each way to split it in
 * two where the left part has two or more characters ("채점기준" also finds "채점 기준", "기준표"
 * also "기준 표를" through a prefix token).
 */
function pairedAlternatives(term: string): { words: string[]; needles: string[] } {
  const characters = [...term];
  const words = [phraseOf(wordTokens(term))!];
  const needles = [term];
  if (characters.length >= 3 && characters.length <= MAX_SPLIT) {
    for (let at = 2; at < characters.length; at += 1) {
      const left = characters.slice(0, at).join("");
      const right = characters.slice(at).join("");
      words.push(phraseOf([...wordTokens(left), ...wordTokens(right)], right.length === 1)!);
      needles.push(left, right);
    }
  }
  return { words: [...new Set(words)], needles: [...new Set(needles)] };
}

/** One part of a query in the indexes it can use. */
function part(raw: string, quoted: boolean): QueryPart | null {
  const folded = fold(raw).trim();
  if (!folded) return null;
  if (quoted) {
    // As typed, together: a phrase of word tokens (spacing and punctuation between words do not matter).
    const tokens = wordTokens(folded);
    if (tokens.length) return { raw, term: folded, quoted, words: [phraseOf(tokens)!], text: null, like: null, needles: [folded, ...folded.split(/\s+/).filter((word) => word.length > 1)] };
    return [...folded].length >= 3 ? { raw, term: folded, quoted, words: [], text: quote(folded), like: null, needles: [folded] } : { raw, term: folded, quoted, words: [], text: null, like: folded, needles: [folded] };
  }
  // Punctuation around a word is not part of it ("기준," "(초안)").
  const trimmed = folded.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || folded;
  const term = hasPaired(trimmed) && plainWord(trimmed) ? stripJosa(trimmed) || trimmed : trimmed;
  const length = [...term].length;
  if (plainWord(term)) {
    if (onlyPaired(term)) {
      if (length === 1) return { raw, term, quoted, words: [], text: null, like: term, needles: [term] };
      const { words, needles } = pairedAlternatives(term);
      return { raw, term, quoted, words, text: null, like: null, needles };
    }
    if (!hasPaired(term)) {
      // Other scripts: three or more characters as a substring (trigram), shorter ones as a word.
      if (length >= 3) return { raw, term, quoted, words: [], text: quote(term), like: null, needles: [term] };
      return { raw, term, quoted, words: [phraseOf([term])!], text: null, like: null, needles: [term] };
    }
    // Mixed ("3주차", "AI교육", "mcp서버"): its script runs as a phrase, joined or spaced alike.
    const segments = term.match(SEGMENT) ?? [term];
    return { raw, term, quoted, words: [phraseOf(wordTokens(term))!], text: null, like: null, needles: [term, ...segments.filter((segment) => [...segment].length > 1)] };
  }
  // With symbols inside ("gpt-5", "c++", "#ai_교육"): a substring when long enough.
  if (length >= 3) return { raw, term, quoted, words: [], text: quote(term), like: null, needles: [term] };
  const tokens = wordTokens(term);
  if (tokens.length) return { raw, term, quoted, words: [phraseOf(tokens)!], text: null, like: null, needles: [term] };
  return { raw, term, quoted, words: [], text: null, like: term, needles: [term] };
}

/** Words of a query: spaces split, "double quotes" keep a phrase. At most eight parts. */
export function splitQuery(query: string): { raw: string; quoted: boolean }[] {
  return [...query.trim().matchAll(/"([^"]*)"|(\S+)/g)]
    .map((match) => (match[1] !== undefined ? { raw: match[1].trim(), quoted: true } : { raw: match[2]!.trim(), quoted: false }))
    .filter((entry) => entry.raw)
    .slice(0, 8)
    .map((entry) => ({ ...entry, raw: entry.raw.slice(0, 120) }));
}

/** A query as the indexes take it (see the top of this file). */
export function parseQuery(query: string): ParsedQuery {
  const words = splitQuery(query);
  const parts = words.map((word) => part(word.raw, word.quoted)).filter((entry): entry is QueryPart => entry !== null);
  const needles = new Set(parts.flatMap((entry) => entry.needles));
  // Two or more words: the same words together (as typed, or written as one) rank higher.
  const phrase: string[] = [];
  const plain = words.filter((word) => !word.quoted);
  if (plain.length >= 2 && plain.length === words.length) {
    const typed = phraseOf(wordTokens(plain.map((word) => word.raw).join(" ")));
    const joined = phraseOf(wordTokens(plain.map((word) => fold(word.raw)).join("")));
    for (const entry of [typed, joined]) if (entry && !phrase.includes(entry)) phrase.push(entry);
    // Adjacent short Korean words written as one ("채점 기준" → "채점기준") are marked as such.
    for (let index = 0; index + 1 < parts.length; index += 1) {
      const [a, b] = [parts[index]!, parts[index + 1]!];
      if (onlyPaired(a.term) && onlyPaired(b.term)) needles.add(`${a.term}${b.term}`);
    }
  }
  return { parts, phrase, needles: [...needles].filter(Boolean).sort((a, b) => b.length - a.length) };
}

/** The FTS5 expression for search_words (every part with word alternatives), or null. */
export function wordsExpression(parts: QueryPart[]): string | null {
  const used = parts.filter((entry) => entry.words.length);
  if (!used.length) return null;
  return used.map((entry) => (entry.words.length === 1 ? entry.words[0]! : `(${entry.words.join(" OR ")})`)).join(" AND ");
}

/** The FTS5 expression for search_text (substring parts), or null. */
export function textExpression(parts: QueryPart[]): string | null {
  const used = parts.filter((entry) => entry.text);
  return used.length ? used.map((entry) => entry.text!).join(" AND ") : null;
}

/** A LIKE pattern for a needle (`%`, `_` and the escape character taken literally). */
export const likePattern = (needle: string) => `%${needle.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/** A short stretch of text around the first match, with every match marked (overlaps merged). */
export function snippetOf(text: string, needles: string[], width = 140): { snippet: string; ranges: [number, number][] } {
  const flat = text.replace(/```[a-zA-Z0-9_-]*/g, " ").replace(/\s+/g, " ").trim().normalize("NFC");
  const lower = flat.toLowerCase();
  const wanted = needles.map((needle) => needle.toLowerCase()).filter(Boolean);
  const first = Math.min(...wanted.map((needle) => lower.indexOf(needle)).filter((index) => index >= 0), flat.length);
  let start = first >= flat.length ? 0 : Math.max(0, first - Math.floor(width / 3));
  if (start > 0) {
    const space = flat.lastIndexOf(" ", start);
    if (space > start - 12) start = space + 1;
  }
  let end = Math.min(flat.length, start + width);
  if (end < flat.length) {
    const space = flat.indexOf(" ", end);
    if (space !== -1 && space < end + 12) end = space;
  }
  const prefix = start > 0 ? "…" : "";
  const snippet = `${prefix}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  const lowerSnippet = snippet.toLowerCase();
  const found: [number, number][] = [];
  for (const needle of wanted) {
    for (let at = lowerSnippet.indexOf(needle); at !== -1; at = lowerSnippet.indexOf(needle, at + needle.length)) found.push([at, at + needle.length]);
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const ranges: [number, number][] = [];
  for (const range of found) {
    const last = ranges.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  }
  return { snippet, ranges };
}

/** Whether any needle occurs in a text (case and composition folded). */
export const mentions = (text: string, needles: string[]) => {
  const lower = fold(text);
  return needles.some((needle) => needle && lower.includes(needle));
};
