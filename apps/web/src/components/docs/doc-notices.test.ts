import { describe, expect, it } from "vitest";
import { NOTICE_ORDER, TONE_OF, linesWord, orderNotices, revisionWord, severest, type DocNotice, type DocNoticeKind } from "./doc-notices.ts";

const of = (kind: DocNoticeKind, text: string = kind): DocNotice => ({ kind, tone: TONE_OF[kind], text, keys: [] });

describe("the document's notice line: one order of precedence", () => {
  it("losing typed work first, then what needs the person, then limits, then information", () => {
    expect(NOTICE_ORDER.slice(0, 3)).toEqual(["conflict", "editor-conflict", "save-failed"]);
    expect(NOTICE_ORDER.indexOf("hangul-draft")).toBeLessThan(NOTICE_ORDER.indexOf("agent-waits"));
    expect(NOTICE_ORDER.indexOf("hangul-warning")).toBeLessThan(NOTICE_ORDER.indexOf("read-only"));
    expect(NOTICE_ORDER.indexOf("agent-waits")).toBeLessThan(NOTICE_ORDER.indexOf("read-only"));
    expect(NOTICE_ORDER.at(-1)).toBe("readers");
  });

  it("orders any mix by it, keeps every notice, and keeps the given order within a kind", () => {
    const shuffled = [...NOTICE_ORDER].reverse().map((kind) => of(kind));
    // Fix 1 (tech review T2): by tone first (error › attention › info), then NOTICE_ORDER.
    const byTone = (["error", "attention", "info"] as const).flatMap((tone) => NOTICE_ORDER.filter((kind) => TONE_OF[kind] === tone));
    expect(orderNotices(shuffled).map((notice) => notice.kind)).toEqual(byTone);
    const mixed = orderNotices([of("readers", "a"), null, false, of("conflict"), undefined, "", of("readers", "b"), of("narrow")]);
    expect(mixed.map((notice) => notice.text)).toEqual(["conflict", "narrow", "a", "b"]);
  });

  it("a Hangul save that may have lost something outranks a document-AI failure and a missing file (re-review 1)", () => {
    expect(TONE_OF["hangul-warning"]).toBe("error");
    const kinds = orderNotices([of("agent-error"), of("disk-missing"), of("viewing-revision"), of("hangul-warning")]).map((notice) => notice.kind);
    expect(kinds).toEqual(["hangul-warning", "disk-missing", "agent-error", "viewing-revision"]);
  });

  it("an unsaved-edit conflict wins over everything else", () => {
    const all = NOTICE_ORDER.filter((kind) => kind !== "conflict").map((kind) => of(kind));
    expect(orderNotices([...all, of("conflict")])[0].kind).toBe("conflict");
  });

  it("work at stake is an error; needing the person is attention", () => {
    expect(TONE_OF.conflict).toBe("error");
    expect(TONE_OF["save-failed"]).toBe("error");
    expect(TONE_OF["agent-waits"]).toBe("attention");
    expect(TONE_OF.readers).toBe("info");
  });

  it("says revisions and sizes in words", () => {
    expect(revisionWord(3)).toBe("3판");
    expect(linesWord(3, 2)).toBe("3줄 더함, 2줄 뺌");
    expect(linesWord(0, 1)).toBe("1줄 뺌");
    expect(linesWord(0, 0)).toBe("바뀐 줄 없음");
  });
});

// Technical review T2: viewing an older revision (info) hid "the file is gone from disk" (error) behind
// "외 1건". Errors come before what needs the person, which comes before information; within a tone the
// order stays NOTICE_ORDER. "외 N건" carries the tone of the most severe notice behind it.
describe("errors before information", () => {
  const n = (kind: DocNoticeKind) => ({ kind, tone: TONE_OF[kind], text: kind, keys: [] });
  it("puts disk-missing and agent-error above viewing-revision and read-only", () => {
    expect(orderNotices([n("viewing-revision"), n("read-only"), n("disk-missing"), n("agent-error"), n("hangul-draft")]).map((x) => x.kind))
      .toEqual(["disk-missing", "agent-error", "hangul-draft", "viewing-revision", "read-only"]);
  });
  it("the hidden notices' most severe tone", () => {
    expect(severest([n("read-only"), n("agent-error")])).toBe("error");
    expect(severest([n("read-only"), n("disk-changed")])).toBe("attention");
    expect(severest([n("readers")])).toBe("info");
  });
});
