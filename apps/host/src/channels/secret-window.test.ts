import { describe, expect, it } from "vitest";
import { AGAIN_MS, bareCode, codeIn, codeLike, codeShaped, codeTake, HOLD_MS, LATE_MS,linkShaped, SecretWindows, WINDOW_MS, type EndReason } from "./secret-window.ts";
import type { ChatRef } from "./types.ts";

// The chat's secret input on its own: which message it takes, for whom, until when. Made-up values only.
const chat: ChatRef = { kind: "telegram", botId: "7000000001", chatId: "555", chatType: "dm" };
const person = { userId: "555", displayName: "홍길동" };
function windows() {
  const meta = new Map<string, string>(), clock = { now: 1_000_000 };
  const ended: EndReason[] = [];
  const w = new SecretWindows({ getMeta: (key) => meta.get(key) ?? null, setMeta: (key, value) => void meta.set(key, value) }, { pending: () => ({ fields: ["키"], next: 0 }), ended: (_chat, _input, reason) => void ended.push(reason) }, () => clock.now);
  return { w, meta, clock, ended };
}
const message = (id: number, extra: Record<string, unknown> = {}) => ({ message_id: id, date: 1, ...extra });

describe("SecretWindows", () => {
  it("takes only the next messages of the one chat and person it was opened for, one field each, and keeps no value in what it writes", () => {
    const { w, meta } = windows();
    w.open(chat, { userId: "555", handoffId: "h1", fields: ["아이디", "비밀번호"], from: 0, mode: "text" });
    expect(w.divert({ eventId: "1", chat: { ...chat, chatId: "556" }, from: { ...person, userId: "556" }, message: message(1, { text: "zz-secret-a-0012" }), edited: false })).toBeNull();
    expect(w.divert({ eventId: "1b", chat, from: { ...person, userId: "556" }, message: message(1, { text: "zz-secret-a-0012" }), edited: false })).toBeNull();
    expect(w.divert({ eventId: "2", chat: { ...chat, chatId: "-100", chatType: "group" }, from: person, message: message(2, { text: "zz-secret-a-0012" }), edited: false })).toBeNull();
    expect(w.divert({ eventId: "3", chat, from: person, message: message(3, { text: "zz-secret-a-0012" }), edited: false })).toMatchObject({ type: "secret", handoffId: "h1", field: 0, outcome: "value", messageId: "3" });
    expect(w.divert({ eventId: "4", chat, from: person, message: message(4, { text: "zz-secret-b-0012" }), edited: false })).toMatchObject({ field: 1, outcome: "value" });
    // Both fields given: the input is closed, the next line is the person's ordinary words.
    expect(w.divert({ eventId: "5", chat, from: person, message: message(5, { text: "고마워" }), edited: false })).toBeNull();
    expect(w.take(chat, "3")).toBe("zz-secret-a-0012");
    expect(w.take(chat, "3")).toBeUndefined();
    expect([...meta.values()].join("")).not.toContain("zz-secret");
  });

  it("runs out after ten minutes: the tick ends it once (said); a line that finds it run out before the tick is caught (not a value, kept for [그대로 보내기]), then the chat is ordinary (fix round 4)", async () => {
    const { w, clock, ended } = windows();
    w.open(chat, { userId: "555", handoffId: "h1", fields: ["키"], from: 0, mode: "text" });
    clock.now += WINDOW_MS + 1;
    expect(w.divert({ eventId: "1", chat, from: person, message: message(1, { text: "zz-secret-late-0012" }), edited: false })).toMatchObject({ outcome: "caught", handoffId: "h1", field: 1 });
    expect(w.take(chat, "1")).toBeUndefined();
    expect(w.release(chat, "1")?.text).toBe("zz-secret-late-0012");
    expect(w.release(chat, "1")).toBeUndefined();
    expect(w.divert({ eventId: "2", chat, from: person, message: message(2, { text: "보통 글" }), edited: false })).toBeNull();
    await Promise.resolve();
    expect(ended).toEqual(["timeout"]);
    // By the tick: ended once, said once.
    w.open(chat, { userId: "555", handoffId: "h2", fields: ["키"], from: 0, mode: "text" });
    clock.now += WINDOW_MS + 1;
    w.sweep(chat);
    w.sweep(chat);
    await Promise.resolve();
    expect(ended).toEqual(["timeout", "timeout"]);
    expect(w.divert({ eventId: "3", chat, from: person, message: message(3, { text: "zz-secret-late-0012" }), edited: false })).toBeNull();
  });

  it("a delivery again of a handled message does not put its value back in memory", () => {
    const { w } = windows();
    w.open(chat, { userId: "555", handoffId: "h1", fields: ["키"], from: 0, mode: "text" });
    w.divert({ eventId: "7", chat, from: person, message: message(7, { text: "zz-secret-d-0012" }), edited: false });
    w.take(chat, "7");
    w.markHandled(chat, "7");
    expect(w.divert({ eventId: "7", chat, from: person, message: message(7, { text: "zz-secret-d-0012" }), edited: false })).toMatchObject({ outcome: "value" });
    expect(w.take(chat, "7")).toBeUndefined();
  });

  it("lets the app's words through and stays open; a word that starts something else ends it there (fix round 4, P1); takes a Mini App answer nobody asked for as stray", async () => {
    const { w, ended } = windows();
    w.open(chat, { userId: "555", handoffId: "h1", fields: ["키"], from: 0, mode: "text" });
    expect(w.divert({ eventId: "0", chat, from: person, message: message(1, { text: "상태" }), edited: false })).toBeNull();
    expect(w.current(chat)).not.toBeNull();
    expect(w.divert({ eventId: "1", chat, from: person, message: message(1, { text: "멈춰" }), edited: false })).toBeNull();
    expect(w.current(chat)).toBeNull();
    await Promise.resolve();
    expect(ended).toEqual(["word"]);
    expect(w.divert({ eventId: "2", chat, from: person, message: message(2, { web_app_data: { data: "{}" } }), edited: false })).toMatchObject({ outcome: "stray" });
  });

  it("takes a message delivered again the same way as the first time, also once the input is closed", () => {
    const { w } = windows();
    w.open(chat, { userId: "555", handoffId: "h1", fields: ["키"], from: 0, mode: "text" });
    const first = w.divert({ eventId: "9", chat, from: person, message: message(9, { text: "zz-secret-c-0012" }), edited: false });
    w.take(chat, "9");
    expect(w.divert({ eventId: "9", chat, from: person, message: message(9, { text: "zz-secret-c-0012" }), edited: false })).toEqual(first);
    expect(w.take(chat, "9")).toBe("zz-secret-c-0012");
  });
});

describe("fix round 2", () => {
  it("a line long after an input ran out (over LATE_MS) is not caught", () => {
    const { w, clock } = windows();
    w.open(chat, { userId: "555", handoffId: "h1", fields: ["키"], from: 0, mode: "text" });
    clock.now += WINDOW_MS + LATE_MS + 1;
    expect(w.divert({ eventId: "1", chat, from: person, message: message(1, { text: "한참 뒤의 보통 글" }), edited: false })).toBeNull();
  });

  it("ends with its hand-over: no input, no 'late', no reply-to for it", () => {
    const { w, clock } = windows();
    w.open(chat, { userId: "555", handoffId: "h1", fields: ["키"], from: 0, mode: "text" });
    w.asked(chat, "77", "h1", "555");
    w.end(chat, { handoffId: "h1" }, "over");
    w.forget(chat, "h1");
    expect(w.divert({ eventId: "1", chat, from: person, message: message(1, { text: "보통 글" }), edited: false })).toBeNull();
    clock.now += WINDOW_MS + 1;
    expect(w.divert({ eventId: "2", chat, from: person, message: message(2, { text: "답장", reply_to_message: { message_id: 77 } }), edited: false })).toBeNull();
  });

  it("a code input: app words go their way, a code is taken, a line with exactly one candidate gives that candidate, anything else is held (said once)", () => {
    const meta = new Map<string, string>(), clock = { now: 1_000_000 };
    const w = new SecretWindows({ getMeta: (key) => meta.get(key) ?? null, setMeta: (key, value) => void meta.set(key, value) }, { pending: () => ({ fields: ["인증번호"], next: 0 }), takes: (_id, text) => codeTake(text) }, () => clock.now);
    w.open(chat, { userId: "555", handoffId: "s_code", fields: ["인증번호"], from: 0, mode: "text" });
    expect(w.divert({ eventId: "1", chat, from: person, message: message(1, { text: "도움말" }), edited: false })).toBeNull();
    expect(w.divert({ eventId: "2", chat, from: person, message: message(2, { text: "잠깐만 기다려 줘" }), edited: false })).toMatchObject({ outcome: "held", field: 0 });
    expect(w.divert({ eventId: "2b", chat, from: person, message: message(3, { text: "아직이야" }), edited: false })).toMatchObject({ outcome: "held", field: 1 });
    expect(w.take(chat, "2")).toBeUndefined();
    expect(w.divert({ eventId: "3", chat, from: person, message: message(4, { text: "[Web발신] 인증번호 [482913]를 입력해 주세요" }), edited: false })).toMatchObject({ outcome: "value", handoffId: "s_code" });
    expect(w.take(chat, "3")).toBe("482913");
    for (const [text, like] of [["482913", true], ["AB-12-CD", true], ["123", false], ["12345678901", false], ["이어서", false], ["4829 13", true]] as const) expect(codeLike(text), text).toBe(like);
    for (const [text, code] of [
      ["[Web발신] [도서관] 인증번호 [482913]를 입력해 주세요", "482913"],
      ["인증번호 482913 이에요", "482913"],
      ["482913.", "482913"],
      ["G-482913 is your verification code", "482913"],
      ["Your code: A1B2C3", "A1B2C3"],
      ["코드는 (XY12Z9) 입니다", "XY12Z9"],
      ["[KB국민카드] 인증번호 482913 2026.11.13 10:30 결제 12,000원", "482913"],
      ["인증번호 482913 다시 보냄: 482913", "482913"],
      ["010-1234-5678 로 보냈습니다", null],
      ["1234 5678 9012", null],
      ["인증번호 482913 또는 135790", null],
      ["2026년 11월 13일", null],
      ["123456789", null],
      ["[NAVER] 로그인 알림", null],
      ["code expires soon", null],
    ] as const) expect(codeIn(text), text).toBe(code);
  });

  it("after a code step's value was taken, the same code again (kept as a keyed hash, in memory) or a code's shape is caught for two minutes, then the chat is ordinary", () => {
    const { w, clock, meta } = windows();
    w.open(chat, { userId: "555", handoffId: "s_code", fields: ["인증번호"], from: 0, mode: "text", catches: "code" });
    w.typed(chat, "482913");
    w.end(chat, { handoffId: "s_code" }, "taken");
    for (const [index, text] of ["고마워", "thanks", "okay", "done", "next"].entries()) expect(w.divert({ eventId: `w${index}`, chat, from: person, message: message(10 + index, { text }), edited: false }), text).toBeNull();
    expect(w.divert({ eventId: "2", chat, from: person, message: message(2, { text: "482913" }), edited: false })).toMatchObject({ outcome: "caught", handoffId: "s_code" });
    expect(w.divert({ eventId: "3", chat, from: person, message: message(3, { text: "[Web발신] 인증번호 [482913]" }), edited: false })).toMatchObject({ outcome: "caught" });
    expect(w.divert({ eventId: "4", chat, from: person, message: message(4, { text: "135 790" }), edited: false })).toMatchObject({ outcome: "caught" });
    expect(w.divert({ eventId: "4b", chat, from: person, message: message(4, { text: "482913 넣었어?" }), edited: false })).toMatchObject({ outcome: "caught", field: 2 });
    expect(w.take(chat, "2")).toBeUndefined();
    expect([...meta.values()].join("")).not.toContain("482913");
    clock.now += AGAIN_MS + 1;
    expect(w.divert({ eventId: "5", chat, from: person, message: message(5, { text: "482913" }), edited: false })).toBeNull();
  });

  // Re-review 5 (I-1): a step that SUCCEEDED says no closing line, so nothing warns the person — its two
  // minutes catch only the same code again, a bare code or a bare link, never the widened shapes.
  it("after a value was taken, ordinary short lines with a number or a link go on to the AI at once", () => {
    const { w } = windows();
    w.open(chat, { userId: "555", handoffId: "s_code", fields: ["인증번호"], from: 0, mode: "text", catches: "code" });
    w.typed(chat, "482913");
    w.end(chat, { handoffId: "s_code" }, "taken");
    for (const [index, text] of ["2025 보고서 열어 줘", "2025학년도 2학기 강의계획서 찾아줘", "학번 20231234 성적 알려줘", "내선 5678로 연결해 줘"].entries()) expect(w.divert({ eventId: `o${index}`, chat, from: person, message: message(20 + index, { text }), edited: false }), text).toBeNull();
    expect(w.divert({ eventId: "c1", chat, from: person, message: message(30, { text: "135790" }), edited: false })).toMatchObject({ outcome: "caught" });
    const page = "https://" + "example.com/lecture/plan";
    w.open(chat, { userId: "555", handoffId: "s_link", fields: ["로그인 링크"], from: 0, mode: "text", catches: "link" });
    w.end(chat, { handoffId: "s_link" }, "taken");
    for (const [index, text] of [`이거 봐줘 ${page}`, `${page} 요약해 줘`].entries()) expect(w.divert({ eventId: `l${index}`, chat, from: person, message: message(40 + index, { text }), edited: false }), text).toBeNull();
    expect(w.divert({ eventId: "l9", chat, from: person, message: message(49, { text: `<${page}>` }), edited: false })).toMatchObject({ outcome: "caught" });
  });
});

describe("fix round 4, ruling P2: the late catch is narrow by shape", () => {
  it("the text kept for [그대로 보내기] lives at most five minutes, in memory only: never in what the store holds", () => {
    const { w, meta, clock } = windows();
    w.open(chat, { userId: "555", handoffId: "s_code", fields: ["인증번호"], from: 0, mode: "text", catches: "code" });
    expect(w.divert({ eventId: "0", chat, from: person, message: message(1, { text: "멈춰" }), edited: false })).toBeNull();
    const sms = "[Web발신] 인증번호 [482913]를 입력해 주세요.";
    expect(w.divert({ eventId: "1", chat, from: person, message: message(2, { text: sms }), edited: false })).toMatchObject({ outcome: "caught" });
    expect(w.divert({ eventId: "2", chat, from: person, message: message(3, { text: "482913" }), edited: false })).toMatchObject({ outcome: "caught" });
    expect([...meta.values()].join("")).not.toContain("482913");
    expect(w.release(chat, "1")?.text).toBe(sms);
    clock.now += HOLD_MS + 1;
    expect(w.release(chat, "2")).toBeUndefined();
  });

  it("a code's shape: a bare code, or a code marker with exactly one candidate; ordinary lines with a number are not", () => {
    for (const text of ["482913", "482 913", "482-913", "A7K2Q9", "[Web발신]\n[도서관] 인증번호 [482913]를 입력해 주세요.", "인증 번호 482913", "Your verification code is 482913", "code: 482913", "OTP 482913", "확인코드 482913"]) expect(codeShaped(text), text).toBe(true);
    for (const text of ["회의는 1430호에서 해요", "2026-11-14", "문서 1500자로 써 줘", "room101", "이 code 2048 버전 고쳐줘", "인증서 갱신 문서 1500자로 써 줘", "2026년 예산 30000원", "다른 일 해 줘", "인증번호 482913 또는 135790"]) expect(codeShaped(text), text).toBe(false);
    expect(bareCode("2026.11.14")).toBe(false);
  });

  it("a link's shape: one link alone, or one link with a login marker", () => {
    for (const text of ["https://lib.example.ac.kr/magic?t=zz", "로그인 링크입니다 https://x.example/a", "Sign in: https://x.example/a", "verify https://x.example/a"]) expect(linkShaped(text), text).toBe(true);
    // Q3 (round 5): a short line with one link is caught now ("이 문서 <link> 참고해서 정리해 줘" has 11 other characters); a longer request passes.
    expect(linkShaped("이 문서 https://x.example/a 참고해서 정리해 줘")).toBe(true);
    for (const text of ["이 문서 https://x.example/a 참고해서 이번 주 회의 안건을 세 줄로 정리해 줘", "https://a.example https://b.example", "링크 없음"]) expect(linkShaped(text), text).toBe(false);
  });

  it("after an input ended without its value, for 30 minutes only its shape is caught (kept in memory for [그대로 보내기]); ordinary lines and app words go on", async () => {
    const { w, clock, ended } = windows();
    w.open(chat, { userId: "555", handoffId: "s_link", fields: ["로그인 링크"], from: 0, mode: "text", catches: "link" });
    expect(w.divert({ eventId: "0", chat, from: person, message: message(1, { text: "새 대화" }), edited: false })).toBeNull();
    for (const [index, text] of ["회의는 1430호에서 해요", "다른 일 해 줘", "482913", "도움말"].entries()) expect(w.divert({ eventId: `o${index}`, chat, from: person, message: message(10 + index, { text }), edited: false }), text).toBeNull();
    expect(w.divert({ eventId: "1", chat, from: person, message: message(1, { text: "https://lib.example.ac.kr/magic?t=zz" }), edited: false })).toMatchObject({ outcome: "caught", shape: "link" });
    expect(w.release(chat, "1")?.text).toBe("https://lib.example.ac.kr/magic?t=zz");
    clock.now += LATE_MS + 1;
    expect(w.divert({ eventId: "2", chat, from: person, message: message(2, { text: "https://lib.example.ac.kr/magic?t=zz" }), edited: false })).toBeNull();
    await Promise.resolve();
    expect(ended).toEqual(["word"]);
  });

  it("an input of an earlier run (the gateway restarted) ends at the first sweep (said), or is caught by the line that finds it", async () => {
    const meta = new Map<string, string>(), store = { getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => void meta.set(key, value) };
    const first = new SecretWindows(store, { pending: () => ({ fields: ["키"], next: 0 }) });
    first.open(chat, { userId: "555", handoffId: "h1", fields: ["키"], from: 0, mode: "text" });
    const ended: EndReason[] = [];
    const second = new SecretWindows(store, { pending: () => ({ fields: ["키"], next: 0 }), ended: (_c, _i, reason) => void ended.push(reason) });
    expect(second.current(chat)).toBeNull();
    expect(second.divert({ eventId: "1", chat, from: person, message: message(1, { text: "zz-secret-0012" }), edited: false })).toMatchObject({ outcome: "caught", field: 1 });
    expect(second.take(chat, "1")).toBeUndefined();
    await Promise.resolve();
    expect(ended).toEqual(["restart"]);
  });
});

describe("fix round 5, ruling Q3: the shapes are widened, one list of markers, digits made plain first", () => {
  const C = ["48", "29", "13"].join("");
  const wide = (digits: string) => [...digits].map((digit) => String.fromCharCode(0xff10 + Number(digit))).join("");
  const link = ["https://lib.example.ac.kr", "/magic?t=zz"].join("");
  it("caught after a code input ended: a marker (incl. a leading sender tag) with one candidate, or one candidate in a short line; full-width digits count", () => {
    for (const text of [`[국민은행] ${C}`, `Your code is ${C}`, `${C} is your Instagram code`, `[토스] 본인확인 번호 ${C}`, `보안코드 ${C}`, `확인번호 ${C}`, `일회용 비밀번호 ${C}`, wide(C), `[Web발신] 인증번호 ${wide(C)}`,
      `코드 ${C} 넣어 줘`, `${C} 입력해줘`, `여기요 ${C}`, `PIN ${C.slice(0, 4)}`, `passcode: ${C}`, `인증번호: ${C}, 문의 1588-1234`, `인증번호 ${C.slice(0, 3)} ${C.slice(3)} 입니다`, "보고서 2페이지에 2024 자료 넣어줘"]) expect(codeShaped(text), text).toBe(true);
  });
  it("passes: a run with a unit or counter, a date/time/phone/amount shape, a version, one number in a long request", () => {
    for (const text of ["회의는 1430호에서 해요", "문서 1500자로 써 줘", "2026-11-14", "14:30에 회의 잡아 줘", "010-1234-5678로 전화 달라고 메모해 줘", "이 code 2048 버전 고쳐줘", "책 1200쪽 분량", "₩15000 결제해 줘",
      `이번 주 학과 회의 자료를 정리하고 예산 표에서 ${C} 항목이 맞는지 봐 줘`, "OTP 기기 2개 주문해 줘", "2026년 예산 30000원"]) expect(codeShaped(text), text).toBe(false);
  });
  it("the open input's one candidate is found the same way, typed as ASCII digits", () => {
    expect(codeIn(`인증번호 ${wide(C)}`)).toBe(C);
    expect(codeIn(`${C.slice(0, 3)}-${C.slice(3)} 입력해줘`)).toBe(C);
    expect(codeTake(wide(C))).toEqual({ value: C });
  });
  it("a link's shape: one link with at most 20 other characters, brackets and quotes not counted; a longer request or two links pass", () => {
    for (const text of [link, `(${link})`, `<${link}>`, `"${link}"`, `<<${link}>>`, `메일 왔어요 <${link}>`, `링크 <${link}>`, `여기 링크요: ${link}`, `<${link}> 열어 줘`]) expect(linkShaped(text), text).toBe(true);
    for (const text of ["https://news.example.com/a 이 글 요약해 주고 중요한 내용만 세 줄로 정리해서 보내 줘", `${link} 와 https://news.example.com/b 두 글을 비교해 줘`]) expect(linkShaped(text), text).toBe(false);
  });
});

describe("fix round 5, rulings Q2 and Q4: whatever carries the words; catches do not cancel each other", () => {
  const C = ["48", "29", "13"].join("");
  it("a forward, a photo's caption and an edit are judged by their words after an input ended; the caption is kept with its files for [그대로 보내기]", () => {
    const { w } = windows();
    w.open(chat, { userId: "555", handoffId: "s_code", fields: ["인증번호"], from: 0, mode: "text", catches: "code" });
    expect(w.divert({ eventId: "0", chat, from: person, message: message(1, { text: "취소" }), edited: false })).toMatchObject({ outcome: "cancel" });
    expect(w.divert({ eventId: "1", chat, from: person, message: message(2, { text: `[Web발신] 인증번호 [${C}]`, forward_origin: { type: "user" } }), edited: false })).toMatchObject({ outcome: "caught", shape: "code" });
    const photo = { fileRef: "zz-photo", name: "photo-3.jpg", mime: "image/jpeg", size: 9, kind: "photo" as const };
    expect(w.divert({ eventId: "2", chat, from: person, message: message(3, { caption: `캡처요 인증번호 ${C}`, photo: [{ file_id: "zz-photo" }] }), edited: false, files: [photo] })).toMatchObject({ outcome: "caught" });
    expect(w.release(chat, "2")).toEqual({ text: `캡처요 인증번호 ${C}`, files: [photo] });
    expect(w.divert({ eventId: "3", chat, from: person, message: message(4, { text: `여기 ${C}` }), edited: true })).toMatchObject({ outcome: "caught" });
    expect(w.divert({ eventId: "4", chat, from: person, message: message(5, { caption: "이거 표로 정리해 줘", photo: [{ file_id: "zz-photo2" }] }), edited: false })).toBeNull();
  });
  it("a code input ended, then a link input opened and was cancelled: the code's SMS is still caught (each for its own 30 minutes)", () => {
    const { w, clock } = windows();
    w.open(chat, { userId: "555", handoffId: "s_code", fields: ["인증번호"], from: 0, mode: "text", catches: "code" });
    expect(w.divert({ eventId: "0", chat, from: person, message: message(1, { text: "멈춰" }), edited: false })).toBeNull();
    clock.now += 60_000;
    w.open(chat, { userId: "555", handoffId: "s_link", fields: ["로그인 링크"], from: 0, mode: "text", catches: "link" });
    expect(w.divert({ eventId: "1", chat, from: person, message: message(2, { text: "취소" }), edited: false })).toMatchObject({ outcome: "cancel" });
    expect(w.divert({ eventId: "2", chat, from: person, message: message(3, { text: `[Web발신] 인증번호 [${C}]` }), edited: false })).toMatchObject({ outcome: "caught", handoffId: "s_code", shape: "code" });
    expect(w.divert({ eventId: "3", chat, from: person, message: message(4, { text: "https://lib.example.ac.kr/magic?t=zz" }), edited: false })).toMatchObject({ outcome: "caught", handoffId: "s_link", shape: "link" });
    clock.now += LATE_MS - 30_000;
    expect(w.divert({ eventId: "4", chat, from: person, message: message(5, { text: C }), edited: false })).toBeNull();
    expect(w.divert({ eventId: "5", chat, from: person, message: message(6, { text: "https://lib.example.ac.kr/magic?t=zz" }), edited: false })).toMatchObject({ outcome: "caught" });
  });
});
