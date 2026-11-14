import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { formsOf, MIN_VALUE } from "./forms.ts";
import { TranscriptScrubber } from "./scrubber.ts";

// Made-up values only (they were never anyone's secret).
const VALUE = "zz-secret-ab12cd34";
const QUOTED = 'zz-secret-"quo\\te"-가나';
const CARD = "4000123412341234";

const scrubber = () => {
  const s = new TranscriptScrubber();
  s.set("e1", "학교 포털", [VALUE]);
  return s;
};

/** None of the forms the brief names may be left in the text. */
const leaks = (text: string, value = VALUE) => formsOf(value).filter((form) => text.includes(form));

describe("the forms of a value", () => {
  it("are the raw value, base64, base64url, URL-encoded and JSON-escaped, each 8 characters or more", () => {
    const forms = formsOf(QUOTED);
    const bytes = Buffer.from(QUOTED, "utf8");
    for (const form of [QUOTED, bytes.toString("base64"), bytes.toString("base64url"), encodeURIComponent(QUOTED), JSON.stringify(QUOTED).slice(1, -1)]) expect(forms).toContain(form);
    // JSON as an engine writes it with non-ASCII escaped (Python's json.dumps).
    expect(forms.some((form) => form.includes("\\uac00"))).toBe(true);
    expect(forms.every((form) => form.length >= MIN_VALUE)).toBe(true);
  });

  it("are none for a value shorter than 8 characters", () => {
    expect(formsOf("zz-1234")).toEqual([]);
  });
});

describe("TranscriptScrubber", () => {
  it("with nothing stored changes nothing and hands back the very same objects", () => {
    const s = new TranscriptScrubber();
    const item: TranscriptItem = { kind: "assistant", id: "a", text: `값은 ${VALUE}`, streaming: false, at: 1 };
    expect(s.value(item)).toBe(item);
    expect(s.text("아무 글")).toBe("아무 글");
    expect(s.delta("s:a", "조각 하나", "")).toBeNull();
    expect(s.active).toBe(false);
  });

  it("hides a stored value in every form, under its name", () => {
    const s = scrubber();
    const bytes = Buffer.from(VALUE, "utf8");
    const text = [
      `raw ${VALUE}`,
      `b64 ${bytes.toString("base64")}`,
      `b64url ${bytes.toString("base64url").replace(/=+$/, "")}`,
      `url ${encodeURIComponent(VALUE)}`,
      `basic ${Buffer.from(`user:${VALUE}`).toString("base64")}`,
      `json {"password":${JSON.stringify(VALUE)}}`,
    ].join("\n");
    const out = s.text(text);
    expect(leaks(out)).toEqual([]);
    expect(out).toContain("raw [비밀: 학교 포털]");
    expect(out).toContain("b64 [비밀: 학교 포털]");
  });

  it("hides a value with quotes, a backslash and Hangul in JSON as engines escape it", () => {
    const s = new TranscriptScrubber();
    s.set("e2", "따옴표", [QUOTED]);
    const ascii = JSON.stringify(QUOTED).slice(1, -1).replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const out = s.text(`a ${JSON.stringify(QUOTED)} b ${ascii} c ${QUOTED}`);
    expect(leaks(out, QUOTED)).toEqual([]);
    expect(out.match(/\[비밀: 따옴표\]/g)?.length).toBe(3);
  });

  it("hides a card number also in groups of four", () => {
    const s = new TranscriptScrubber();
    s.set("card", "카드 1", [CARD]);
    expect(s.text("4000 1234 1234 1234 / 4000-1234-1234-1234")).toBe("[비밀: 카드 1] / [비밀: 카드 1]");
  });

  it("finds a value split by an invisible character", () => {
    const s = scrubber();
    expect(s.text(`앞 ${VALUE.slice(0, 5)}​${VALUE.slice(5)} 뒤`)).toBe("앞 [비밀: 학교 포털] 뒤");
  });

  it("does not register a value shorter than 8 characters, and leaves its text alone", () => {
    const s = new TranscriptScrubber();
    s.set("short", "CVC", ["123"]);
    expect(s.active).toBe(false);
    expect(s.text("CVC 123 입니다")).toBe("CVC 123 입니다");
  });

  it("hides inside every text of an item (a tool's command, output and detail) and keeps the rest", () => {
    const s = scrubber();
    const item = { kind: "tool", id: "t1", tool: "command", title: `curl -u me:${VALUE}`, detail: `echo ${VALUE}`, output: `ok ${VALUE}`, status: "completed", at: 2 } as unknown as TranscriptItem;
    const out = s.value(item) as unknown as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect(out.id).toBe("t1");
    expect(out.output).toBe("ok [비밀: 학교 포털]");
  });

  it("never lets a value split across two streaming pieces out live, and keeps the whole text", () => {
    const s = scrubber();
    const first = s.delta("s:a", `결과: ${VALUE.slice(0, 9)}`, "")!;
    expect(first.live).toBe("결과: ");
    expect(first.whole).toBe(`결과: ${VALUE.slice(0, 9)}`);
    const second = s.delta("s:a", `${VALUE.slice(9)} 끝`, "")!;
    expect(`${first.live}${second.live}`).toBe("결과: [비밀: 학교 포털] 끝");
    expect(second.whole).toBe("결과: [비밀: 학교 포털] 끝");
  });

  it("piece by piece, a character at a time, shows live what the whole text gives, never a value", () => {
    const s = scrubber();
    const whole = `가 ${VALUE} 나 ${encodeURIComponent(VALUE)} 다 ${VALUE}${VALUE} 라`;
    let out = "", kept = "";
    for (const char of whole) {
      const step = s.delta("s:b", char, "")!;
      out += step.live;
      kept = step.whole;
      expect(leaks(out)).toEqual([]);
      expect(leaks(kept)).toEqual([]);
    }
    expect(kept).toBe(s.text(whole));
    expect(out).toBe(s.text(whole));
  });

  it("keeps whole what is still being written; only the live copy holds a tail that begins a value", () => {
    const s = scrubber();
    const streaming: TranscriptItem = { kind: "assistant", id: "a", text: `지금 ${VALUE.slice(0, 10)}`, streaming: true, at: 1 };
    expect((s.value(streaming) as { text: string }).text).toBe(`지금 ${VALUE.slice(0, 10)}`);
    expect((s.live("k", streaming, s.value(streaming)) as { text: string }).text).toBe("지금 ");
    expect(s.release("k")).toEqual([""]);
    const plain: TranscriptItem = { kind: "assistant", id: "b", text: "지금 아무것도 아님", streaming: true, at: 1 };
    expect(s.live("j", plain, plain)).toBe(plain);
  });

  it("follows a rename and forgets a removed entry", () => {
    const s = scrubber();
    s.set("e1", "포털", [VALUE]);
    expect(s.text(VALUE)).toBe("[비밀: 포털]");
    s.remove("e1");
    expect(s.active).toBe(false);
  });
});

describe("fix round 2 (review N2): a secret is hidden wherever it appears", () => {
  it("hides a 2-class password and a Hangul value glued to Korean particles or to a word", () => {
    const s = new TranscriptScrubber();
    s.set("p", "포털", ["zzpass2024"]);
    s.set("w", "단어", ["zzsunshine"]);
    s.set("k", "한글", ["비밀한글열쇠말들"]);
    expect(s.text("비밀번호는 zzpass2024입니다")).toBe("비밀번호는 [비밀: 포털]입니다");
    expect(s.text("zzsunshine을 넣었어요")).toBe("[비밀: 단어]을 넣었어요");
    expect(s.text("pw: zzpass2024이에요")).toBe("pw: [비밀: 포털]이에요");
    expect(s.text("user_zzpass2024")).toBe("user_[비밀: 포털]");
    expect(s.text("비밀한글열쇠말들입니다")).toBe("[비밀: 한글]입니다");
  });

  it("finds a card number however it was typed and written: compact, 4-4-4-4 and 4-6-5, with spaces or dashes", () => {
    const typed = new TranscriptScrubber();
    typed.set("c", "카드", ["4000 1234 5678 9010"]);
    for (const form of ["4000123456789010", "4000 1234 5678 9010", "4000-1234-5678-9010"]) expect(typed.text(`번호 ${form} 끝`)).toBe("번호 [비밀: 카드] 끝");
    const amex = new TranscriptScrubber();
    amex.set("a", "아멕스", ["371234567890123"]);
    for (const form of ["371234567890123", "3712 345678 90123", "3712-345678-90123"]) expect(amex.text(`번호 ${form}`)).toBe("번호 [비밀: 아멕스]");
  });

  it("still leaves a digits-only value inside a longer number alone", () => {
    const s = new TranscriptScrubber();
    s.set("n", "학번", ["20261113"]);
    expect(s.text("전화 0102026111356, 학번 20261113")).toBe("전화 0102026111356, 학번 [비밀: 학번]");
  });
});

describe("fix round 3 (re-review 2, minor): text fields only", () => {
  it("a secret equal to an enum word never rewrites a structural field; the same word in text is hidden", () => {
    const s = new TranscriptScrubber();
    s.set("e", "단어", ["completed"]);
    const item = { kind: "tool", id: "t1", tool: "completed", title: "completed 단계", detail: null, output: "completed", status: "completed", at: 1 };
    const shown = s.value(item) as Record<string, unknown>;
    expect(shown.status).toBe("completed");
    expect(shown.kind).toBe("tool");
    expect(shown.tool).toBe("completed");
    expect(shown.title).toBe("[비밀: 단어] 단계");
    expect(shown.output).toBe("[비밀: 단어]");
    const session = { id: "s", status: "completed", provider: "completed", model: "completed", effort: "completed", access: "completed", mode: "completed", role: "completed", type: "completed", level: "completed", preview: "completed" };
    const shownSession = s.value(session) as Record<string, unknown>;
    for (const key of ["status", "provider", "model", "effort", "access", "mode", "role", "type", "level"]) expect(shownSession[key], key).toBe("completed");
    expect(shownSession.preview).toBe("[비밀: 단어]");
    // Keys are never rewritten.
    expect(Object.keys(s.value({ completed: "x" }) as object)).toEqual(["completed"]);
  });
});
