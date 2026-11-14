import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Redactor } from "./redact.ts";
import { senderOf } from "./telegram.ts";
import { cleanKits, pair, say, settle, startKit, until } from "./test-kit.ts";

// Unit 4, fix round 1: the leftovers of the units 1–3 re-review that are fixed after the merge,
// and the sender's name as the PC shows it.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanKits(); });

const BOT = "7000000001";

describe("start and close", () => {
  it("a close that lands while the core is starting wins: nothing is armed after it, and it never listens", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    await kit.core.close();
    // The turn ends while the channel is closed: its answer is owed at the next start.
    kit.engine.say(sessionId, "요약했습니다.");
    kit.engine.finish(sessionId);
    let open!: () => void;
    kit.adapter.sendGate = new Promise<void>((done) => { open = done; });
    const intervals = vi.spyOn(globalThis, "setInterval");
    const starting = kit.core.start();
    await until(() => kit.adapter.waiting === 1);
    await kit.core.close();
    kit.adapter.sendGate = null;
    open();
    await starting;
    expect(intervals).not.toHaveBeenCalled();
    expect(kit.core.running).toBe(false);
    expect(kit.adapter.state.state).toBe("stopped");
  });
});

describe("what reaches a closed chat", () => {
  it("sends no typing mark to a chat paused while its status line was on its way", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    let open!: () => void;
    kit.adapter.sendGate = new Promise<void>((done) => { open = done; });
    await kit.adapter.deliver(kit.adapter.message("요약해 줘"));
    await until(() => kit.adapter.waiting === 1);
    kit.core.pause(binding.id, true);
    kit.adapter.sendGate = null;
    open();
    await settle(kit);
    expect(kit.adapter.typings).toEqual([]);
  });

  it("says once that answers were held, however quickly the PC pauses and resumes", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.core.pause(binding.id, true);
    kit.engine.finish(sessionId);
    await settle(kit);
    kit.core.pause(binding.id, false);
    kit.core.pause(binding.id, true);
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text.startsWith("채널을 멈춰 둔 동안"))).toHaveLength(1);
    expect(kit.adapter.texts().filter((text) => text === "요약했습니다.")).toHaveLength(1);
  });

  it("makes an answer's buttons once, however often the answer is tried again", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "표를 넣어 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "어디에 넣을까요?\n[[선택: 본문 끝 | 새 문서]]");
    kit.adapter.failures.push("no", "no", "no");
    kit.engine.finish(sessionId);
    await settle(kit);
    const answered = () => kit.adapter.sent.some((entry) => entry.out.buttons?.length);
    for (let round = 0; round < 20 && !answered(); round += 1) { kit.clock.now += 120_000; await kit.core.pulse(); await settle(kit); }
    expect(kit.adapter.failures).toHaveLength(0);
    const tokens = kit.adapter.last()!.out.buttons!.flat().map((button) => button.token);
    const made = new DatabaseSync(join(kit.dataDir, "state.sqlite"), { readOnly: true });
    const rows = made.prepare("SELECT token FROM channel_buttons").all();
    made.close();
    expect(rows.map((row) => String(row.token)).sort()).toEqual([...tokens].sort());
  });
});

describe("answers that may not have arrived", () => {
  it("are counted for the PC, apart from the refused ones, and are not sent again", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.adapter.failures.push("unknown");
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.core.uncertain(binding.id)).toMatchObject({ count: 1 });
    expect(kit.core.undelivered(binding.id)).toBeNull();
    for (let round = 0; round < 5; round += 1) { kit.clock.now += 60_000; await kit.core.pulse(); }
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text === "요약했습니다.")).toHaveLength(0);
    // Something that reaches the chat afterwards starts the count again.
    await say(kit, "상태");
    await say(kit, "다음 일");
    const next = kit.engine.sent[1]!.sessionId;
    kit.engine.say(next, "끝냈습니다.");
    kit.engine.finish(next);
    await settle(kit);
    expect(kit.core.uncertain(binding.id)).toBeNull();
  });
});

describe("pairing", () => {
  it("a new pairing started at the PC clears every sender's wrong values and refusal, so the owner cannot lock themselves out for good", async () => {
    const kit = await startKit();
    kit.core.beginPairing("telegram", BOT);
    for (let attempt = 0; attempt < 5; attempt += 1) await kit.adapter.deliver(kit.adapter.message(`/start old-qr-value-${attempt}-012345`, { userId: "555" }));
    expect(kit.core.pairing("telegram", BOT).refusedSenders).toMatchObject([{ userId: "555" }]);
    const { code } = kit.core.beginPairing("telegram", BOT);
    expect(kit.core.pairing("telegram", BOT).refusedSenders).toEqual([]);
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    expect(kit.core.pairing("telegram", BOT).request).toMatchObject({ userId: "555" });
  });

  it("tells the PC after a contested scan what happened and what to do", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "666", from: kit.adapter.person("666", "홍길동", "owner") }));
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    expect(kit.core.pairing("telegram", BOT).notice).toBe("두 계정이 같은 연결 값을 냈습니다. 다른 사람이 화면의 QR을 보았을 수 있습니다. 화면을 가리고(화면 공유·프로젝터를 끄고) 다시 시작해 주세요.");
  });
});

describe("the sender as the PC shows it", () => {
  it("takes out control and formatting characters (direction overrides, zero-width) and keeps at most 64 characters", () => {
    const sender = senderOf({ id: 123456789, first_name: "홍길동‮ 승인함", last_name: `${"가".repeat(100)}​`, username: "hong" });
    expect(sender.userId).toBe("123456789");
    expect(sender.displayName).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(sender.displayName.startsWith("홍길동 승인함 가")).toBe(true);
    expect(sender.displayName.length).toBeLessThanOrEqual(64);
    expect(sender.handle).toBe("hong");
  });

  it("falls back to the handle, then the number, when the name is nothing but invisible characters", () => {
    expect(senderOf({ id: 7, first_name: "‮​", username: "x_y" }).displayName).toBe("x_y");
    expect(senderOf({ id: 7, first_name: "⁦" }).displayName).toBe("7");
  });
});

describe("cutting text without Intl.Segmenter", () => {
  it("loads without it and still never splits a surrogate pair", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    const { cutAt } = await import("./shape.ts");
    // Loading the store (which imports the cut) must not fail either.
    await import("../store.ts");
    const text = "가" + "😀".repeat(10);
    for (let limit = 1; limit < text.length; limit += 1) {
      const cut = cutAt(text, limit);
      expect(cut.length).toBeLessThanOrEqual(limit);
      const last = cut.charCodeAt(cut.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff, `limit ${limit}`).toBe(false);
    }
  });

  it("with it, cuts at character boundaries (a joined emoji stays whole)", async () => {
    vi.resetModules();
    const { cutAt } = await import("./shape.ts");
    const family = "👨‍👩‍👧";
    expect(cutAt(`가${family}`, 4)).toBe("가");
  });
});

describe("secrets printed by tools, in what goes to the chat", () => {
  const redactor = new Redactor();
  it.each([
    ["OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123", "sk-proj-"],
    ["키: sk-a" + "nt-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345", "sk-ant-"],
    ["curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijk' https://x", "eyJhbGciOiJIUzI1NiJ9"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==", "dXNlcjpwYXNzd29yZDEyMzQ1Ng"],
    ["token=Bearer abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx"],
    ["AWS 키 AKIAIOSFODNN7EXAMPLE 입니다", "AKIAIOSFODNN7EXAMPLE"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAA"],
  ])("hides %s", (text, secret) => {
    const out = redactor.apply(text);
    expect(out).not.toContain(secret);
  });

  it.each([
    "Bearer of good news: 다음 주 휴강입니다.",
    "Authorization: 학과장 승인 필요",
    "task-force-meeting-schedule-2026 회의록과 sk-ill 연습",
  ])("leaves an ordinary line alone: %s", (text) => {
    expect(redactor.apply(text)).toBe(text);
  });
});
