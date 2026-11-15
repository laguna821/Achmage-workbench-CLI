// ONE Telegram bot AND ONE Slack app at once, driven end to end against the bundled gateway: a
// stand-in Bot API and a stand-in Slack (Web API + Socket Mode) on 127.0.0.1 play the two
// messengers, the repository's stand-in engines play Claude and Codex (no model), a stand-in keyring
// seals the tokens. Both registered and paired; what one messenger's chat does never reaches the
// other's (lines, answers, buttons, PC-side notices, a lock); a token replaced and a messenger removed
// leave the other running; a restart keeps both. Then the owner's state as the installed build wrote
// it (scripts/fixtures/base-telegram-state: one Telegram bot, paired) starts on this build with that
// bot connected and nothing asked again, and Slack is added beside it. Nothing here contacts Telegram
// or Slack.
//
// Usage (from the repository, through ux/run-isolated.sh, after `npm run build -w @workbench/host`):
//   node scripts/channel-smoke-both.ts
// Prints one PASS/FAIL line per check and exits 1 when any failed. The gateway is stopped by its PID.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import type { ChannelAuditRow, ChannelPairingLink, ChannelsState, Session } from "@workbench/contracts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "../apps/host/src/channels/fake-slack.ts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const fresh = mkdtempSync(join(tmpdir(), "workbench-channel-smoke-both-"));
const owner = mkdtempSync(join(tmpdir(), "workbench-channel-smoke-owner-"));

type Gateway = { child: ChildProcess; ready: { url: string; token: string }; stderr: () => string };
async function launch(dataDir: string, tg: FakeTelegram, slack: FakeSlack, extra: Record<string, string> = {}): Promise<Gateway> {
  const child = spawn(process.execPath, [process.env.CHANNEL_SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_HOST_LABEL: "노트북",
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
      WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      WORKBENCH_TELEGRAM_API: tg.url,
      WORKBENCH_SLACK_API: slack.url,
      WORKBENCH_SECRET_BIN: process.env.SMOKE_SECRET_BIN ?? resolve("scripts/fixtures/fake-secret.mjs"),
      FAKE_SECRET_OFF: join(dataDir, "keyring-off"),
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
  });
  console.log(`gateway pid ${child.pid} on ${new URL(ready.url).host}`);
  return { child, ready, stderr: () => stderr };
}
async function stop(gateway: Gateway) {
  if (gateway.child.exitCode !== null) return gateway.child.exitCode;
  gateway.child.kill("SIGTERM");
  const code = await new Promise<number | null>((done) => gateway.child.once("exit", (exit) => done(exit)));
  console.log(`gateway ${gateway.child.pid} exited ${code}`);
  return code;
}

const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const start = Date.now();
  while (!(await what())) {
    if (Date.now() - start > ms) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
  return true;
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

let gateway: Gateway | null = null;
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${gateway!.ready.url}${path}`, { method, headers: { authorization: `Bearer ${gateway!.ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
};
const state = () => api<ChannelsState>("GET", "/api/channels");
const botOf = async (kind: "telegram" | "slack") => (await state()).bots.find((bot) => bot.kind === kind);
const connected = async (kind: "telegram" | "slack") => (await botOf(kind))?.status.state === "connected";

/** Everything each messenger was sent, as text (any chat, any method that carries one). */
const allTelegram = (tg: FakeTelegram) => tg.calls.filter((call) => ["sendMessage", "editMessageText", "sendDocument", "sendPhoto"].includes(call.method)).map((call) => String(call.params.text ?? call.params.caption ?? ""));
const allSlack = (slack: FakeSlack) => slack.calls.filter((call) => ["chat.postMessage", "chat.update"].includes(call.method)).map((call) => String(call.params.text ?? ""));
/** A real answer (not the status line or a queue line) after `count` of this list. */
const answer = (list: () => string[], count: number) => wait(() => list().slice(count).some((text) => text.length > 40 && !text.startsWith("작업 중")), 60_000);

const tg = new FakeTelegram(), slack = new FakeSlack();
await tg.start();
await slack.start();
const tgTexts = () => tg.texts();
const slackTexts = () => slack.texts().map((text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
const slackPress = (label: string) => { const button = slack.button(label); slack.press(button.value, { messageTs: button.ts }); };
const tgPress = (label: string) => { const button = tg.button(label); tg.press(button.data, { messageId: button.messageId }); };

try {
  gateway = await launch(fresh, tg, slack);
  // Both registered, Telegram first, as the owner would: one does not refuse the other.
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  await api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, appName: "Workbench 노트북" });
  check("both registered and connected at once", await wait(async () => (await connected("telegram")) && (await connected("slack"))) && slack.open() === 1);
  check("the state lists two rows, one per messenger", (await state()).bots.map((bot) => bot.kind).sort().join() === "slack,telegram");
  // A second Telegram bot is still refused, in words that name Telegram.
  const other = "7000000002:AAF" + "m".repeat(8) + "-Fake_token-for-loopback-02";
  tg.others.add(other);
  const refused = await fetch(`${gateway.ready.url}/api/channels/telegram/bots`, { method: "POST", headers: { authorization: `Bearer ${gateway.ready.token}`, "content-type": "application/json" }, body: JSON.stringify({ token: other }) });
  check("a second Telegram bot is refused, saying so", refused.status === 409 && (await refused.text()).includes("텔레그램 봇은 하나만 등록합니다"));

  // Pairing each, as the PC screen does.
  const link = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${tg.botId}/pairing`, {});
  tg.message(`/start ${new URL(link.link).searchParams.get("start")}`);
  await wait(async () => Boolean((await botOf("telegram"))?.pairing.request));
  await api("POST", `/api/channels/telegram/bots/${tg.botId}/pairing/${(await botOf("telegram"))!.pairing.request!.id}`, { approve: true });
  check("Telegram paired", await wait(() => tgTexts().some((text) => text.startsWith("연결되었습니다"))));
  await api<ChannelPairingLink>("POST", `/api/channels/slack/bots/${slack.botId}/pairing`, {});
  slack.message("연결");
  await wait(async () => Boolean((await botOf("slack"))?.pairing.request));
  await api("POST", `/api/channels/slack/bots/${slack.botId}/pairing/${(await botOf("slack"))!.pairing.request!.id}`, { approve: true });
  check("Slack paired, Telegram's pairing untouched", await wait(() => slackTexts().some((text) => text.startsWith("연결되었습니다"))) && (await botOf("telegram"))!.bindings.length === 1);
  check("no pairing line crossed", !allSlack(slack).some((text) => text.includes("t.me")) && tgTexts().filter((text) => text.startsWith("연결되었습니다")).length === 1);

  // A line from each is answered in its own messenger, in its own conversation.
  let tgCount = tgTexts().length, slackCount = allSlack(slack).length;
  tg.message("텔레그램에서: 학생 명단 정리해 줘");
  check("Telegram's line answered in Telegram", await answer(tgTexts, tgCount));
  await pause(1_000);
  check("…and nothing of it in Slack", allSlack(slack).length === slackCount, String(allSlack(slack).length - slackCount));
  tgCount = allTelegram(tg).length;
  const slackSeen = slackTexts().length;
  slack.message("슬랙에서: 회의록 정리해 줘");
  check("Slack's line answered in Slack", await answer(slackTexts, slackSeen));
  await pause(1_000);
  check("…and nothing of it in Telegram", allTelegram(tg).length === tgCount, String(allTelegram(tg).length - tgCount));
  const bindings = (await state()).bots.flatMap((bot) => bot.bindings);
  check("two conversations, one per chat", bindings.length === 2 && bindings[0]!.pointerSessionId !== bindings[1]!.pointerSessionId);

  // A Telegram button pressed in Slack does nothing.
  tg.message("/menu");
  await wait(() => { try { tg.button("알림"); return true; } catch { return false; } });
  slack.press(tg.button("알림").data);
  check("a Telegram button pressed in Slack is refused there", await wait(async () => (await api<{ rows: ChannelAuditRow[] }>("GET", "/api/channels/audit")).rows.some((row) => row.kind === "slack" && row.action === "refused" && row.result === "button")));

  // PC-side notices: both chats turn the project on through their menus; the PC's own work there is told once in each.
  const work = await api<{ id: string }>("POST", "/api/works", { title: "연구계획서" });
  tgPress("알림");
  await wait(() => { try { tg.button("꺼짐 · 연구계획서"); return true; } catch { return false; } });
  tgPress("꺼짐 · 연구계획서");
  slack.message("메뉴");
  await wait(() => { try { slack.button("알림"); return true; } catch { return false; } });
  slackPress("알림");
  await wait(() => { try { slack.button("꺼짐 · 연구계획서"); return true; } catch { return false; } });
  slackPress("꺼짐 · 연구계획서");
  await wait(() => { try { tg.button("켜짐 · 연구계획서"); slack.button("켜짐 · 연구계획서"); return true; } catch { return false; } }, 10_000);
  const pc = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "PC 일" });
  await api("POST", `/api/sessions/${pc.id}/messages`, { requestId: crypto.randomUUID(), text: "PC에서 시킨 일" });
  const notice = (text: string) => text.startsWith("PC에서 시킨 일이 끝났습니다");
  check("the PC's work is told in Telegram AND in Slack", await wait(() => tgTexts().some(notice) && slackTexts().some(notice), 60_000));
  await pause(1_500);
  check("…once in each", tgTexts().filter(notice).length === 1 && slackTexts().filter(notice).length === 1, `${tgTexts().filter(notice).length}/${slackTexts().filter(notice).length}`);

  // 잠금 in Telegram locks Telegram's chat only; Slack still answers.
  tg.message("잠금");
  check("잠금 in Telegram locks Telegram's chat", await wait(async () => Boolean((await botOf("telegram"))!.bindings[0]!.lockedAt)));
  check("…and not Slack's", !(await botOf("slack"))!.bindings[0]!.lockedAt);
  let seen = slackTexts().length;
  slack.message("잠근 뒤 슬랙에서 요청");
  check("Slack answers while Telegram is locked", await answer(slackTexts, seen));
  await api("PATCH", `/api/channels/bindings/${(await botOf("telegram"))!.bindings[0]!.id}`, { locked: false });

  // A token replaced on Telegram: Slack's socket and chat stay as they were.
  const opened = slack.of("apps.connections.open").length;
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  await wait(() => connected("telegram"));
  check("Telegram's token replaced: Slack not reconnected", slack.of("apps.connections.open").length === opened && slack.open() === 1);
  seen = slackTexts().length;
  slack.message("토큰 바꾼 뒤 슬랙");
  check("…and Slack answers", await answer(slackTexts, seen));
  const getMe = tg.of("getMe").length;
  await api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN });
  await wait(() => connected("slack"));
  check("Slack's tokens replaced: Telegram not re-registered", tg.of("getMe").length === getMe && (await botOf("telegram"))!.bindings.length === 1);
  tgCount = tgTexts().length;
  tg.message("토큰 바꾼 뒤 텔레그램");
  check("…and Telegram answers", await answer(tgTexts, tgCount));

  // Telegram removed: Slack keeps answering.
  const socketsBefore = slack.of("apps.connections.open").length;
  await api("DELETE", `/api/channels/telegram/bots/${tg.botId}`);
  check("Telegram removed: only Slack left, connected, its socket not reopened", await wait(async () => (await state()).bots.map((bot) => bot.kind).join() === "slack" && (await connected("slack"))) && slack.of("apps.connections.open").length === socketsBefore && slack.open() === 1, `${slack.of("apps.connections.open").length - socketsBefore}`);
  seen = slackTexts().length;
  slack.message("텔레그램 지운 뒤 슬랙");
  check("…and Slack answers", await answer(slackTexts, seen));

  // A restart: Slack connected again, its chat as it was.
  const slackBinding = (await botOf("slack"))!.bindings[0]!.id;
  await stop(gateway);
  gateway = await launch(fresh, tg, slack);
  check("after a restart Slack is connected with its chat", await wait(async () => (await connected("slack")) && (await botOf("slack"))!.bindings[0]?.id === slackBinding));
  await stop(gateway);
  gateway = null;

  // The owner's state, as the installed build (one messenger at a time) wrote it.
  const tg2 = new FakeTelegram(), slack2 = new FakeSlack();
  // The real Bot API numbers updates on from where the old run confirmed (the stand-in starts at 1000).
  (tg2 as unknown as { nextUpdate: number }).nextUpdate = 5000;
  await tg2.start();
  await slack2.start();
  try {
    const fixture = resolve("scripts/fixtures/base-telegram-state");
    mkdirSync(join(owner, "channels"), { recursive: true });
    writeFileSync(join(owner, "state.sqlite"), gunzipSync(readFileSync(join(fixture, "state.sqlite.gz"))));
    copyFileSync(join(fixture, "bots.json"), join(owner, "channels", "bots.json"));
    const db = new DatabaseSync(join(owner, "state.sqlite"), { readOnly: true });
    const before = { binding: (db.prepare("SELECT id FROM channel_bindings").get() as { id: string }).id, outbox: JSON.stringify(db.prepare("SELECT * FROM channel_outbox ORDER BY key").all()) };
    db.close();
    gateway = await launch(owner, tg2, slack2, { WORKBENCH_HOST_ID: "h" });
    check("the owner's bot is connected on the new build, its token not asked again", await wait(async () => (await connected("telegram")) && (await botOf("telegram"))!.token === "sealed"));
    check("…its chat as it was, no pairing", (await botOf("telegram"))!.bindings[0]?.id === before.binding && !(await botOf("telegram"))!.pairing.request);
    await pause(2_000);
    check("…nothing re-sent to the phone at start", tg2.of("sendMessage").length === 0, String(tg2.of("sendMessage").length));
    const after = new DatabaseSync(join(owner, "state.sqlite"), { readOnly: true });
    check("…its outbox as it was", JSON.stringify(after.prepare("SELECT * FROM channel_outbox ORDER BY key").all()) === before.outbox);
    after.close();
    const pointer = (await botOf("telegram"))!.bindings[0]!.pointerSessionId;
    tg2.message("업데이트 뒤 첫 요청");
    check("…and the phone's line is answered in the conversation it was in", await answer(() => tg2.texts(), 0) && (await botOf("telegram"))!.bindings[0]!.pointerSessionId === pointer);
    await api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN });
    check("Slack added beside it: both connected, the Telegram chat untouched", await wait(async () => (await connected("slack")) && (await connected("telegram"))) && (await botOf("telegram"))!.bindings[0]?.id === before.binding);
    const count = tg2.texts().length;
    tg2.message("슬랙 더한 뒤 텔레그램");
    check("…and Telegram still answers", await answer(() => tg2.texts(), count));
  } finally {
    if (gateway) await stop(gateway);
    gateway = null;
    await tg2.stop();
    await slack2.stop();
  }
} catch (error) {
  check("the smoke ran to its end", false, error instanceof Error ? error.message : String(error));
  if (gateway) console.log(gateway.stderr().slice(-2000));
} finally {
  if (gateway) await stop(gateway);
  await tg.stop();
  await slack.stop();
  rmSync(fresh, { recursive: true, force: true });
  rmSync(owner, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
