import { cutAt } from "./shape.ts";
import type { Mark } from "./types.ts";

// The engines write markdown; a phone shows formatting, not stars. This turns markdown into the
// text a person reads plus marks over it (offsets in UTF-16 units, as JavaScript strings count and
// as Telegram's entities count). It never fails, and it never changes content: a sign goes only
// when it is the markup of something it then shows formatted; everything else stays as written
// (`_` and `~` are never formatting, a backslash is kept, a table or fence it is unsure of is text).
// Each messenger shows the marks its own way (Telegram as entities; one that cannot, as plain text).
//
// The rules a mark set keeps are the strictest of the messengers the channel speaks (Telegram's):
// marks never cross, bold / italic / strike may sit inside or around anything but code, and code,
// links and quotes never sit inside one another.

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
// What a star touches when it is data, not emphasis: a path or a glob (a star after a slash), a power or a
// product (two stars or one between ASCII letters and digits), a pointer.
const GLUE = /[A-Za-z0-9/\\]/;
const STYLE = new Set<Mark["type"]>(["bold", "italic", "strike"]);
const CODE = new Set<Mark["type"]>(["code", "pre"]);
/** Telegram takes at most this many formatted stretches in one message (to confirm on a real bot); the rest show plain. */
export const MAX_MARKS = 100;
const LINK = /^(?:https?:\/\/|mailto:|tg:\/\/)\S+$/i;
const LANGUAGE = /^[\w+#.-]{1,32}$/;

class Out {
  text = "";
  marks: Mark[] = [];
  add(text: string) { this.text += text; }
  /** `sign`: the markup the mark stands for, written back if the messenger cannot take the mark. */
  mark(type: Mark["type"], from: number, extra: { url?: string; language?: string; sign?: string } = {}) {
    if (this.text.length > from) this.marks.push({ type, offset: from, length: this.text.length - from, ...extra });
  }
}

/** The length of the run of `char` at `at`. */
function run(src: string, at: number, end: number, char: string) {
  let next = at;
  while (next < end && src[next] === char) next += 1;
  return next - at;
}

/** Where a code span opened at `at` with `size` backticks closes, or -1. */
function codeEnd(src: string, at: number, end: number, size: number) {
  for (let next = at; next < end;) {
    if (src[next] !== "`") { next += 1; continue; }
    const length = run(src, next, end, "`");
    if (length === size) return next;
    next += length;
  }
  return -1;
}

/** Inline markdown of `src[from, to)` into `out`. */
function inline(src: string, from: number, to: number, out: Out) {
  let at = from;
  while (at < to) {
    const char = src[at]!;
    // A backslash is kept (Windows paths); the sign after it is never markup.
    if (char === "\\" && at + 1 < to && PUNCT.test(src[at + 1]!)) {
      out.add(src.slice(at, at + 2));
      at += 2;
      continue;
    }
    if (char === "`") {
      const size = run(src, at, to, "`");
      const close = codeEnd(src, at + size, to, size);
      if (close < 0) { out.add("`".repeat(size)); at += size; continue; }
      let content = src.slice(at + size, close);
      if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
      const start = out.text.length;
      out.add(content);
      out.mark("code", start, { sign: "`".repeat(size) });
      at = close + size;
      continue;
    }
    if (char === "[" || (char === "!" && src[at + 1] === "[")) {
      const open = char === "!" ? at + 1 : at;
      const link = linkAt(src, open, to);
      if (link) {
        const start = out.text.length;
        inline(src, open + 1, link.textEnd, out);
        out.mark("link", start, { url: link.url });
        at = link.end;
        continue;
      }
      out.add(char);
      at += 1;
      continue;
    }
    if (char === "<") {
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(at, to));
      if (auto) { out.add(auto[1]!); at += auto[0].length; continue; }
      out.add(char);
      at += 1;
      continue;
    }
    if (char === "*") {
      const size = run(src, at, to, char);
      // A single star right after a letter or digit is arithmetic or a name (2*3*4, a*b), not emphasis;
      // any run of stars right after an ASCII letter or digit, a slash or a backslash is a power, a
      // glob or a path. Hangul may touch emphasis.
      const glued = at > from && ((size !== 2 && WORD.test(src[at - 1]!)) || GLUE.test(src[at - 1]!));
      const close = size <= 3 && !glued ? closer(src, at, to, size) : -1;
      if (close < 0) { out.add(char.repeat(size)); at += size; continue; }
      const start = out.text.length;
      inline(src, at + size, close, out);
      if (size >= 2) out.mark("bold", start, { sign: "**" });
      if (size !== 2) out.mark("italic", start, { sign: "*" });
      at = close + size;
      continue;
    }
    out.add(char);
    at += 1;
  }
}

/** Where star emphasis opened at `at` with `size` stars closes, or -1. */
function closer(src: string, at: number, to: number, size: number): number {
  const char = "*";
  const after = src[at + size];
  if (after === undefined || at + size >= to || SPACE.test(after)) return -1;
  for (let next = at + size; next < to;) {
    const here = src[next]!;
    if (here === "\\") { next += 2; continue; }
    if (here === "`") {
      const length = run(src, next, to, "`");
      const end = codeEnd(src, next + length, to, length);
      next = end < 0 ? next + length : end + length;
      continue;
    }
    if (here !== char) { next += 1; continue; }
    const length = run(src, next, to, char);
    // Emphasis does not close into an ASCII word or a path (a pointer after a bracket, a glob after a slash).
    const into = next + length < to ? src[next + length]! : "";
    const closes = next > at + size && !SPACE.test(src[next - 1]!) && !GLUE.test(into);
    if (closes && length === size) return next;
    next += length;
  }
  return -1;
}

/**
 * `[text](url)` at `open`: where its text ends, the address, and where it ends. Only web, mail and
 * Telegram addresses; the address's own parentheses are kept (balanced). An address with a space
 * or a title after it is not taken: the link is shown as written.
 */
function linkAt(src: string, open: number, to: number): { textEnd: number; url: string; end: number } | null {
  let close = -1;
  for (let next = open + 1; next < to; next += 1) {
    if (src[next] === "\\") { next += 1; continue; }
    if (src[next] === "[") return null;
    if (src[next] === "]") { close = next; break; }
  }
  if (close < 0 || src[close + 1] !== "(") return null;
  let end = -1;
  for (let next = close + 2, depth = 0; next < to; next += 1) {
    if (src[next] === "(") depth += 1;
    else if (src[next] === ")") {
      if (!depth) { end = next; break; }
      depth -= 1;
    }
  }
  if (end < 0) return null;
  let url = src.slice(close + 2, end);
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
  if (!LINK.test(url) || close === open + 1) return null;
  return { textEnd: close, url, end: end + 1 };
}

/** A fence line: the run and at most one language word, no backtick after it ("```npm test```" is inline code). */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>(?!>)[ ]?(.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const NUMBERED = /^([ \t]*)(\d{1,9}[.)])[ \t]+(.*)$/;
/** A table's rule line: cells of dashes, and at least one `|` of its own (a bare `---` is a rule, not a table). */
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const isTableRule = (line: string) => line.includes("|") && line.includes("-") && TABLE_RULE.test(line);

/** The cells of a table row (a `\|` stays in its cell). */
function cells(line: string): string[] {
  const parts: string[] = [];
  let cell = "";
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] === "\\" && at + 1 < line.length) { cell += line.slice(at, at + 2); at += 1; continue; }
    if (line[at] === "|") { parts.push(cell); cell = ""; continue; }
    cell += line[at];
  }
  parts.push(cell);
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) parts.shift();
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) parts.pop();
  return parts.map((part) => part.trim());
}

const indentOf = (space: string) => Math.min(4, Math.floor(space.replace(/\t/g, "    ").length / 2));

/** Markdown as a person reads it: the text, and the marks over it. Never throws. */
export function readable(markdown: string): { text: string; marks: Mark[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out = new Out();
  let first = true;
  const line = (write: () => void) => {
    if (!first) out.add("\n");
    first = false;
    write();
  };
  const span = (text: string) => inline(text, 0, text.length, out);
  for (let at = 0; at < lines.length; at += 1) {
    const current = lines[at]!;
    const fence = FENCE.exec(current);
    if (fence) {
      const sign = fence[1]!;
      let end = at + 1;
      while (end < lines.length && !new RegExp(`^ {0,3}${sign[0] === "`" ? "`" : "~"}{${sign.length},}[ \\t]*$`).test(lines[end]!)) end += 1;
      const body = lines.slice(at + 1, end).join("\n");
      if (body.trim()) line(() => { const start = out.text.length; out.add(body); out.mark("pre", start, fence[2] && LANGUAGE.test(fence[2]) ? { language: fence[2] } : {}); });
      at = end;
      continue;
    }
    // A table: its header as a bold line, then each row as a bullet, the cells joined by " · ".
    const header = current.includes("|") && at + 1 < lines.length && isTableRule(lines[at + 1]!) ? cells(current) : [];
    if (header.length >= 2) {
      const row = (values: string[], bullet: boolean) => line(() => {
        if (bullet) out.add("• ");
        const start = out.text.length;
        values.filter(Boolean).forEach((cell, index) => { if (index) out.add(" · "); span(cell); });
        if (!bullet) out.mark("bold", start);
      });
      row(header, false);
      let end = at + 2;
      for (; end < lines.length && lines[end]!.includes("|") && lines[end]!.trim(); end += 1) row(cells(lines[end]!), true);
      at = end - 1;
      continue;
    }
    const heading = HEADING.exec(current);
    if (heading) {
      line(() => { const start = out.text.length; span(heading[2]!); out.mark("bold", start); });
      continue;
    }
    if (RULE.test(current)) {
      line(() => out.add("──────"));
      continue;
    }
    if (QUOTE.test(current)) {
      let end = at;
      const inner: string[] = [];
      for (; end < lines.length; end += 1) {
        const quoted = QUOTE.exec(lines[end]!);
        if (!quoted) break;
        inner.push(quoted[1]!);
      }
      line(() => {
        const start = out.text.length;
        inner.forEach((text, index) => { if (index) out.add("\n"); span(text); });
        out.mark("quote", start);
      });
      at = end - 1;
      continue;
    }
    const bullet = BULLET.exec(current);
    if (bullet) {
      const level = indentOf(bullet[1]!);
      line(() => { out.add(`${"  ".repeat(level)}${level ? "◦" : "•"} `); span(bullet[2]!); });
      continue;
    }
    const numbered = NUMBERED.exec(current);
    if (numbered) {
      line(() => { out.add(`${"  ".repeat(indentOf(numbered[1]!))}${numbered[2]} `); span(numbered[3]!); });
      continue;
    }
    line(() => span(current));
  }
  // Nothing it could show (an empty fence, a lone heading sign): the text as written.
  if (!out.text.trim() && markdown.trim()) return { text: markdown, marks: [] };
  return settle(out.text, out.marks);
}

/**
 * The marks the messenger takes (`tidy`). What it would drop (nested where it may not be, over the
 * limit) is written back as it was typed: a link's address after its words, the stars or backticks
 * around the rest, so a sign goes only where its formatting is shown.
 */
function settle(text: string, marks: (Mark & { sign?: string })[]): { text: string; marks: Mark[] } {
  const kept = tidy(text, marks);
  type Back = { at: number; words: string; owner: Mark; start: boolean };
  const back: Back[] = [];
  for (const mark of marks) {
    if (kept.includes(mark)) continue;
    const end = mark.offset + mark.length;
    if (mark.type === "link" && mark.url) back.push({ at: end, words: ` (${mark.url})`, owner: mark, start: false });
    else if (mark.sign) back.push({ at: mark.offset, words: mark.sign, owner: mark, start: true }, { at: end, words: mark.sign, owner: mark, start: false });
  }
  const strip = ({ sign: _sign, ...mark }: Mark & { sign?: string }): Mark => mark;
  if (!back.length) return { text, marks: kept.map(strip) };
  // At one place: what closes (inner first), then what opens (outer first).
  back.sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start) || (a.start ? b.owner.length - a.owner.length : a.owner.length - b.owner.length));
  let result = "", from = 0;
  for (const { at, words } of back) { result += text.slice(from, at) + words; from = at; }
  result += text.slice(from);
  const inside = (inner: Mark, outer: Mark) => inner.offset >= outer.offset && inner.offset + inner.length <= outer.offset + outer.length;
  const before = (place: number, here: (entry: Back) => boolean) => back.reduce((sum, entry) => sum + (entry.at < place || (entry.at === place && here(entry)) ? entry.words.length : 0), 0);
  const moved = kept.map((mark) => {
    const end = mark.offset + mark.length;
    const offset = mark.offset + before(mark.offset, (entry) => !(entry.start && inside(entry.owner, mark)));
    return { ...strip(mark), offset, length: end + before(end, (entry) => !entry.start && inside(entry.owner, mark)) - offset };
  });
  return { text: result, marks: moved };
}

/** Marks the strictest messenger accepts: none empty or over spaces only, none crossing another, nesting as allowed, at most `MAX_MARKS`. */
export function tidy(text: string, marks: Mark[]): Mark[] {
  const sorted = marks
    .filter((mark) => mark.length > 0 && mark.offset >= 0 && mark.offset + mark.length <= text.length && text.slice(mark.offset, mark.offset + mark.length).trim())
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  const kept: Mark[] = [];
  for (const mark of sorted) {
    const end = mark.offset + mark.length;
    const fits = kept.every((outer) => {
      const outerEnd = outer.offset + outer.length;
      if (outerEnd <= mark.offset || end <= outer.offset) return true;
      if (end > outerEnd) return false;
      if (outer.type === mark.type || CODE.has(outer.type) || CODE.has(mark.type)) return false;
      return STYLE.has(outer.type) || STYLE.has(mark.type);
    });
    if (fits) kept.push(mark);
    if (kept.length >= MAX_MARKS) break;
  }
  return kept;
}

/** Markdown cut short: a code block the cut left open is closed, so nothing added after it reads as code. */
export function closeFence(markdown: string): string {
  let open: string | null = null;
  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line);
    if (!fence) continue;
    if (!open) open = fence[1]!;
    else if (!fence[2] && fence[1]![0] === open[0] && fence[1]!.length >= open.length) open = null;
  }
  return open ? `${markdown}\n${open}` : markdown;
}

/** `text[start, end)` with the marks over it, moved to start at 0. */
function clip(text: string, marks: Mark[], start: number, end: number): { text: string; marks: Mark[] } {
  const part = text.slice(start, end);
  const kept = marks.flatMap((mark) => {
    const from = Math.max(mark.offset, start), to = Math.min(mark.offset + mark.length, end);
    const continues = mark.offset + mark.length > end;
    return to > from ? [{ ...mark, offset: from - start, length: to - from, ...(continues ? { continues } : {}) }] : [];
  });
  return { text: part, marks: tidy(part, kept) };
}

/**
 * A formatted text in parts of at most `limit` UTF-16 units, cut as plain text is cut (a paragraph
 * end, else a line end, else a space, else a character end) and never inside a character; a mark
 * over a cut goes on in the next part.
 */
export function splitRich(text: string, marks: Mark[], limit: number): { text: string; marks: Mark[] }[] {
  const parts: { text: string; marks: Mark[] }[] = [];
  let start = 0, end = text.length;
  while (start < end && SPACE.test(text[start]!)) start += 1;
  while (end > start && SPACE.test(text[end - 1]!)) end -= 1;
  // A part fits as sent formatted and as sent plain (with its links' addresses written out).
  const fits = (from: number, to: number) => to - from <= limit && plain(clip(text, marks, from, to)).length <= limit;
  while (!fits(start, end)) {
    let room = Math.min(limit, end - start);
    let cut = -1, partEnd = start;
    for (; room > 0; room = Math.min(room - 1, room - (plain(clip(text, marks, start, partEnd)).length - limit))) {
      const window = text.slice(start, start + room + 1);
      cut = -1;
      for (const sign of ["\n\n", "\n", " "]) {
        const at = window.lastIndexOf(sign, room);
        if (at >= room / 4) { cut = start + at; break; }
      }
      if (cut < 0) cut = start + Math.max(1, cutAt(text.slice(start, end), room).length);
      // Not inside a link when the link can stay whole: its address goes with it once.
      const link = marks.find((mark) => mark.type === "link" && mark.offset > start && mark.offset < cut && cut < mark.offset + mark.length);
      if (link) cut = link.offset;
      partEnd = cut;
      while (partEnd > start && SPACE.test(text[partEnd - 1]!)) partEnd -= 1;
      if (partEnd <= start || fits(start, partEnd)) break;
    }
    if (partEnd > start) parts.push(clip(text, marks, start, partEnd));
    start = Math.max(cut, start + 1);
    while (start < end && SPACE.test(text[start]!)) start += 1;
  }
  if (end > start) parts.push(clip(text, marks, start, end));
  return parts;
}

/**
 * What leaves for a chat when the text is the engine's markdown (already through the redactor):
 * the readable text and its marks. The redactor reads the text again as the phone will show it, so
 * a value the markup had split is still caught; then the text goes plain, with it hidden. A link's
 * address and a code block's language leave too, so they are read as well.
 */
export function formatted(markdown: string, scrub: (text: string) => string): { text: string; marks?: Mark[] } {
  const { text, marks } = readable(markdown);
  const seen = scrub(text);
  // Something was hidden: the text goes plain, with each link's address written out (not dropped) and read again.
  if (seen !== text) return { text: scrub(plain({ text, marks })) };
  // Signs left in the text as data (a star after a letter) must not hide a value from the
  // redactor: it also reads the text without them, and if a value shows there, that is what leaves.
  const bare = unsigned(plain({ text, marks }));
  if (scrub(bare) !== bare) return { text: scrub(bare) };
  const safe = marks.filter((mark) => (mark.url === undefined || scrub(mark.url) === mark.url) && (mark.language === undefined || scrub(mark.language) === mark.language));
  return safe.length ? { text, marks: safe } : { text };
}

/**
 * The long answer as a `.md` file: the markdown as written (already through the redactor) — unless
 * reading it as the phone would show it reveals a value the markup had split (`se**cret**`): then the
 * file is that readable text with the value hidden, links written out.
 */
export function answerFile(markdown: string, scrub: (text: string) => string): string {
  const first = scrub(markdown);
  const { text, marks } = readable(first);
  if (scrub(text) !== text) return scrub(plain({ text, marks }));
  const bare = unsigned(plain({ text, marks }));
  return scrub(bare) === bare ? first : scrub(bare);
}

/**
 * The text without the signs that can sit inside a word as data (stars, tildes, backticks), for the
 * redactor's second look only. Underscores stay: they are never markup here and values contain them.
 */
const unsigned = (text: string) => text.replace(/[*~`]/g, "");

/**
 * The text of a formatted part as it goes when the messenger takes no formatting: each link's
 * address written after its words (once, where the link ends), so nothing the marks carried is lost.
 */
export function plain(part: { text: string; marks: Mark[] }): string {
  const links = part.marks.filter((mark) => mark.type === "link" && mark.url && !mark.continues).sort((a, b) => b.offset + b.length - (a.offset + a.length));
  let text = part.text;
  for (const link of links) text = `${text.slice(0, link.offset + link.length)} (${link.url})${text.slice(link.offset + link.length)}`;
  return text;
}
