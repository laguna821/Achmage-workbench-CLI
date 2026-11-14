import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanKits, pair, press, restartKit, say, sessionOf, settle, startKit, tick, until, userItems } from "./test-kit.ts";

// The channel runs what the paired person writes without asking. These are the only gates, so each
// is tested as a gate: pairing approved at the PC, everyone else refused, direct chats only, pause
// and lock, an instant stop, buttons bound to one question and one person, and the audit trail.

afterEach(cleanKits);

const BOT = "7000000001";
const thrown = (run: () => unknown): unknown => { try { run(); } catch (error) { return error; } return null; };

describe("pairing", () => {
  it("connects the phone that opened the PC's one-time link, after the PC approves the same four digits", async () => {
    const kit = await startKit();
    const { code, expiresAt } = kit.core.beginPairing("telegram", BOT);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBe(kit.clock.now + 10 * 60_000);
    // Only a hash of the value is kept.
    expect(JSON.stringify(kit.store.metaEntries("channel."))).not.toContain(code);

    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`));
    const request = kit.core.pairing("telegram", BOT).request!;
    expect(request).toMatchObject({ displayName: "홍길동", handle: "hong" });
    expect(request.digits).toMatch(/^\d{4}$/);
    expect(kit.adapter.texts()).toEqual([`PC 화면에 같은 숫자가 보이면 PC에서 [연결]을 눌러 주세요: ${request.digits.split("").join(" ")}`]);
    // Not connected until the PC says so: a message now runs nothing.
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent).toEqual([]);
    expect(kit.core.bindings()).toEqual([]);

    const binding = await kit.core.approvePairing("telegram", BOT, request.id);
    expect(binding).toMatchObject({ kind: "telegram", botId: BOT, chatId: "555", userId: "555", displayName: "홍길동", revokedAt: null });
    expect(kit.adapter.texts().at(-1)).toBe("연결되었습니다. 이제 하고 싶은 일을 그냥 적어 보내세요. 다른 기능은 '메뉴'라고 보내면 나옵니다.");
    expect(kit.core.pairing("telegram", BOT)).toMatchObject({ expiresAt: null, request: null });
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent.map((turn) => turn.requestId)).toHaveLength(1);
  });

  it("never writes the one-time value to disk, not even in the record of the message that carried it", async () => {
    // Telegram's deep link sends one space; a value typed by hand may come after a tab, a line break or two spaces.
    for (const gap of [" ", "\t", "\n", "  "]) {
      const kit = await startKit();
      const { code } = kit.core.beginPairing("telegram", BOT);
      const event = kit.adapter.message(`/start${gap}${code} `);
      // As the Telegram adapter does: written to the inbox with the offset first, then handed over.
      kit.store.channels.record("telegram", BOT, [{ eventId: event.eventId, payload: JSON.stringify(event) }], "1");
      await kit.adapter.deliver(event);
      await settle(kit);
      // It still pairs: the value is used from memory.
      expect(kit.core.pairing("telegram", BOT).request, JSON.stringify(gap)).not.toBeNull();
      const files = readdirSync(kit.dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(readFileSync(join(file.parentPath, file.name), "latin1").includes(code), `${file.name} ${JSON.stringify(gap)}`).toBe(false);
    }
  });

  it("shows the same digits again to the same phone opening the link twice (a re-sent update is not a second request)", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    const first = kit.core.pairing("telegram", BOT).request!;
    // The PC is shown who it is by number and handle, not only by the name anyone can set.
    expect(first).toMatchObject({ userId: "555", handle: "hong", displayName: "홍길동" });
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    expect(kit.core.pairing("telegram", BOT).request).toEqual(first);
    expect(kit.adapter.texts("555")).toHaveLength(2);
  });

  it("cancels the pairing when a second account presents the right value: nobody is paired, both chats and the PC are told, nobody is counted", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    // A stranger who saw the QR (a projector, a shared screen) opens it first; the owner scans second.
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "666", from: kit.adapter.person("666", "홍길동", "hong_") }));
    const stranger = kit.core.pairing("telegram", BOT).request!;
    expect(stranger).toMatchObject({ userId: "666", handle: "hong_" });
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    await settle(kit);
    const pairing = kit.core.pairing("telegram", BOT);
    expect(pairing).toMatchObject({ expiresAt: null, request: null, lockedUntil: null });
    expect(pairing.notice).toBe("두 계정이 같은 연결 값을 냈습니다. 다른 사람이 화면의 QR을 보았을 수 있습니다. 화면을 가리고(화면 공유·프로젝터를 끄고) 다시 시작해 주세요.");
    await expect(kit.core.approvePairing("telegram", BOT, stranger.id)).rejects.toMatchObject({ status: 404 });
    expect(kit.core.bindings()).toEqual([]);
    // Each chat gets one line; neither is told the bot is private, neither gets digits.
    const line = "이 연결은 취소되었습니다. 같은 연결 링크를 다른 계정도 열었습니다. PC에서 다시 시작해 주세요.";
    expect(kit.adapter.texts("555")).toEqual([line]);
    expect(kit.adapter.texts("666").slice(1)).toEqual([line]);
    expect(kit.core.auditList().find((row) => row.action === "pairing.contested")).toMatchObject({ target: "user:555" });
    // Not a wrong value against anyone: four wrong values more do not lock either account out.
    const again = kit.core.beginPairing("telegram", BOT);
    expect(kit.core.pairing("telegram", BOT).notice).toBeNull();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await kit.adapter.deliver(kit.adapter.message(`/start wrong-value-${attempt}-0123456789`, { userId: "555" }));
      await kit.adapter.deliver(kit.adapter.message(`/start wrong-value-${attempt}-0123456789`, { userId: "666" }));
    }
    await kit.adapter.deliver(kit.adapter.message(`/start ${again.code}`, { userId: "555" }));
    expect(kit.core.pairing("telegram", BOT).request).toMatchObject({ userId: "555" });
  });

  it("lets the link expire after ten minutes, and the phone's request with it", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    kit.clock.now += 10 * 60_000 + 1;
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`));
    expect(kit.core.pairing("telegram", BOT).request).toBeNull();
    expect(kit.adapter.texts().at(-1)).toContain("만료");

    const again = kit.core.beginPairing("telegram", BOT);
    await kit.adapter.deliver(kit.adapter.message(`/start ${again.code}`));
    const request = kit.core.pairing("telegram", BOT).request!;
    kit.clock.now += 10 * 60_000 + 1;
    await expect(kit.core.approvePairing("telegram", BOT, request.id)).rejects.toMatchObject({ status: 409, code: "channel_pairing_expired" });
    expect(kit.core.bindings()).toEqual([]);
  });

  it("refuses for an hour a sender with five wrong values in ten minutes, and tells the PC, without touching the owner's pairing", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    // The owner opened the link; a stranger then tries values.
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "555" }));
    const owner = kit.core.pairing("telegram", BOT).request!;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await kit.adapter.deliver(kit.adapter.message(`/start wrong-value-${attempt}-0123456789`, { userId: "999", from: kit.adapter.person("999", "남", "stranger") }));
    }
    const pairing = kit.core.pairing("telegram", BOT);
    expect(pairing.request).toEqual(owner);
    expect(pairing.lockedUntil).toBeNull();
    expect(pairing.refusedSenders).toEqual([{ userId: "999", displayName: "남", handle: "stranger", until: kit.clock.now + 60 * 60_000 }]);
    expect(kit.core.auditList().find((row) => row.action === "pairing.sender_locked")).toMatchObject({ target: "user:999" });
    // The owner's request is still there to approve; the PC can still start a new link.
    expect((await kit.core.approvePairing("telegram", BOT, owner.id)).userId).toBe("555");
    // A new pairing started at the PC clears the refusal (so the owner can never lock themselves
    // out for good; round 1 of unit 4); the four digits at the PC remain the defence.
    const again = kit.core.beginPairing("telegram", BOT, { additional: true });
    expect(kit.core.pairing("telegram", BOT).refusedSenders).toEqual([]);
    await kit.adapter.deliver(kit.adapter.message(`/start ${again.code}`, { userId: "999" }));
    expect(kit.core.pairing("telegram", BOT).request).toMatchObject({ userId: "999" });
  });

  it("counts wrong values per sender: five senders with one each lock nobody, and four spread over more than ten minutes do not count", async () => {
    const kit = await startKit();
    kit.core.beginPairing("telegram", BOT);
    for (let attempt = 0; attempt < 5; attempt += 1) await kit.adapter.deliver(kit.adapter.message(`/start wrong-${attempt}-0123456789abc`, { userId: `9${attempt}` }));
    expect(kit.core.pairing("telegram", BOT).refusedSenders).toEqual([]);
    for (let attempt = 0; attempt < 4; attempt += 1) await kit.adapter.deliver(kit.adapter.message(`/start wrong-${attempt}-0123456789abc`, { userId: "95" }));
    kit.clock.now += 10 * 60_000 + 1;
    await kit.adapter.deliver(kit.adapter.message("/start wrong-late-0123456789abc", { userId: "95" }));
    expect(kit.core.pairing("telegram", BOT)).toMatchObject({ lockedUntil: null, refusedSenders: [] });
  });

  it("connects nobody when the PC says no", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`));
    const request = kit.core.pairing("telegram", BOT).request!;
    await kit.core.declinePairing("telegram", BOT, request.id);
    expect(kit.core.bindings()).toEqual([]);
    expect(kit.core.pairing("telegram", BOT).request).toBeNull();
    await expect(kit.core.approvePairing("telegram", BOT, request.id)).rejects.toMatchObject({ status: 404 });
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent).toEqual([]);
  });

  it("keeps one owner per bot: no second link while someone is connected, unless the PC asks to add a person", async () => {
    const kit = await startKit();
    await pair(kit);
    expect(thrown(() => kit.core.beginPairing("telegram", BOT))).toMatchObject({ status: 409, code: "channel_owner_exists" });
    const { code } = kit.core.beginPairing("telegram", BOT, { additional: true });
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId: "777", from: kit.adapter.person("777", "동료", "peer") }));
    await kit.core.approvePairing("telegram", BOT, kit.core.pairing("telegram", BOT).request!.id);
    expect(kit.core.bindings().map((binding) => binding.userId)).toEqual(["555", "777"]);
  });

  it("disconnects at once: the chat is nobody again, and the turn it started sends nothing back", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "긴 보고서 써 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    const before = kit.adapter.sent.length;
    kit.core.revoke(binding.id);
    // The turn goes on at the PC; its answer is not sent to the chat.
    kit.engine.say(sessionId, "보고서를 다 썼습니다.");
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.adapter.sent.length).toBe(before);
    expect(kit.manager.items(sessionId).items.some((item) => item.kind === "assistant")).toBe(true);
    await say(kit, "하나 더 해 줘");
    expect(kit.engine.sent).toHaveLength(1);
    expect(kit.core.bindings()[0]!.revokedAt).toBe(kit.clock.now);
  });
});

describe("everyone else", () => {
  it("runs nothing for a stranger, tells them once a day that the bot is private, and records it once", async () => {
    const kit = await startKit();
    await pair(kit);
    for (const text of ["안녕", "파일 지워 줘", "/start"]) await say(kit, text, { userId: "999" });
    expect(kit.engine.sent).toEqual([]);
    expect(kit.adapter.texts("999")).toEqual(["이 봇은 개인용입니다."]);
    expect(kit.core.auditList().filter((row) => row.action === "refused" && row.result === "stranger")).toHaveLength(1);
    kit.clock.now += 24 * 60 * 60_000 + 1;
    await say(kit, "아직도?", { userId: "999" });
    expect(kit.adapter.texts("999")).toEqual(["이 봇은 개인용입니다.", "이 봇은 개인용입니다."]);
    // What the stranger wrote is nowhere: not in the audit trail, not in the log.
    expect(JSON.stringify(kit.core.auditList()) + kit.lines.join("\n")).not.toContain("파일 지워 줘");
  });

  it("works in direct chats only: in a group it runs nothing, says nothing and leaves, even for the owner", async () => {
    const kit = await startKit();
    await pair(kit);
    const group = { kind: "telegram" as const, botId: BOT, chatId: "-100200", chatType: "group" as const };
    await kit.adapter.deliver(kit.adapter.message("명단 정리해 줘", { userId: "555", chat: group }));
    await settle(kit);
    expect(kit.engine.sent).toEqual([]);
    expect(kit.adapter.texts("-100200")).toEqual([]);
    expect(kit.adapter.left).toEqual([group]);
    expect(kit.core.auditList().some((row) => row.action === "refused" && row.result === "group")).toBe(true);
  });

  it("does not take the owner's name from another chat", async () => {
    const kit = await startKit();
    await pair(kit);
    // Same person id, but not the chat that was paired.
    await kit.adapter.deliver(kit.adapter.message("명단 정리해 줘", { userId: "555", chat: { kind: "telegram", botId: BOT, chatId: "12345", chatType: "dm" } }));
    await settle(kit);
    expect(kit.engine.sent).toEqual([]);
  });
});

describe("stop, pause and lock", () => {
  it("stops the running turn at once, without waiting behind anything, and keeps what was waiting", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.engine.canSteer = false;
    await say(kit, "논문 초록 세 편 요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    await say(kit, "그리고 표도 만들어 줘");
    expect(sessionOf(kit, sessionId).queued).toHaveLength(1);
    await say(kit, "멈춰");
    expect(kit.engine.interrupted).toEqual([sessionId]);
    expect(kit.engine.running(sessionId)).toBe(false);
    const last = kit.adapter.last()!;
    expect(last.out.text).toBe("멈췄습니다.");
    expect(last.out.buttons?.flat().map((button) => button.label)).toEqual(["이어서 하기", "그대로 두기"]);
    // The waiting request did not start a turn by itself after the stop: it waits, to be sent by hand.
    expect(kit.engine.sent).toHaveLength(1);
    expect(sessionOf(kit, sessionId).queued).toMatchObject([{ text: "그리고 표도 만들어 줘", held: true }]);
    expect(kit.core.auditList().some((row) => row.action === "stop")).toBe(true);
  });

  it("stops everything the chat has running, also in a conversation it has moved on from", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "긴 일 하나");
    const first = kit.engine.sent[0]!.sessionId;
    await say(kit, "새 대화");
    await say(kit, "긴 일 둘");
    const second = kit.engine.sent[1]!.sessionId;
    expect(second).not.toBe(first);
    await say(kit, "멈춰");
    expect([...kit.engine.interrupted].sort()).toEqual([first, second].sort());
    expect(kit.engine.running(first) || kit.engine.running(second)).toBe(false);
  });

  it("does not stop what the PC runs in a conversation the chat is not writing to", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "휴대폰 일");
    const phone = kit.engine.sent[0]!.sessionId;
    const work = kit.manager.createWork({ title: "PC 프로젝트" });
    const desk = kit.manager.createSession(work.id, { provider: "claude" });
    await kit.manager.send(desk.id, "pc-1", "PC에서 시킨 일");
    await say(kit, "멈춰");
    expect(kit.engine.interrupted).toEqual([phone]);
    expect(kit.engine.running(desk.id)).toBe(true);
  });

  it("goes on from where it stopped when asked to, as a new request", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    await say(kit, "정지");
    await press(kit, "이어서 하기");
    expect(kit.engine.sent.map((turn) => turn.sessionId)).toEqual([sessionId, sessionId]);
    expect(userItems(kit, sessionId).map((item) => item.text)).toEqual(["요약해 줘", "이어서 해 주세요."]);
  });

  it("says there is nothing to stop when nothing runs", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "stop");
    expect(kit.adapter.texts().at(-1)).toBe("지금 멈출 일이 없습니다.");
    expect(kit.engine.interrupted).toEqual([]);
  });

  it("paused at the PC: answers only that it is paused and runs nothing, until the PC resumes", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    kit.core.pause(binding.id, true);
    await say(kit, "명단 정리해 줘");
    await say(kit, "새 대화");
    expect(kit.engine.sent).toEqual([]);
    expect(kit.adapter.texts().slice(-2)).toEqual(["지금은 PC에서 채널을 멈춰 두었습니다.", "지금은 PC에서 채널을 멈춰 두었습니다."]);
    expect(kit.core.auditList().filter((row) => row.action === "refused" && row.result === "paused")).toHaveLength(2);
    kit.core.pause(binding.id, false);
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent).toHaveLength(1);
  });

  it("locked from the chat: runs nothing more, cannot be undone from the chat, and the PC alone unlocks it", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "잠금");
    expect(kit.core.bindings()[0]!.lockedAt).toBe(kit.clock.now);
    expect(kit.adapter.texts().at(-1)).toContain("잠갔습니다");
    for (const text of ["명단 정리해 줘", "잠금 해제", "풀어 줘", "/start"]) await say(kit, text);
    expect(kit.engine.sent).toEqual([]);
    expect(kit.core.bindings()[0]!.lockedAt).not.toBeNull();
    expect(kit.adapter.texts().at(-1)).toBe("채널이 잠겨 있습니다. PC에서만 풀 수 있습니다.");
    kit.core.unlock(binding.id);
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent).toHaveLength(1);
    expect(kit.core.auditList().map((row) => row.action)).toEqual(expect.arrayContaining(["lock", "unlock"]));
  });

  it("locked while a turn runs: the lock stops it as 멈춰 does, says so, holds what waited and sends nothing of the work", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.engine.canSteer = false;
    await say(kit, "메일 정리해 줘");
    const first = kit.engine.sent[0]!.sessionId;
    await say(kit, "새 대화");
    await say(kit, "일정 정리해 줘");
    const second = kit.engine.sent[1]!.sessionId;
    await say(kit, "그다음 표도 만들어 줘");
    const before = kit.adapter.sent.length;
    await say(kit, "잠금");
    // Every turn the chat started, also in the conversation it moved on from.
    expect([...kit.engine.interrupted].sort()).toEqual([first, second].sort());
    expect(kit.engine.running(first) || kit.engine.running(second)).toBe(false);
    expect(kit.adapter.texts().slice(before)).toEqual(["채널을 잠갔고 하던 일을 멈췄습니다. 푸는 것은 PC에서만 할 수 있습니다."]);
    expect(kit.engine.sent).toHaveLength(2);
    expect(sessionOf(kit, second).queued).toMatchObject([{ text: "그다음 표도 만들어 줘", held: true }]);
    expect(kit.core.auditList().find((row) => row.action === "lock")).toMatchObject({ result: "stopped" });
    // A stop still works on a locked chat, and says so (the stopped turn's own answer is held).
    await say(kit, "멈춰");
    expect(kit.adapter.texts().at(-1)).toBe("지금 멈출 일이 없습니다.");
  });

  it("lock while a request is being handed to the engine stops it once started", async () => {
    const kit = await startKit();
    await pair(kit);
    let open!: () => void;
    kit.engine.sendGate = new Promise<void>((done) => { open = done; });
    await kit.adapter.deliver(kit.adapter.message("긴 일"));
    await until(() => kit.engine.asked === 1);
    await kit.adapter.deliver(kit.adapter.message("잠금"));
    kit.engine.sendGate = null;
    open();
    await settle(kit);
    const sessionId = kit.engine.sent[0]!.sessionId;
    // Interrupted while starting and again once it has started (as 멈춰 does); what counts is that it stopped.
    expect(new Set(kit.engine.interrupted)).toEqual(new Set([sessionId]));
    expect(kit.engine.running(sessionId)).toBe(false);
    expect(kit.adapter.texts()).toContain("채널을 잠갔고 하던 일을 멈췄습니다. 푸는 것은 PC에서만 할 수 있습니다.");
  });

  it("a lock set at the PC stops the chat's work the same way, and tells the chat", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "긴 일");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.core.lock(binding.id);
    await settle(kit);
    expect(kit.core.bindings()[0]!.lockedAt).toBe(kit.clock.now);
    expect(kit.engine.interrupted).toEqual([sessionId]);
    expect(kit.adapter.texts().at(-1)).toBe("PC에서 채널을 잠갔고 하던 일을 멈췄습니다. 푸는 것은 PC에서만 할 수 있습니다.");
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent).toHaveLength(1);
  });

  it("locked with nothing running: says only that it is locked", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "잠금");
    expect(kit.adapter.texts().at(-1)).toBe("채널을 잠갔습니다. 푸는 것은 PC에서만 할 수 있습니다.");
    expect(kit.engine.interrupted).toEqual([]);
  });

  it("holds back what the chat had waiting when it is paused, locked or disconnected, so nothing of it starts later", async () => {
    for (const close of ["pause", "lock", "revoke"] as const) {
      const kit = await startKit();
      const binding = await pair(kit);
      kit.engine.canSteer = false;
      await say(kit, "첫 일");
      const sessionId = kit.engine.sent[0]!.sessionId;
      await say(kit, "둘째 일");
      if (close === "pause") kit.core.pause(binding.id, true);
      else if (close === "lock") await say(kit, "잠금");
      else kit.core.revoke(binding.id);
      // A lock has stopped the turn already; otherwise it ends by itself.
      if (kit.engine.running(sessionId)) kit.engine.finish(sessionId);
      await settle(kit);
      expect(kit.engine.sent.map((turn) => turn.requestId), close).toHaveLength(1);
      // Still there for the person at the PC, to send or delete.
      expect(sessionOf(kit, sessionId).queued, close).toMatchObject([{ text: "둘째 일", held: true }]);
    }
  });

  it("checks the gate again right before the engine gets a request: one that was on its way when the chat was locked is not handed over", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    let open!: () => void;
    kit.engine.sendGate = new Promise<void>((done) => { open = done; });
    // The first is being taken by the engine; the second waits its turn inside the channel.
    await kit.adapter.deliver(kit.adapter.message("첫 일"));
    await kit.adapter.deliver(kit.adapter.message("둘째 일"));
    await until(() => kit.engine.asked === 1);
    kit.core.pause(binding.id, true);
    kit.engine.sendGate = null;
    open();
    await settle(kit);
    expect(kit.engine.sent.map((turn) => turn.text.split("\n").at(-1))).toEqual(["첫 일"]);
    expect(kit.adapter.texts()).toContain("지금은 PC에서 채널을 멈춰 두었습니다.");
    const sessionId = kit.engine.sent[0]!.sessionId;
    expect(userItems(kit, sessionId).map((item) => item.text)).toEqual(["첫 일"]);
  });

  it("keeps pause and lock across a restart", async () => {
    let kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "잠금");
    kit = await restartKit(kit);
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent).toEqual([]);
    kit.core.unlock(binding.id);
    kit.core.pause(binding.id, true);
    kit = await restartKit(kit);
    await say(kit, "명단 정리해 줘");
    expect(kit.engine.sent).toEqual([]);
    expect(kit.adapter.texts().at(-1)).toBe("지금은 PC에서 채널을 멈춰 두었습니다.");
  });
});

describe("what is sent to a chat that was closed", () => {
  it("sends nothing to a chat disconnected while its answer was on its way (the status line still being sent)", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    let land!: () => void;
    kit.adapter.sendGate = new Promise<void>((done) => { land = done; });
    await kit.adapter.deliver(kit.adapter.message("보고서 써 줘"));
    await until(() => kit.engine.sent.length === 1);
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "다 했습니다. 비밀 결과물");
    kit.engine.finish(sessionId);
    await tick(20);
    kit.core.revoke(binding.id);
    kit.adapter.sendGate = null;
    land();
    await settle(kit);
    expect(kit.adapter.texts()).not.toContain("다 했습니다. 비밀 결과물");
    expect(kit.adapter.edits).toEqual([]);
    expect(kit.store.channels.owed()).toEqual([]);
    expect(kit.core.auditList().find((row) => row.action === "answer.discarded")).toMatchObject({ bindingId: binding.id, sessionId });
  });

  it("does not send an answer that was waiting in the messenger's send line when the chat was disconnected", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "보고서 써 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "다 했습니다. 비밀 결과물");
    // The answer has passed the core's look and waits inside the messenger's send line.
    let land!: () => void;
    kit.adapter.sendGate = new Promise<void>((done) => { land = done; });
    kit.engine.finish(sessionId);
    await until(() => kit.store.channels.owed().length === 0 && kit.adapter.waiting > 0);
    kit.core.revoke(binding.id);
    kit.adapter.sendGate = null;
    land();
    await settle(kit);
    expect(kit.adapter.texts()).not.toContain("다 했습니다. 비밀 결과물");
    expect(kit.core.auditList().find((row) => row.action === "answer.discarded")).toMatchObject({ bindingId: binding.id, sessionId });
  });

  it("reads the chat again before every retry: an answer that failed once is not sent after the chat was locked", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "요약해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "요약했습니다.");
    kit.adapter.failures.push("no");
    // The first try fails; the chat is locked before the retry.
    kit.adapter.beforeSend = () => { kit.adapter.beforeSend = null; kit.store.channels.updateBinding(binding.id, { lockedAt: kit.clock.now }); };
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.adapter.texts()).not.toContain("요약했습니다.");
    // Held, not dropped: unlocked at the PC, it comes once.
    kit.core.unlock(binding.id);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text === "요약했습니다.")).toHaveLength(1);
  });

  it("holds the answer of a turn that ends while the chat is paused, and sends it once on resume, after one line saying so", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "명단 정리해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.core.pause(binding.id, true);
    const before = kit.adapter.sent.length;
    kit.engine.doing(sessionId, "파일 읽는 중");
    kit.clock.now += 20_000;
    await kit.core.pulse();
    kit.engine.say(sessionId, "결과입니다");
    kit.engine.finish(sessionId);
    await settle(kit);
    kit.clock.now += 10 * 60_000;
    for (let round = 0; round < 25; round += 1) { kit.clock.now += 30_000; await kit.core.pulse(); }
    await settle(kit);
    // Nothing at all while paused: no answer, no status edit, no typing mark.
    expect(kit.adapter.sent.length).toBe(before);
    expect(kit.adapter.edits).toEqual([]);
    expect(kit.store.channels.owed().filter((row) => row.key.startsWith("final:"))).toHaveLength(1);
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.texts().slice(before)).toEqual(["채널을 멈춰 둔 동안 끝난 답 1개를 이제 보냅니다.", "결과입니다"]);
    kit.core.pause(binding.id, true);
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.texts().slice(before)).toHaveLength(2);
  });

  it("delivers the answers held while locked, oldest first, when the PC unlocks", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "첫 일");
    const first = kit.engine.sent[0]!.sessionId;
    await say(kit, "새 대화");
    await say(kit, "둘째 일");
    const second = kit.engine.sent[1]!.sessionId;
    kit.core.pause(binding.id, true);
    kit.engine.say(first, "첫 답");
    kit.engine.finish(first);
    kit.clock.now += 1_000;
    kit.engine.say(second, "둘째 답");
    kit.engine.finish(second);
    await settle(kit);
    kit.store.channels.updateBinding(binding.id, { lockedAt: kit.clock.now });
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.texts()).not.toContain("첫 답");
    const before = kit.adapter.sent.length;
    kit.core.unlock(binding.id);
    await settle(kit);
    expect(kit.adapter.texts().slice(before)).toEqual(["채널을 멈춰 둔 동안 끝난 답 2개를 이제 보냅니다.", "첫 답", "둘째 답"]);
  });

  it("discards and records the held answers of a chat that is disconnected", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "명단 정리해 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.core.pause(binding.id, true);
    kit.engine.say(sessionId, "결과입니다");
    kit.engine.finish(sessionId);
    await settle(kit);
    const before = kit.adapter.sent.length;
    kit.core.revoke(binding.id);
    await settle(kit);
    expect(kit.store.channels.owed()).toEqual([]);
    expect(kit.core.auditList().find((row) => row.action === "answer.discarded")).toMatchObject({ bindingId: binding.id, sessionId });
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.sent.length).toBe(before);
  });
});

describe("approval buttons of a conversation in a stricter mode", () => {
  /** The phone's conversation moved to one made at the PC in 묻기 mode, with a turn asking before a command. */
  async function asking() {
    const kit = await startKit();
    const binding = await pair(kit);
    const work = kit.manager.createWork({ title: "연구계획서" });
    const strict = kit.manager.createSession(work.id, { provider: "claude", access: "ask", purpose: "예산표 정리" });
    kit.core.setPointer(binding.id, strict.id);
    await say(kit, "빌드 폴더 지워 줘");
    const itemId = kit.engine.ask(strict.id, "명령 실행 허용?", "rm -rf ./build");
    await settle(kit);
    return { kit, binding, strict, itemId };
  }
  const approvalOf = (kit: Awaited<ReturnType<typeof asking>>["kit"], sessionId: string, itemId: string) => kit.manager.items(sessionId).items.find((item) => item.id === itemId);

  it("says once that such a conversation may ask, and can switch it to automatic", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const work = kit.manager.createWork({ title: "연구계획서" });
    const strict = kit.manager.createSession(work.id, { provider: "claude", access: "ask", purpose: "예산표 정리" });
    kit.core.setPointer(binding.id, strict.id);
    await say(kit, "빌드 폴더 지워 줘");
    const notice = kit.adapter.sent.find((entry) => entry.out.text.includes("모드라 중간에"))!;
    expect(notice.out.text).toBe("이 대화는 '묻기 · 매번 확인' 모드라 중간에 확인 요청이 올 수 있습니다.");
    expect(notice.out.buttons?.flat().map((button) => button.label)).toEqual(["전체 접근으로 바꾸기"]);
    // The request went on as it was, in the conversation's own mode.
    expect(kit.engine.sent[0]).toMatchObject({ sessionId: strict.id, access: "ask" });
    kit.engine.finish(strict.id);
    await say(kit, "하나 더");
    expect(kit.adapter.texts().filter((text) => text.includes("'묻기 · 매번 확인' 모드"))).toHaveLength(1);
    await press(kit, "전체 접근으로 바꾸기");
    expect(sessionOf(kit, strict.id).access).toBe("full");
  });

  it("sends the question with 허용 and 거절, answers it once from the chat and shows what was chosen", async () => {
    const { kit, strict, itemId } = await asking();
    const question = kit.adapter.last()!;
    expect(question.out.text).toBe("「예산표 정리」 · 명령 실행 허용?\nrm -rf ./build");
    expect(question.out.buttons?.flat().map((button) => button.label)).toEqual(["허용", "거절"]);
    // The buttons carry nothing but a random value.
    for (const button of question.out.buttons!.flat()) expect(button.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const deny = kit.adapter.tokenOf("거절");
    const event = await press(kit, "허용");
    expect(kit.engine.answered).toEqual([{ sessionId: strict.id, itemId, decision: "accept" }]);
    expect(kit.adapter.acks.at(-1)).toMatchObject({ handle: event.ackHandle, note: "허용함" });
    expect(kit.adapter.shown(question.messageId)?.text).toMatch(/^「예산표 정리」 · 명령 실행 허용\?\nrm -rf \.\/build\n허용함 · \d{1,2}:\d{2} · 휴대폰$/);
    expect(kit.adapter.shown(question.messageId)?.buttons ?? []).toEqual([]);
    // Pressed again, and the other button after it: nothing more is answered.
    await kit.adapter.deliver(kit.adapter.press(question.out.buttons![0]![0]!.token));
    await kit.adapter.deliver(kit.adapter.press(deny));
    await settle(kit);
    expect(kit.engine.answered).toHaveLength(1);
    expect(kit.adapter.acks.slice(-2).map((ack) => ack.note)).toEqual(["이미 처리됨", "이미 처리됨"]);
    expect(kit.core.auditList().filter((row) => row.action === "approval")).toMatchObject([{ sessionId: strict.id, target: itemId, result: "accept" }]);
  });

  it("refuses a press by anyone but the owner in the owner's own chat, and leaves the question open", async () => {
    const { kit, strict, itemId } = await asking();
    const token = kit.adapter.tokenOf("허용");
    // Another person, another chat with the owner's id, and a group the owner is in.
    await kit.adapter.deliver(kit.adapter.press(token, { userId: "999" }));
    await kit.adapter.deliver(kit.adapter.press(token, { userId: "555", chat: { kind: "telegram", botId: BOT, chatId: "12345", chatType: "dm" } }));
    await kit.adapter.deliver(kit.adapter.press(token, { userId: "555", chat: { kind: "telegram", botId: BOT, chatId: "-100200", chatType: "group" } }));
    await settle(kit);
    expect(kit.engine.answered).toEqual([]);
    expect(approvalOf(kit, strict.id, itemId)).toMatchObject({ decision: null });
    // The owner can still answer it.
    await press(kit, "허용");
    expect(kit.engine.answered).toHaveLength(1);
  });

  it("refuses a button older than a day", async () => {
    const { kit, strict, itemId } = await asking();
    kit.clock.now += 24 * 60 * 60_000 + 1;
    const event = await press(kit, "허용");
    expect(kit.engine.answered).toEqual([]);
    expect(approvalOf(kit, strict.id, itemId)).toMatchObject({ decision: null });
    expect(kit.adapter.acks.at(-1)).toMatchObject({ handle: event.ackHandle, note: "만료된 버튼입니다" });
  });

  it("says it is already handled when the PC answered first, and changes nothing", async () => {
    const { kit, strict, itemId } = await asking();
    const question = kit.adapter.last()!;
    await kit.manager.answerApproval(strict.id, itemId, "decline");
    await settle(kit);
    expect(kit.adapter.shown(question.messageId)?.text).toContain("PC에서 거절함");
    await kit.adapter.deliver(kit.adapter.press(question.out.buttons![0]![0]!.token));
    await settle(kit);
    expect(kit.engine.answered).toEqual([{ sessionId: strict.id, itemId, decision: "decline" }]);
    expect(kit.adapter.acks.at(-1)?.note).toBe("이미 처리됨");
  });

  it("answers nothing in a conversation that was archived meanwhile", async () => {
    const { kit, strict, itemId } = await asking();
    // Archived by hand at the PC (the record is changed directly: a busy conversation is not archived through the UI).
    kit.manager.sink.updateSession(strict.id, { archivedAt: Date.now() });
    await press(kit, "허용");
    expect(kit.engine.answered).toEqual([]);
    expect(approvalOf(kit, strict.id, itemId)).toMatchObject({ decision: null });
    expect(kit.adapter.acks.at(-1)?.note).toContain("보관");
  });

  it("does nothing for a value nobody made (a forged button)", async () => {
    const { kit } = await asking();
    await kit.adapter.deliver(kit.adapter.press("forged-value-0123456789ab"));
    await settle(kit);
    expect(kit.engine.answered).toEqual([]);
    expect(kit.adapter.acks.at(-1)?.note).toBe("쓸 수 없는 버튼입니다");
  });

  it("does not send the PC's own questions to the chat", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    const work = kit.manager.createWork({ title: "연구계획서" });
    const strict = kit.manager.createSession(work.id, { provider: "claude", access: "ask", purpose: "예산표 정리" });
    kit.core.setPointer(binding.id, strict.id);
    const before = kit.adapter.sent.length;
    await kit.manager.send(strict.id, "pc-1", "PC에서 시킨 일");
    kit.engine.ask(strict.id, "명령 실행 허용?", "ls");
    await settle(kit);
    expect(kit.adapter.sent.length).toBe(before);
  });

  it("offers one 진행 button for a plan that waits for the go-ahead", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "계획부터 세워 줘");
    const sessionId = kit.engine.sent[0]!.sessionId;
    const itemId = kit.engine.ask(sessionId, "이 계획대로 진행할까요?", "1. 읽기\n2. 고치기", { plan: true });
    await settle(kit);
    expect(kit.adapter.last()!.out.buttons?.flat().map((button) => button.label)).toEqual(["진행"]);
    await press(kit, "진행");
    expect(kit.engine.answered).toEqual([{ sessionId, itemId, decision: "accept" }]);
  });
});

describe("the audit trail", () => {
  it("records who connected, what was asked and what was stopped, without what was said", async () => {
    const kit = await startKit();
    const { code } = kit.core.beginPairing("telegram", BOT);
    await kit.adapter.deliver(kit.adapter.message(`/start ${code}`));
    const binding = await kit.core.approvePairing("telegram", BOT, kit.core.pairing("telegram", BOT).request!.id);
    await say(kit, "비밀스러운 내용의 요청입니다");
    const sessionId = kit.engine.sent[0]!.sessionId;
    kit.engine.say(sessionId, "AI의 답 본문입니다");
    await say(kit, "멈춰");
    kit.core.pause(binding.id, true);
    kit.core.pause(binding.id, false);
    kit.core.revoke(binding.id);
    const rows = kit.core.auditList();
    expect(rows.map((row) => row.action).reverse()).toEqual(["pairing.started", "pairing.requested", "paired", "request", "stop", "pause", "resume", "revoked"]);
    expect(rows.find((row) => row.action === "request")).toMatchObject({ bindingId: binding.id, sessionId, requestId: expect.stringMatching(/^ch:telegram:7000000001:/), result: "turn" });
    const written = JSON.stringify(rows) + kit.lines.join("\n");
    for (const secret of ["비밀스러운 내용의 요청입니다", "AI의 답 본문입니다", code]) expect(written).not.toContain(secret);
    // By binding and by time, for the 기록 tab.
    expect(kit.core.auditList({ bindingId: binding.id }).length).toBeGreaterThanOrEqual(6);
    expect(kit.core.auditList({ since: kit.clock.now + 1 })).toEqual([]);
  });
});
