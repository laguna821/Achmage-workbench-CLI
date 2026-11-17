// The resource manager end to end (ux/briefs/resource-manager-brief.md): as many AI turns at once as the limit
// allows, the rest wait in a visible line, start by themselves, survive a gateway restart, and the phone says so.
//
// Real parts: the built gateway (apps/host/dist) with its queue, resource manager and channel core, and — with
// `--shots` — the built UI (apps/web/dist) in Chromium. Stand-ins: the engines (fake-claude.mjs; a request with
// "[[hold:<name>]]" lasts until the rig writes <name> into FAKE_ENGINE_HOLD_DIR), the Bot API (fake-telegram.ts on
// 127.0.0.1 as the phone, the remote's rules played by fake-remote.mjs), the keyring (fake-secret.mjs). Nothing
// here contacts Telegram, Slack or any other host; each gateway is stopped by its PID.
//
// Usage (through ux/run-isolated.sh, after `npm run build -w @workbench/host`, and the web build for --shots):
//   node scripts/resource-check.ts <out-dir> [--shots]
// One PASS/FAIL line per check; exits 1 when any failed. `<out-dir>/phone-telegram.txt` is what the phone got.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelsState, ResourceState, SendResult, Session, Snapshot, TranscriptItem } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const out = resolve(process.argv[2] ?? join(tmpdir(), "wb-resource-check")); mkdirSync(out, { recursive: true });
const shots = process.argv.includes("--shots");
const dataDir = mkdtempSync(join(tmpdir(), "wb-resource-check-"));
const holds = join(dataDir, "holds"); mkdirSync(holds, { recursive: true });
const release = (name: string) => writeFileSync(join(holds, name), "");
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await what()) return true; await sleep(100); }
  return false;
};

const tg = new FakeTelegram();
await tg.start();
let child: ChildProcess | null = null;
let ready: { url: string; token: string } | null = null;
const api = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
  const response = await fetch(`${ready!.url}${path}`, { method, headers: { authorization: `Bearer ${ready!.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
};
const snapshot = () => api<Snapshot>("/api/snapshot");
const resources = () => api<ResourceState>("/api/resources");
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>(`/api/sessions/${id}/items`)).items;
const users = async (id: string) => (await items(id)).filter((item) => item.kind === "user").map((item) => item.id.slice(5));
const send = (id: string, requestId: string, text: string) => api<SendResult>(`/api/sessions/${id}/messages`, "POST", { requestId, text });
const tgTexts = () => tg.texts();
const said = (from: number, test: (text: string) => boolean, ms = 60_000) => wait(() => tgTexts().slice(from).some(test), ms);
const waitingIds = async () => (await resources()).waiting.map((entry) => entry.requestId);
const runningIds = async () => (await resources()).running.map((turn) => turn.sessionId);

async function startGateway() {
  child = spawn(process.execPath, [process.env.CHANNEL_SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_VAULT_SUGGEST: "",
      WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      WORKBENCH_TELEGRAM_API: tg.url,
      WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"), FAKE_SECRET_OFF: join(dataDir, "keyring-off"),
      FAKE_ENGINE_STATE: join(dataDir, "fake-engine-state"), FAKE_ENGINE_HOLD_DIR: holds,
      // A roomy stand-in machine: the limit below is the person's 직접 number, not this computer's memory.
      WORKBENCH_MACHINE: JSON.stringify({ totalBytes: 16 * 2 ** 30, availableBytes: 10 * 2 ** 30, cores: 8 }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (data: Buffer) => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("gateway start timeout")), 30_000);
    child!.once("exit", (code) => { clearTimeout(timer); fail(new Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  console.log(`gateway pid ${child.pid} on ${new URL(ready.url).host}`);
}
async function stopGateway() {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  child.kill("SIGTERM");
  await new Promise((done) => child!.once("exit", done));
  console.log(`gateway ${pid} stopped`);
}

let browser: import("playwright-core").Browser | null = null;
async function frame(name: string, theme: "light" | "dark", size: { width: number; height: number }, session: Session, act?: (page: import("playwright-core").Page) => Promise<void>) {
  if (!browser) browser = await (await import("playwright-core")).chromium.launch();
  const tab = { id: "t", workId: session.workId, sessionId: session.id, view: { kind: "work" } };
  const revision = (await api<{ record: { revision?: number } | null }>("/api/layouts/global")).record?.revision ?? 0;
  await api("/api/layouts/global", "PUT", { expectedRevision: revision, layout: { version: 2, focus: "p", panes: [{ ...tab, id: "p", tabs: [tab], activeTabId: "t", recentTabIds: ["t"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true, theme, memoryShown: false } });
  const context = await browser.newContext({ viewport: size, colorScheme: theme });
  const page = await context.newPage();
  await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), session.workId);
  await page.goto(`${ready!.url}/?token=${ready!.token}`);
  await page.locator(".composer, .transcript").first().waitFor({ timeout: 30_000 });
  await sleep(800);
  if (act) await act(page);
  await page.screenshot({ path: join(out, `${name}-${theme}-${size.width}.png`) });
  await context.close();
}

try {
  await startGateway();
  // The phone: one paired Telegram chat (its first conversation is the remote, in the messenger's place).
  await api("/api/channels/telegram/bots", "POST", { token: FAKE_TOKEN });
  const botOf = async () => (await api<ChannelsState>("/api/channels")).bots.find((bot) => bot.kind === "telegram")!;
  await wait(async () => (await botOf())?.status.state === "connected");
  const link = await api<{ link: string }>(`/api/channels/telegram/bots/${tg.botId}/pairing`, "POST", {});
  tg.message(`/start ${new URL(link.link).searchParams.get("start")}`);
  await wait(async () => Boolean((await botOf()).pairing.request));
  await api(`/api/channels/telegram/bots/${tg.botId}/pairing/${(await botOf()).pairing.request!.id}`, "POST", { approve: true });
  check("the phone stand-in is paired", await wait(() => tgTexts().some((text) => text.startsWith("연결되었습니다"))));

  // 1. Limit 2 (직접); five conversations asked.
  const settings = await api<ResourceState>("/api/resources/settings", "PUT", { mode: "manual", manual: 2 });
  check("직접 2 is the limit", settings.limit === 2 && settings.settings.mode === "manual");
  const work = await api<{ id: string }>("/api/works", "POST", { title: "학기 준비", cwd: null });
  await api(`/api/works/${work.id}`, "PATCH", { title: "학기 준비" });
  const titles = ["강의계획서", "출석부 정리", "과제 안내", "시험 문제", "자료 조사"];
  const sessions: Session[] = [];
  for (const purpose of titles) sessions.push(await api<Session>(`/api/works/${work.id}/sessions`, "POST", { provider: "claude", purpose }));
  // The second conversation asks before running a command (its approval is answered while others wait).
  await api(`/api/sessions/${sessions[1]!.id}`, "PATCH", { access: "ask" });
  const asked: SendResult[] = [];
  for (const [index, session] of sessions.entries()) asked.push(await send(session.id, `r${index + 1}`, index === 1 ? `명령 실행해 줘 [[hold:t2]]` : `${titles[index]} 해 줘 [[hold:t${index + 1}]]`));
  check("two run, three wait for a slot", asked.map((result) => result.delivery).join(",") === "turn,turn,queued,queued,queued" && asked.slice(2).every((result) => result.waitingFor === "slot"), JSON.stringify(asked));
  const line = await resources();
  check("the line: r3, r4, r5 in order, places 1-3, the reason in words", JSON.stringify(line.waiting.map((entry) => [entry.requestId, entry.position])) === JSON.stringify([["r3", 1], ["r4", 2], ["r5", 3]]) && line.reason === "지금 동시에 2개까지 돌리고 있습니다", JSON.stringify(line.waiting));
  const snap = await snapshot();
  check("each waiting conversation holds its request in its own queue, marked as waiting for a slot", [2, 3, 4].every((index) => snap.sessions.find((session) => session.id === sessions[index]!.id)?.queued.some((entry) => entry.id === `r${index + 1}` && entry.slot && !entry.held)));

  // 2. One ends → the next in line starts by itself.
  release("t1");
  check("r1 ends → r3 starts by itself", await wait(async () => (await users(sessions[2]!.id)).includes("r3")));
  check("…and r4, r5 still wait, now places 1-2", JSON.stringify(await waitingIds()) === JSON.stringify(["r4", "r5"]));

  // 3. 지금 바로 실행 jumps the line and counts as running.
  const forced = await api<SendResult>("/api/resources/run-now", "POST", { sessionId: sessions[4]!.id, requestId: "r5" });
  const afterForce = await resources();
  check("지금 바로 실행: r5 starts at once and counts as running (3 run, limit 2)", forced.delivery === "turn" && afterForce.running.length === 3 && afterForce.running.some((turn) => turn.sessionId === sessions[4]!.id && turn.forced), JSON.stringify(afterForce.running));
  check("…r4 still waits (nothing else jumped)", JSON.stringify(afterForce.waiting.map((entry) => entry.requestId)) === JSON.stringify(["r4"]));

  // 4. An approval of a running turn is answered while others wait.
  release("t2");
  const approval = await wait(async () => (await items(sessions[1]!.id)).some((item) => item.kind === "approval" && item.decision === null));
  const pending = (await items(sessions[1]!.id)).find((item) => item.kind === "approval" && item.decision === null);
  check("the running turn asks for an approval while r4 waits", approval && (await waitingIds()).includes("r4"));
  if (pending) await api(`/api/sessions/${sessions[1]!.id}/approvals/${encodeURIComponent(pending.id)}`, "POST", { decision: "accept" });
  check("…answered at once (it never waits for a slot)", await wait(async () => (await items(sessions[1]!.id)).some((item) => item.kind === "approval" && item.decision === "accept"), 10_000));
  // r2's turn ends, but the forced r5 still holds a slot: 2 run (r3, r5) — r4 waits until one of them ends.
  await wait(async () => !(await runningIds()).includes(sessions[1]!.id));
  check("r2 ended; r3 and r5 run; r4 still waits (limit 2 full)", (await runningIds()).length === 2 && JSON.stringify(await waitingIds()) === JSON.stringify(["r4"]));
  release("t5");
  check("r5 ends → r4 starts", await wait(async () => (await users(sessions[3]!.id)).includes("r4")));

  // 5. A restart in the middle with two waiting: still waiting, in order, then they run — once each.
  await api("/api/resources/settings", "PUT", { mode: "manual", manual: 1 });
  const r6 = await send(sessions[0]!.id, "r6", "다음 시간 준비 [[hold:t6]]");
  const r7 = await send(sessions[1]!.id, "r7", "출석 마감 [[hold:t7]]");
  check("with r3 and r4 running (limit 1) r6 and r7 wait", r6.waitingFor === "slot" && r7.waitingFor === "slot" && JSON.stringify(await waitingIds()) === JSON.stringify(["r6", "r7"]));
  await stopGateway();
  await startGateway();
  const back = await snapshot();
  check("after the restart r6 and r7 are still in their queues, not held", ["r6", "r7"].every((id, index) => back.sessions.find((session) => session.id === sessions[index]!.id)?.queued.some((entry) => entry.id === id && entry.slot && !entry.held)) || (await users(sessions[0]!.id)).includes("r6"));
  check("…the one slot goes to r6 (in order); r7 waits", await wait(async () => (await users(sessions[0]!.id)).includes("r6") && JSON.stringify(await waitingIds()) === JSON.stringify(["r7"])));
  release("t6");
  check("r6 ends → r7 starts", await wait(async () => (await users(sessions[1]!.id)).includes("r7")));
  const all = (await Promise.all(sessions.map((session) => users(session.id)))).flat();
  check("every request started exactly once", JSON.stringify([...all].sort()) === JSON.stringify(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]), all.join(","));

  // 6. The phone: a request that waits is told so with its place and reason, then that it started; a hand-over too.
  let from = tgTexts().length;
  tg.message("학기 준비 프로젝트에서 클로드로 공지문 초안 써 줘");
  check("phone: the chat's request waits — the chat is told its place and why", await said(from, (text) => text.startsWith("차례를 기다립니다 · 대기 1번째 — 지금 동시에 1개까지 돌리고 있습니다.")), tgTexts().slice(from).join(" | "));
  release("t7");
  check("phone: when its turn comes the chat is told it started", await said(from, (text) => text.startsWith("차례가 되어 시작했습니다")), tgTexts().slice(from).join(" | "));
  check("phone: the hand-over line says it waits (the remote's own turn holds the one slot)", await said(from, (text) => text.startsWith("→ 「학기 준비」 · 새 Claude 대화에 맡겼습니다") && text.includes("차례를 기다립니다")), tgTexts().slice(from).join(" | "));
  const handed = async () => (await snapshot()).sessions.find((session) => session.workId === work.id && !sessions.some((own) => own.id === session.id));
  check("phone: the handed-over request starts when the remote's turn ends, and the chat is told", await wait(() => tgTexts().slice(from).filter((text) => /^차례가 되어 시작했습니다 · 「.+」$/.test(text)).length >= 2, 60_000) && Boolean(await handed()), tgTexts().slice(from).join(" | "));
  const target = await handed();
  const reportHead = target ? `학기 준비 · ${target.purpose} · Claude` : "?";
  check("phone: its answer comes back", await said(from, (text) => text.split("\n")[0] === reportHead && text.length > 40), tgTexts().slice(from).map((text) => text.split("\n")[0]).join(" | "));
  await sleep(1_500);
  check("…exactly once", tgTexts().filter((text) => text.split("\n")[0] === reportHead).length === 1);
  // 7. Frames (last: a window on screen puts its conversation first in the line, so it would change the order above).
  if (shots) {
    await api("/api/resources/settings", "PUT", { mode: "manual", manual: 2 });
    for (const [index, session] of sessions.slice(0, 4).entries()) await send(session.id, `f${index + 1}`, `${titles[index]} 다시 정리해 줘 [[hold:f${index + 1}]]`);
    check("frames: f1, f2 run and f3, f4 wait", await wait(async () => JSON.stringify(await waitingIds()) === JSON.stringify(["f3", "f4"])));
    await frame("bottom-line-list", "light", { width: 1000, height: 800 }, sessions[0]!, async (page) => {
      await page.locator(".resource-line-text").click();
      await page.locator(".resource-pop").waitFor();
      await sleep(500);
    });
    for (const theme of ["light", "dark"] as const) {
      await frame("waiting-conversation", theme, { width: 1440, height: 900 }, sessions[3]!);
      await frame("bottom-line-list", theme, { width: 1440, height: 900 }, sessions[0]!, async (page) => {
        await page.locator(".resource-line-text").click();
        await page.locator(".resource-pop").waitFor();
        await sleep(500);
      });
      await frame("settings-rows", theme, { width: 1440, height: 900 }, sessions[0]!, async (page) => {
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })));
        await page.locator(".settings-dialog[open]").waitFor();
        await page.locator(".settings-nav [data-section=engines]").click();
        await page.locator(".resource-limit").waitFor();
        await page.locator(".resource-why summary").click();
        await page.locator(".resource-limit").scrollIntoViewIfNeeded();
        await sleep(300);
      });
    }
  }

  writeFileSync(join(out, "phone-telegram.txt"), tgTexts().map((text, index) => `--- ${index + 1}\n${text}`).join("\n"));
} catch (error) {
  check("the rig ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const name of ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "f1", "f2", "f3", "f4"]) release(name);
  await (browser as import("playwright-core").Browser | null)?.close();
  await stopGateway();
  await tg.stop?.();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
