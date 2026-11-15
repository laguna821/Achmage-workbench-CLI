import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { CredentialService } from "../credentials/service.ts";
import { formsOf } from "../credentials/forms.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// sec-vault (2026-11-15), the reviewer's open question: the hand-over message is on the phone, but the
// stand-in Telegram holds back its answer to the PC, so the PC has not opened the input yet. The
// person pastes the value at once. Does it go to the AI as an ordinary message? Made-up values only.
const PASSWORD = "zz-secret-race-pass-0915";
const NEED = ["need", "--name", "학술정보원", "--kind", "login", "--site", "lib.example.ac.kr", "--fields", "비밀번호"];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

async function raceKit() {
  const dir = mkdtempSync(join(tmpdir(), "wb-handover-race-"));
  const dataDir = join(dir, "data"); mkdirSync(dataDir, { recursive: true });
  const fake = new FakeTelegram(); await fake.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const credentials = new CredentialService({ dataDir, vault, manager });
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, log: () => {} });
  await channels.start();
  await channels.registerTelegram(FAKE_TOKEN);
  cleanups.push(async () => { fake.holdReply = null; await channels.close(); await manager.shutdown(); store.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }); });
  const { code } = channels.core.beginPairing("telegram", fake.botId);
  fake.message(`/start ${code}`);
  await until(() => Boolean(channels.core.pairing("telegram", fake.botId).request));
  await channels.core.approvePairing("telegram", fake.botId, channels.core.pairing("telegram", fake.botId).request!.id);
  await until(() => fake.texts().some((text) => text.startsWith("연결되었습니다")));
  fake.message("도서관 대출 목록 정리해 줘");
  await until(() => engine.sent.length > 0);
  const sessionId = channels.core.bindings()[0]!.pointerSessionId!;
  return { fake, engine, credentials, sessionId, store };
}

describe("sec-vault: a value pasted before the PC has Telegram's answer to the hand-over", () => {
  it("never reaches the AI as an ordinary message", async () => {
    const kit = await raceKit();
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    kit.fake.holdReply = (text) => (text.includes("'학술정보원'") ? held : undefined);
    const before = kit.engine.sent.length;
    const asked = kit.credentials.run(kit.sessionId, NEED);
    kit.engine.say(kit.sessionId, "학술정보원 로그인이 필요해 요청했습니다.");
    kit.engine.finish(kit.sessionId);
    // The hand-over is on the phone; the PC still waits for Telegram's answer.
    await until(() => kit.fake.texts().some((text) => text.includes("'학술정보원'")), 8000);
    kit.fake.message(PASSWORD);
    // Long enough for the poll to bring the line in and the core to act on it (pollSeconds 1).
    await new Promise((done) => setTimeout(done, 2500));
    const leakedWhileHeld = kit.engine.sent.slice(before).some((entry) => entry.text.includes(PASSWORD));
    release();
    await asked;
    await new Promise((done) => setTimeout(done, 2500));
    const reached = kit.engine.sent.slice(before).filter((entry) => formsOf(PASSWORD).some((form) => entry.text.includes(form)));
    expect({ leakedWhileHeld, reachedTheAi: reached.length }).toEqual({ leakedWhileHeld: false, reachedTheAi: 0 });
    // It was taken as the value it was asked for.
    await until(() => Boolean(kit.credentials.store.find("학술정보원")), 8000);
    // Nor is it in what the gateway keeps of the conversation.
    const items = JSON.stringify(kit.store.items(kit.sessionId));
    expect(formsOf(PASSWORD).some((form) => items.includes(form))).toBe(false);
  }, 30_000);
});
