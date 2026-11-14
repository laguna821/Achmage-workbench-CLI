/**
 * T1 (round 4): which invisible characters each of the engine's writers keeps. For every code point
 * U+0000–U+001F, U+007F–U+009F and the Unicode format characters below, a document BUILT here holds
 * it in body, cell, footnote, header and memo text — once opened from HWPX (written as a character
 * reference, as generated files do) and once typed into the open document through the engine's own
 * insert calls — and is exported as HWP and as HWPX and reopened. The table of what survives is the
 * test: when a future engine keeps or drops a different set, it fails, and the census's rule
 * (`HWP_UNKEPT` in packages/contracts/src/hwp-text.ts) must be re-derived from the new table.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init, { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";
import { engineJson, HWP_UNKEPT, hwpTextOf, lostText, lostUnread, type HwpText } from "../../../packages/contracts/src/hwp-text.ts";
import { buildHwpx, footnote, header, memo, para, table, text } from "./hwp-census-fixture.ts";
import { hwpWasmPath } from "./hwp-resource.ts";

beforeAll(async () => { await init({ module_or_path: readFileSync(hwpWasmPath()) }); });

/** The code points examined: every C0 and C1 control, and the format characters (Cf, line/paragraph separators, specials). */
const EXAMINED: number[] = [
  ...Array.from({ length: 0x20 }, (_, code) => code),
  ...Array.from({ length: 0x9f - 0x7f + 1 }, (_, index) => 0x7f + index),
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206f,
  0xfeff, 0xfff9, 0xfffa, 0xfffb, 0xfffc, 0xfffd, 0xfffe, 0xffff,
];

type Kind = "body" | "cell" | "note" | "header" | "memo";
const KINDS: Kind[] = ["body", "cell", "note", "header", "memo"];
/** Each container's text around the character: three visible characters after it, so a writer that eats what follows shows. */
const AROUND: Record<Kind, [string, string]> = { body: ["가", "나다라"], cell: ["마", "바사아"], note: ["자", "차카타"], header: ["파", "하거너"], memo: ["더", "러머버"] };
const piece = (kind: Kind, middle: string) => `<hp:t>${AROUND[kind][0]}${middle}${AROUND[kind][1]}</hp:t>`;
const shape = (pieces: Record<Kind, string>) => buildHwpx(text("본문") + header(para(pieces.header)), [
  para(pieces.body + footnote(para(pieces.note))),
  para(table([para(pieces.cell)])),
  para(memo("@MEMO@", "셋").replace("<hp:t>@MEMO@</hp:t>", () => pieces.memo)),
]);
const pieces = (middle: string) => Object.fromEntries(KINDS.map((kind) => [kind, piece(kind, middle)])) as Record<Kind, string>;

/** The raw text of each container, as the census's own engine calls return it (recorded on the way), and the census. */
function read(doc: HwpDocument): { texts: Record<Kind, string>; census: HwpText } {
  const seen: Record<Kind, string[]> = { body: [], cell: [], note: [], header: [], memo: [] };
  const json = (kind: Kind, answer: string, pick: (value: Record<string, unknown>) => string | null) => {
    const value = pick(engineJson(answer));
    if (value !== null) seen[kind].push(value);
    return answer;
  };
  const spy = new Proxy(doc, {
    get: (target, name) => {
      const call = (target as never as Record<string, (...args: unknown[]) => string>)[name as string];
      if (typeof call !== "function") return call;
      const bound = call.bind(target);
      if (name === "getTextRange") return (...args: unknown[]) => { const value = bound(...args); seen.body.push(value); return value; };
      if (name === "getTextInCellByPath") return (...args: unknown[]) => { const value = bound(...args); seen.cell.push(value); return value; };
      if (name === "getFootnoteInfo") return (...args: unknown[]) => json("note", bound(...args), (value) => (value.texts as string[]).join("\n"));
      if (name === "getHeaderFooter") return (...args: unknown[]) => json("header", bound(...args), (value) => value.exists ? String(value.text) : null);
      if (name === "getMemoList") return (...args: unknown[]) => json("memo", bound(...args), (value) => (value as never as { text: string }[]).map((item) => item.text).join("\n"));
      return bound;
    },
  });
  const census = hwpTextOf(spy as never);
  return { texts: Object.fromEntries(KINDS.map((kind) => [kind, seen[kind].join("|")])) as Record<Kind, string>, census };
}

/**
 * What a writer did to the character in one container: `keep`, `drop` (only it is gone), `loseN`
 * (it and N visible characters after it are gone), `change:<hex>` (it became that character), or
 * `absent` (the open document did not hold it in the first place).
 */
function fate(live: string, reopened: string, char: string): string {
  if (!live.includes(char)) return "absent";
  if (reopened === live) return "keep";
  if (reopened === live.replace(char, "")) return "drop";
  const lost = live.length - 1 - reopened.length;
  if (lost > 0) return `lose${lost}`;
  return `change:${[...reopened].filter((c) => !live.includes(c)).map((c) => c.codePointAt(0)!.toString(16)).join("+")}`;
}
const reopen = (bytes: Uint8Array) => { const doc = new HwpDocument(bytes); try { return read(doc); } finally { doc.free(); } };
type Side = "live" | "hwp" | "hwpx";
type Row = { fates: Record<Side, Record<Kind, string>>; census: Record<Side, HwpText> };
function judge(doc: HwpDocument, char: string): Row {
  const live = read(doc), hwp = reopen(doc.exportHwp()), hwpx = reopen(doc.exportHwpx());
  const each = (other: Record<Kind, string>) => Object.fromEntries(KINDS.map((kind) => [kind, fate(live.texts[kind], other[kind], char)])) as Record<Kind, string>;
  return {
    fates: { live: Object.fromEntries(KINDS.map((kind) => [kind, live.texts[kind].includes(char) ? "keep" : "absent"])) as Record<Kind, string>, hwp: each(hwp.texts), hwpx: each(hwpx.texts) },
    census: { live: live.census, hwp: hwp.census, hwpx: hwpx.census },
  };
}
/** One line per way in: each side's fate, one word when every container agrees. */
const line = (row: Row) => (["live", "hwp", "hwpx"] as const).map((side) => {
  const fates = new Set(KINDS.map((kind) => row.fates[side][kind]));
  return `${side} ${fates.size === 1 ? [...fates][0] : KINDS.map((kind) => `${kind}:${row.fates[side][kind]}`).join(",")}`;
}).join("; ");

type Ways = { opened: Row; typed: Row };
let rows: Map<number, Ways> | null = null;
async function allRows(): Promise<Map<number, Ways>> {
  if (rows) return rows;
  const out = new Map<number, Ways>(), base = await shape(pieces(""));
  for (const code of EXAMINED) {
    const char = String.fromCharCode(code);
    const doc = new HwpDocument(await shape(pieces(`&#${code};`)));
    let opened: Row;
    try { opened = judge(doc, char); } finally { doc.free(); }
    const typedDoc = new HwpDocument(base);
    let typed: Row;
    try {
      typedDoc.insertText(0, 1, 1, char);
      typedDoc.insertTextInCell(0, 2, 0, 0, 0, 1, char);
      typedDoc.insertTextInFootnote(0, 1, 0, 0, 1, char);
      typedDoc.insertTextInHeaderFooter(0, true, 0, 0, 1, char);
      const [first] = JSON.parse(typedDoc.getMemoList()) as { id: number }[];
      typedDoc.setMemoText(first!.id, `${AROUND.memo[0]}${char}${AROUND.memo[1]}`);
      typed = judge(typedDoc, char);
    } finally { typedDoc.free(); }
    out.set(code, { opened, typed });
  }
  return (rows = out);
}

// rhwp 0.8.7-ieum.12-hop.1. Columns: [from, to, opened from HWPX as a character reference, typed through the engine's insert calls].
// (setMemoText does not take C0 controls, so a typed memo never holds one: `memo:absent`.)
const TYPED_C0 = (hwp: string, hwpx = "drop") => `live body:keep,cell:keep,note:keep,header:keep,memo:absent; hwp ${hwp}; hwpx ${hwpx}`;
const each4 = (fate: string, header = fate) => `body:${fate},cell:${fate},note:${fate},header:${header},memo:absent`;
const KEPT = "live keep; hwp keep; hwpx keep";
const TABLE: [number, number, string, string][] = [
  [0x00, 0x00, "live absent; hwp absent; hwpx absent", TYPED_C0(each4("drop"), each4("drop"))],
  [0x01, 0x08, "live keep; hwp lose3; hwpx drop", TYPED_C0(each4("lose3"), each4("drop"))],
  [0x09, 0x0a, KEPT, KEPT],
  [0x0b, 0x11, "live keep; hwp lose3; hwpx drop", TYPED_C0(each4("lose3"), each4("drop"))],
  [0x12, 0x12, "live keep; hwp lose2; hwpx drop", TYPED_C0(each4("lose2"), each4("drop"))],
  [0x13, 0x14, "live keep; hwp lose3; hwpx drop", TYPED_C0(each4("lose3"), each4("drop"))],
  [0x15, 0x16, "live keep; hwp body:lose3,cell:lose3,note:lose3,header:change:20,memo:lose3; hwpx body:drop,cell:drop,note:drop,header:change:20,memo:drop",
    TYPED_C0(each4("lose3", "change:20"), each4("drop", "change:20"))],
  [0x17, 0x17, "live keep; hwp body:lose3,cell:lose3,note:lose3,header:drop,memo:lose3; hwpx drop", TYPED_C0(each4("lose3", "drop"), each4("drop"))],
  [0x18, 0x18, "live keep; hwp change:ad; hwpx drop", TYPED_C0(each4("change:ad"), each4("drop"))],
  [0x19, 0x19, "live keep; hwp change:20; hwpx drop", TYPED_C0(each4("change:20"), each4("drop"))],
  [0x1a, 0x1d, "live keep; hwp drop; hwpx drop", TYPED_C0(each4("drop"), each4("drop"))],
  [0x1e, 0x1e, "live keep; hwp change:a0; hwpx drop", TYPED_C0(each4("change:a0"), each4("drop"))],
  [0x1f, 0x1f, "live keep; hwp change:2007; hwpx drop", TYPED_C0(each4("change:2007"), each4("drop"))],
  [0x7f, 0x9f, KEPT, KEPT],
  [0x00ad, 0x00ad, KEPT, KEPT], [0x061c, 0x061c, KEPT, KEPT], [0x180e, 0x180e, KEPT, KEPT],
  [0x200b, 0x200f, KEPT, KEPT], [0x2028, 0x202e, KEPT, KEPT], [0x2060, 0x2064, KEPT, KEPT], [0x2066, 0x206a, KEPT, KEPT], [0x206f, 0x206f, KEPT, KEPT],
  [0xfeff, 0xfeff, KEPT, KEPT], [0xfff9, 0xfffb, KEPT, KEPT],
  [0xfffc, 0xfffc, "live keep; hwp keep; hwpx body:drop,cell:keep,note:keep,header:keep,memo:keep", "live keep; hwp keep; hwpx body:drop,cell:keep,note:keep,header:keep,memo:keep"],
  [0xfffd, 0xfffd, KEPT, KEPT],
  [0xfffe, 0xffff, "live keep; hwp keep; hwpx drop", "live keep; hwp keep; hwpx drop"],
];
const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
const expectedLine = (code: number) => { const row = TABLE.find(([from, to]) => code >= from && code <= to); return row ? { opened: row[2], typed: row[3] } : null; };
/** A writer does not keep the character somewhere the open document held it. */
const unkept = (row: Row) => (["hwp", "hwpx"] as const).some((side) => KINDS.some((kind) => row.fates.live[kind] === "keep" && row.fates[side][kind] !== "keep"));

describe("T1: the invisible characters each writer keeps", () => {
  it("is the table this engine was measured with (a different engine must re-derive the census rule)", async () => {
    const found = await allRows();
    const differ = EXAMINED.filter((code) => {
      const ways = found.get(code)!;
      const got = { opened: line(ways.opened), typed: line(ways.typed) };
      return JSON.stringify(got) !== JSON.stringify(expectedLine(code));
    }).map((code) => `${hex(code)}: ${line(found.get(code)!.opened)} / ${line(found.get(code)!.typed)}`);
    expect(differ).toEqual([]);
  }, 120_000);

  it("leaves out of the census exactly the characters some writer does not keep", async () => {
    const found = await allRows();
    const derived = EXAMINED.filter((code) => unkept(found.get(code)!.opened) || unkept(found.get(code)!.typed)).map(hex);
    const rule = EXAMINED.filter((code) => new RegExp(HWP_UNKEPT.source).test(String.fromCharCode(code))).map(hex);
    expect(rule).toEqual(derived);
  }, 120_000);

  it("refuses only what a writer really loses: a dropped or replaced invisible character is no loss, eaten text is", async () => {
    const found = await allRows();
    const wrong: string[] = [], rises: string[] = [];
    for (const code of EXAMINED) {
      for (const [way, row] of Object.entries(found.get(code)!) as [string, Row][]) {
        for (const side of ["hwp", "hwpx"] as const) {
          const eaten = KINDS.some((kind) => row.fates[side][kind].startsWith("lose"));
          const lost = lostText(row.census.live.chars, row.census[side].chars);
          if (eaten !== lost.length > 0) wrong.push(`${hex(code)} ${way} ${side}: ${lost.join(", ") || "no loss"}`);
          // where the writer only dropped it, nothing else differs: same hashes
          const dropped = KINDS.every((kind) => ["keep", "drop", "absent"].includes(row.fates[side][kind]));
          if (dropped && (row.census[side].sha256 !== row.census.live.sha256 || row.census[side].digest !== row.census.live.digest)) wrong.push(`${hex(code)} ${way} ${side}: hash differs`);
          // what the census cannot read never drops; a rise (a header character reopened as a control) is recorded
          const lostObjects = lostUnread(row.census.live.unread, row.census[side].unread);
          if (lostObjects.length) wrong.push(`${hex(code)} ${way} ${side}: ${lostObjects.join(", ")}`);
          if (JSON.stringify(row.census[side].unread) !== JSON.stringify(row.census.live.unread)) rises.push(`${hex(code)} ${way} ${side} ${JSON.stringify(row.census[side].unread)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    // U+0015–U+0017 in a header come back from both writers as a control inside the header (a gain, never refused)
    expect(rises).toEqual([0x15, 0x16, 0x17].flatMap((code) => ["opened", "typed"].flatMap((way) => ["hwp", "hwpx"].map((side) => `${hex(code)} ${way} ${side} {"header-object":1}`))));
  }, 120_000);
});
