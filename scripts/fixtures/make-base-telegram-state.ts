// Writes the owner's kind of state with a BUILT gateway: one Telegram bot registered (its token sealed
// by the stand-in keyring), one phone paired, a project the chat hears about, one request answered.
// Run once with the build of ux/integration 6d19ad43 (the installed line, one messenger at a time) to
// make scripts/fixtures/base-telegram-state/: the two-messenger build must start on it with that bot
// connected and nothing asked again (apps/host/src/channels/two-messengers.test.ts, channel-smoke-both.ts).
//
// Usage (through ux/run-isolated.sh, after `npm run build -w @workbench/host`):
//   node scripts/fixtures/make-base-telegram-state.ts <empty output folder>
// Nothing here contacts Telegram: a stand-in Bot API on 127.0.0.1 plays the phone.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelsState } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../../apps/host/src/channels/fake-telegram.ts";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("give an empty output folder");
mkdirSync(out, { recursive: true });
if (readdirSync(out).length) throw new Error("the output folder is not empty");
const fake = new FakeTelegram();
await fake.start();
const child = spawn(process.execPath, [process.env.CHANNEL_SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: out,
    WORKBENCH_HOST_LABEL: "노트북",
    // A made-up machine name (the test opens the store as host "h"); never this PC's own.
    WORKBENCH_HOST_ID: "h",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_TELEGRAM_API: fake.url,
    WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code})`)));
  createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
};
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const start = Date.now();
  while (!(await what())) {
    if (Date.now() - start > ms) throw new Error("the awaited state did not come");
    await new Promise((done) => setTimeout(done, 100));
  }
};
try {
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  const link = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${fake.botId}/pairing`, {});
  fake.message(`/start ${new URL(link.link).searchParams.get("start")}`);
  await wait(async () => Boolean((await api<ChannelsState>("GET", "/api/channels")).bots[0]?.pairing.request));
  const request = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.pairing.request!;
  await api("POST", `/api/channels/telegram/bots/${fake.botId}/pairing/${request.id}`, { approve: true });
  await wait(() => fake.texts().some((text) => text.startsWith("연결되었습니다")));
  const count = fake.texts().length;
  fake.message("안녕, 오늘 할 일 정리해 줘");
  await wait(() => fake.texts().slice(count).some((text) => text !== "작업 중 · 0:00" && !text.startsWith("작업 중")), 60_000);
  await wait(async () => !(await api<ChannelsState>("GET", "/api/channels")).bots[0]!.bindings[0]!.undelivered);
  console.log(JSON.stringify({ bots: (await api<ChannelsState>("GET", "/api/channels")).bots.map((bot) => ({ kind: bot.kind, id: bot.id, token: bot.token, bindings: bot.bindings.map((binding) => binding.id) })) }));
} finally {
  child.kill("SIGTERM");
  await new Promise((done) => child.once("exit", done));
  await fake.stop();
}
