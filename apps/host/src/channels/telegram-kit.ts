import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { FAKE_TOKEN, FakeTelegram } from "./fake-telegram.ts";
import { ChannelService } from "./service.ts";
import { StandInEngine, until } from "./test-kit.ts";

// For tests only: the whole channel as the gateway runs it (service, core, Telegram adapter) with a
// stand-in engine, against the stand-in Bot API on 127.0.0.1. Nothing here reaches Telegram.

export type TelegramKit = Awaited<ReturnType<typeof telegramKit>>;

export async function telegramKit(options: { codex?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-channel-telegram-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const fake = new FakeTelegram();
  await fake.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const codex = options.codex ? new StandInEngine(() => manager.sink, "codex") : null;
  if (codex) manager.registerAdapter(codex);
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const lines: string[] = [];
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 }, log: (line) => lines.push(line) });
  await channels.start();
  await channels.registerTelegram(FAKE_TOKEN);
  const close = async () => {
    await channels.close();
    await manager.shutdown();
    store.close();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  /** Texts the chat has now, in order (as sent; edits not applied). */
  const texts = () => fake.texts();
  /** Wait for a sendMessage whose text matches. */
  const sent = async (match: RegExp) => {
    await until(() => texts().some((text) => match.test(text)));
    return fake.of("sendMessage").findLast((call) => match.test(String(call.params.text)))!;
  };
  const pair = async () => {
    const { code } = channels.core.beginPairing("telegram", fake.botId);
    fake.message(`/start ${code}`);
    await until(() => Boolean(channels.core.pairing("telegram", fake.botId).request));
    await channels.core.approvePairing("telegram", fake.botId, channels.core.pairing("telegram", fake.botId).request!.id);
    await until(() => texts().some((text) => text.startsWith("연결되었습니다")));
  };
  /** A line from the phone; resolves when the engine has it (or `until` holds). */
  const say = async (text: string, done?: () => boolean) => {
    const before = engine.sent.length + (codex?.sent.length ?? 0);
    fake.message(text);
    await until(done ?? (() => engine.sent.length + (codex?.sent.length ?? 0) > before));
  };
  /** Press the button with this label where the chat shows it, on the message it sits on. */
  const press = (label: string) => {
    const { data, messageId } = fake.button(label);
    fake.press(data, { messageId });
    return messageId;
  };
  return { dir, dataDir, fake, store, manager, engine, codex, channels, core: channels.core, lines, close, texts, sent, pair, say, press };
}
