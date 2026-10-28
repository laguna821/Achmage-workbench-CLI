// Adapted from IeumOffice (https://github.com/pblsketch/openoffice)
// packages/ui/src/doc-mention-model.ts @ 9052297, Apache-2.0 (see third_party/ieumoffice).
// Changes: rows are Workbench documents (open first, then the rest of the work) instead of the
// shell's file list; no "find more" row and no folder disambiguation by path.

import type { DocFormat } from "@workbench/contracts";

/** A document the `@` list offers. */
export type MentionItem = { id: string; name: string; format: DocFormat; group: "open" | "work"; hint?: string };

/** The `@query` the caret sits at the end of. */
export type MentionTrigger = { start: number; end: number; query: string };

/** A picked mention in the text (without the space after it). */
export type MentionSpan = { start: number; text: string };

/** Longest text between the `@` and the caret that still filters the list. */
export const MENTION_QUERY_MAX = 80;

const inSpan = (spans: readonly MentionSpan[], index: number) => spans.some((span) => index >= span.start && index < span.start + span.text.length);

/**
 * Whether the list opens at `caret`: the nearest `@` on the same line that starts the input or
 * follows whitespace and is not part of a picked mention. Never while a Korean syllable is being
 * composed, inside or right after a picked mention, or past the longest query.
 */
export function mentionTriggerAt(value: string, caret: number, options: { spans?: readonly MentionSpan[]; composing?: boolean } = {}): MentionTrigger | null {
  if (options.composing) return null;
  if (!Number.isInteger(caret) || caret < 1 || caret > value.length) return null;
  const spans = options.spans ?? [];
  if (spans.some((span) => caret > span.start && caret <= span.start + span.text.length)) return null;
  for (let index = caret - 1; index >= 0; index -= 1) {
    const character = value.charAt(index);
    if (character === "\n" || character === "\r") return null;
    if (caret - index - 1 > MENTION_QUERY_MAX) return null;
    if (character !== "@") continue;
    if (index > 0 && !/\s/.test(value.charAt(index - 1))) continue;
    if (inSpan(spans, index)) continue;
    return { start: index, end: caret, query: value.slice(index + 1, caret) };
  }
  return null;
}

/**
 * Picked mentions after the text changed from `previous` to `next`: one before the edit keeps its
 * place, one after it moves, and one the edit touched is no longer a mention.
 */
export function relocateMentions(previous: string, next: string, spans: readonly MentionSpan[]): MentionSpan[] {
  if (previous === next) return [...spans];
  let head = 0;
  const shortest = Math.min(previous.length, next.length);
  while (head < shortest && previous.charCodeAt(head) === next.charCodeAt(head)) head += 1;
  let tail = 0;
  while (tail < shortest - head && previous.charCodeAt(previous.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail += 1;
  const editedEnd = previous.length - tail;
  const shift = next.length - previous.length;
  const kept: MentionSpan[] = [];
  for (const span of spans) {
    const spanEnd = span.start + span.text.length;
    let start: number;
    if (spanEnd <= head) start = span.start;
    else if (span.start >= editedEnd) start = span.start + shift;
    else continue;
    if (next.slice(start, start + span.text.length) === span.text) kept.push({ start, text: span.text });
  }
  return kept;
}

const fold = (text: string) => text.normalize("NFC").toLocaleLowerCase();

/** Rows matching the query by name: names starting with it first, then containing it; open documents first. */
export function filterMentions(items: readonly MentionItem[], query: string): MentionItem[] {
  const needle = fold(query.trim());
  return items
    .map((item, index) => {
      const name = fold(item.name);
      const rank = !needle || name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : -1;
      return { item, rank, group: item.group === "open" ? 0 : 1, index };
    })
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.group - b.group || a.index - b.index)
    .map((entry) => entry.item);
}

/** The text with the typed `@query` replaced by `@name `, the caret after it, and the new span. */
export function insertMention(value: string, at: { start: number; end: number }, name: string): { value: string; caret: number; span: MentionSpan } {
  const label = `@${name}`;
  return { value: `${value.slice(0, at.start)}${label} ${value.slice(at.end)}`, caret: at.start + label.length + 1, span: { start: at.start, text: label } };
}
