import { splitRich } from "./format.ts";
import type { Mark } from "./types.ts";

// An answer's readable text and marks (format.ts) as Slack's mrkdwn (m02 §14, audit #132): bold
// `*…*`, italic `_…_`, strike `~…~`, inline code `` `…` ``, a code block between ``` lines (its
// language is not sent; its content goes as written), a web link as `<address|words>`, a quote as
// `>` lines. Headings, lists and tables arrive already as lines (bold lines, bullets, a monospace
// block) from format.ts.
//
// Everywhere else `&`, `<` and `>` are escaped, as Slack requires: the only `<` this ever writes
// opens a link it made itself from an http(s) address, so nothing the model wrote can become a
// mention (`<@U…>`), a channel or everyone ping (`<!channel>`, `<#C…>`), or a link that shows one
// address and opens another.
//
// Slack applies emphasis only where its sign does not touch a letter or digit (`*중요*합니다` stays
// stars): such a sign gets a zero-width space between it and the letter. To confirm on a real
// workspace (the stand-in does not render).

export const escapeSlack = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Slack's escapes undone (for reading back what was sent). */
export const unescapeSlack = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const SIGN: Partial<Record<Mark["type"], string>> = { bold: "*", italic: "_", strike: "~" };
/** An address Slack can take inside `<…|…>`: a web address with no space, no bar and no angle bracket. */
const WEB = /^https?:\/\/[^\s<>|]+$/i;
const WORD = /[\p{L}\p{N}]/u;
/** Text that reads as an address: a scheme, a leading www., or a host-like name anywhere in it. */
const ADDRESS = /:\/\/|^\s*www\.|[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;

/** Whether two addresses are the same once scheme and host case and a trailing slash are set aside. */
function sameAddress(a: string, b: string): boolean {
  const norm = (text: string) => {
    try {
      const url = new URL(text);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  };
  const left = norm(a);
  return left !== null && left === norm(b);
}
const ZWSP = "​";

/** Emphasis around `inner`, its edge spaces left outside (Slack does not format `* x *`). */
function wrap(inner: string, sign: string, before: string, after: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  if (!match[2]) return inner;
  const lead = match[1] || (WORD.test(before) ? ZWSP : "");
  const trail = match[3] || (WORD.test(after) ? ZWSP : "");
  return `${lead}${sign}${match[2]}${sign}${trail}`;
}

/** `text[from, to)` with the marks inside it (they never cross: format.ts tidy). */
function render(text: string, marks: Mark[], from: number, to: number): string {
  let out = "", at = from;
  const inside = marks.filter((mark) => mark.offset >= from && mark.offset + mark.length <= to).sort((a, b) => a.offset - b.offset || b.length - a.length);
  for (let index = 0; index < inside.length; index += 1) {
    const mark = inside[index]!;
    if (mark.offset < at) continue;
    const end = mark.offset + mark.length;
    out += escapeSlack(text.slice(at, mark.offset));
    const children = inside.filter((other, place) => place !== index && other.offset >= mark.offset && other.offset + other.length <= end);
    out += one(text, mark, children, end);
    at = end;
  }
  return out + escapeSlack(text.slice(at, to));
}

function one(text: string, mark: Mark, children: Mark[], end: number): string {
  const content = text.slice(mark.offset, end);
  switch (mark.type) {
    case "code":
      // Slack's inline code cannot hold a backtick or a line break: then the content goes as text, whole.
      return /[`\n]/.test(content) ? escapeSlack(content) : `\`${escapeSlack(content)}\``;
    case "pre": {
      // A block that holds ``` itself would end early: its content goes as text, whole.
      if (content.includes("```")) return escapeSlack(content);
      return `\`\`\`\n${escapeSlack(content)}\n\`\`\``;
    }
    case "link": {
      // Invisible and direction characters (a right-to-left override can make any text read as an address) go.
      const seen = content.replace(/\n/g, " ").replace(/\p{Cf}/gu, "");
      const words = escapeSlack(seen);
      if (mark.url && WEB.test(mark.url)) {
        const url = escapeSlack(mark.url);
        // Words that read as an address never hide the one the link opens (security review M1): the
        // address itself when they are it, else the words with the real address after them.
        if (!ADDRESS.test(seen)) return `<${url}|${words}>`;
        return sameAddress(seen.trim(), mark.url) ? `<${url}>` : `${words} (<${url}>)`;
      }
      // Any other address (mail, Telegram): its words, then the address written out as text.
      return mark.url && !mark.continues ? `${words} (${escapeSlack(mark.url)})` : words;
    }
    case "quote": {
      const inner = render(text, children, mark.offset, end);
      return inner.split("\n").map((line) => `> ${line}`).join("\n");
    }
    default: {
      const sign = SIGN[mark.type];
      const inner = render(text, children, mark.offset, end);
      return sign ? wrap(inner, sign, text[mark.offset - 1] ?? "", text[end] ?? "") : inner;
    }
  }
}

/** One part (text and marks over it) as mrkdwn. */
export function mrkdwn(part: { text: string; marks: Mark[] }): string {
  return render(part.text, part.marks, 0, part.text.length);
}

/**
 * The whole text as mrkdwn parts that each fit `limit`: cut where format.ts splitRich cuts (a
 * paragraph, a line, a space, else a character end; a mark over a cut goes on in the next part),
 * smaller where the signs and escapes made a part grow.
 */
export function mrkdwnParts(text: string, marks: Mark[], limit: number): string[] {
  const out: string[] = [];
  const queue = splitRich(text, marks, limit);
  while (queue.length) {
    const part = queue.shift()!;
    const shown = mrkdwn(part);
    if (shown.length <= limit || part.text.length <= 1) { out.push(shown); continue; }
    queue.unshift(...splitRich(part.text, part.marks, Math.max(1, Math.floor((limit * part.text.length) / shown.length) - 8)));
  }
  return out;
}
