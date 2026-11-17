/**
 * A search excerpt as it reads (audit #10): Markdown's marks go, the words stay, and the highlighted
 * ranges move with the words so a match still lands on the right characters. Code spans keep their
 * content as written (only the backticks go). Pure: the same input always gives the same output.
 *
 * Gone: heading marks (`## `), quote marks (`> `, callouts), list and task marks at a line's start
 * (`- `, `1. `, `- [ ] `), emphasis (`**`, `__`, `~~`, `==`, `*단어*`, `_단어_`), backticks and code
 * fences, link syntax (`[글](주소)` → 글, `[[노트|별칭]]` → 별칭, `[[노트]]` → 노트), pictures
 * (`![…](…)`, `![[…]]`), HTML tags and backslash escapes.
 */
export function plainExcerpt(text: string, ranges: readonly (readonly [number, number])[] = []): { text: string; ranges: [number, number][] } {
  const removed = new Uint8Array(text.length);
  const shielded = new Uint8Array(text.length);
  const drop = (from: number, to: number) => { for (let at = from; at < to; at += 1) removed[at] = 1; };
  const free = (from: number, to: number) => { for (let at = from; at < to; at += 1) if (shielded[at] || removed[at]) return false; return true; };
  // Code first: its backticks go, what is inside is kept exactly and no other rule touches it.
  for (const match of text.matchAll(/```[\w-]*/g)) drop(match.index, match.index + match[0].length);
  for (const match of text.matchAll(/(`+)([^`\n]+?)\1/g)) {
    const ticks = match[1]!.length;
    drop(match.index, match.index + ticks);
    drop(match.index + match[0].length - ticks, match.index + match[0].length);
    for (let at = match.index + ticks; at < match.index + match[0].length - ticks; at += 1) shielded[at] = 1;
  }
  // [pattern, which groups go] — a group number, or 0 for the whole match. Each match only where untouched.
  const rules: [RegExp, number[]][] = [
    [/!\[\[[^\]\n]*\]\]/dg, [0]],
    [/!\[[^\]\n]*\]\([^)\n]*\)/dg, [0]],
    [/(\[\[[^\]|\n]*\|)[^\]\n]*(\]\])/dg, [1, 2]],
    [/(\[\[)[^\]|\n]*(\]\])/dg, [1, 2]],
    [/(\[)[^\]\n]*(\]\([^)\s]*(?:\s+"[^"\n]*")?\))/dg, [1, 2]],
    [/(?<=^|\s)#{1,6}[ \t]+/dg, [0]],
    [/(?<=^|\n)[ \t]*>[ \t]?(?:\[![^\]\n]*\][+-]?[ \t]*)?/dg, [0]],
    [/(?<=^|\n|^…)[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/dg, [0]],
    [/\*\*|__|~~|==/dg, [0]],
    [/(?<=^|[\s(「『"'])(\*)(?=\S)[^*\n]*?\S(\*)(?=$|[\s).,!?…:;」』"'])/dg, [1, 2]],
    [/(?<=^|[\s(「『"'])(_)(?=\S)[^_\n]*?\S(_)(?=$|[\s).,!?…:;」』"'])/dg, [1, 2]],
    [/<\/?[A-Za-z][^>\n]*>/dg, [0]],
    [/\\(?=[\\`*_{}[\]()#+\-.!|~=<>])/dg, [0]],
  ];
  for (const [pattern, groups] of rules) {
    for (const match of text.matchAll(pattern)) {
      const spans = groups.map((group) => match.indices![group]!).filter(Boolean);
      if (spans.every(([from, to]) => free(from, to))) for (const [from, to] of spans) drop(from, to);
    }
  }
  // Where each original character lands in the output (a removed one: where the next kept one lands).
  const position = new Int32Array(text.length + 1);
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    position[at] = out.length;
    if (!removed[at]) out += text[at];
  }
  position[text.length] = out.length;
  const mapped: [number, number][] = [];
  for (const [start, end] of ranges) {
    const from = position[Math.max(0, Math.min(text.length, start))]!;
    const to = position[Math.max(0, Math.min(text.length, end))]!;
    if (to <= from) continue;
    const last = mapped.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else mapped.push([from, to]);
  }
  return { text: out, ranges: mapped };
}
