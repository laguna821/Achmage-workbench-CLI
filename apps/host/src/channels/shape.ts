// What the channel reads from a chat line and how it shapes an answer for a small screen.

export type Command =
  | { command: "menu" | "stop" | "new" | "status" | "lock" }
  | { command: "start"; value: string };

const WORDS: Record<string, "menu" | "stop" | "new" | "status" | "lock"> = {
  "메뉴": "menu", "/menu": "menu",
  "멈춰": "stop", "정지": "stop", "stop": "stop", "/stop": "stop",
  "새 대화": "new", "/new": "new",
  "상태": "status",
  "잠금": "lock",
};

/**
 * A command only when the line is exactly that word; inside a sentence the same word is for the
 * AI. `/start <value>` is the pairing link opened on the phone.
 */
export function parseCommand(raw: string): Command | null {
  // Telegram adds the bot's name to a command picked from its menu.
  const line = raw.trim().replace(/^(\/[a-z]+)@[A-Za-z0-9_]+/, "$1");
  const start = /^\/start(?:\s+([A-Za-z0-9_-]{1,64}))?$/.exec(line);
  if (start) return { command: "start", value: start[1] ?? "" };
  const word = WORDS[line] ?? WORDS[line.toLowerCase()];
  return word ? { command: word } : null;
}

const CHOICE_LINE = /(?:^|\n)[ \t]*\[\[선택:\s*([^\]\n]+)\]\][ \t]*$/;
const CHOICE_LABEL = 12;

/** `[[선택: 가 | 나]]` as the last line of an answer: taken off, its two to four choices returned. */
export function takeChoices(raw: string): { text: string; choices: string[] } {
  const trimmed = raw.replace(/\s+$/, "");
  const match = CHOICE_LINE.exec(trimmed);
  if (!match) return { text: raw, choices: [] };
  const choices = match[1]!.split("|").map((choice) => choice.trim()).filter(Boolean);
  if (choices.length < 2 || choices.length > 4) return { text: raw, choices: [] };
  return {
    text: trimmed.slice(0, match.index).replace(/\s+$/, ""),
    choices,
  };
}

// Made when first needed, not when the module loads: a runtime without Intl.Segmenter must still
// load the gateway (this module is imported by the store). Without it, cuts fall back to code points.
let graphemes: Intl.Segmenter | null | undefined;
const segmenter = () => {
  if (graphemes === undefined) graphemes = typeof Intl === "object" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  return graphemes;
};

/**
 * The longest opening of `text` that fits in `limit` UTF-16 units (how Telegram counts) and ends
 * where a character ends: never between the halves of a surrogate pair, inside a combining
 * sequence, a ZWJ-joined emoji or a flag. One character longer than the limit by itself is cut
 * at a code point instead. Every cut of text that leaves the PC goes through here.
 */
export function cutAt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return "";
  const segments = segmenter();
  if (segments) {
    let end = 0;
    for (const { index } of segments.segment(text)) {
      if (index > limit) break;
      end = index;
    }
    if (end > 0) return text.slice(0, end);
  }
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

/**
 * A choice on its button: at most twelve characters. When it had to be shortened, the chat is
 * shown the whole choice once it is pressed (it is the whole choice that gets sent).
 */
export const choiceLabel = (choice: string) => (choice.length > CHOICE_LABEL ? `${cutAt(choice, CHOICE_LABEL)}…` : choice);

export const ANSWER_LIMIT = 900;

/**
 * An answer as the chat shows it: whole up to 900 characters; a longer one by its opening
 * paragraphs (`more`: the rest is offered behind a button), with its choice line taken off.
 */
export function shapeAnswer(raw: string, limit = ANSWER_LIMIT): { text: string; more: boolean; choices: string[] } {
  const { text: body, choices } = takeChoices(raw);
  const text = body.trim();
  if (!text) return { text: "끝났습니다. (AI가 남긴 말이 없습니다)", more: false, choices };
  if (text.length <= limit) return { text, more: false, choices };
  const paragraphs = text.split(/\n{2,}/);
  let head = "";
  for (const paragraph of paragraphs) {
    const next = head ? `${head}\n\n${paragraph}` : paragraph;
    if (next.length > limit) break;
    head = next;
  }
  if (head) return { text: head, more: true, choices };
  // One long paragraph: cut at a line or sentence end when the cut keeps most of it.
  const cut = cutAt(text, limit);
  const end = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". ") + 1, cut.lastIndexOf("다. ") + 2);
  return { text: `${(end > limit / 2 ? cut.slice(0, end) : cut).replace(/\s+$/, "")}…`, more: true, choices };
}

/** Elapsed time as the status line shows it: minutes and seconds. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
