import type { Mark } from "./types.ts";

// Test helper: formatting never changes an answer's content. Written from the rule, not from the
// converter: the only signs a message may lose are markdown's own (stars, backticks, `#`, brackets
// and parentheses, `>`, `|`, `-`, `+`, `:`, `!`) and whitespace; every other character of the
// source is delivered in order and none is delivered more often than the source has it. A link's
// address counts as delivered where its entity carries it. Stars and backticks may go only as far
// as the marks delivered account for them.

const MARKUP = new Set([..."*`#[]()<>|-+:!", "•", "◦", "·", "─"]);
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*[\w+#.-]*[ \t]*$/;
const RULE_LINE = /^ {0,3}([-*])(?:[ \t]*\1){2,}[ \t]*$/;

const content = (text: string) => Array.from(text).filter((char) => !/\s/.test(char) && !MARKUP.has(char));
const count = (text: string, sign: string) => text.split(sign).length - 1;

/** One delivered message as the phone has it: its text, with each link's address put after the link (once, where the link ends). */
function stream(part: { text: string; marks: Mark[] }): string {
  const links = part.marks.filter((mark) => mark.type === "link" && mark.url && !mark.continues).sort((a, b) => b.offset + b.length - (a.offset + a.length));
  let text = part.text;
  for (const link of links) text = `${text.slice(0, link.offset + link.length)} ${link.url} ${text.slice(link.offset + link.length)}`;
  return text;
}

/**
 * What is wrong with `parts` as the delivery of `source`, or null. `shown`: the marks of the
 * formatted version, when `parts` is its plain fallback (the signs it read as markup go in both).
 */
export function contentProblem(source: string, parts: { text: string; marks: Mark[] }[], shown?: Mark[]): string | null {
  const delivered = parts.map(stream).join("\n");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const dropped = lines.filter((line) => FENCE_LINE.test(line) || RULE_LINE.test(line));
  const kept = lines.filter((line) => !FENCE_LINE.test(line) && !RULE_LINE.test(line)).join("\n");
  if (source.trim() && !delivered.trim()) return "empty, though the source had text";
  const want = content(kept), got = content(delivered);
  let at = 0;
  for (const char of got) if (at < want.length && char === want[at]) at += 1;
  if (at < want.length) return `lost ${JSON.stringify(want.slice(at, at + 12).join(""))} (after ${JSON.stringify(want.slice(Math.max(0, at - 12), at).join(""))})`;
  const all = content(source);
  for (const char of new Set(got)) {
    if (got.filter((one) => one === char).length > all.filter((one) => one === char).length) return `doubled ${JSON.stringify(char)}`;
  }
  const marks = shown ?? parts.flatMap((part) => part.marks);
  const starsGone = count(source, "*") - count(delivered, "*");
  const starsMay = 4 * marks.filter((mark) => mark.type === "bold").length + 2 * marks.filter((mark) => mark.type === "italic").length
    + count(delivered, "•") + count(delivered, "◦") + dropped.reduce((sum, line) => sum + count(line, "*"), 0);
  if (starsGone < 0 || starsGone > starsMay) return `stars: ${starsGone} gone, at most ${starsMay} were markup`;
  const ticksGone = count(source, "`") - count(delivered, "`");
  const ticksMay = marks.some((mark) => mark.type === "code" || mark.type === "pre") ? Infinity : dropped.reduce((sum, line) => sum + count(line, "`"), 0);
  if (ticksGone < 0 || ticksGone > ticksMay) return `backticks: ${ticksGone} gone, at most ${ticksMay} were markup`;
  return null;
}
