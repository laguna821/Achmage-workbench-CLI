// "올인원 리모콘" end to end (ux/briefs/phone-remote-brief.md): the messenger's own conversation hands work
// to a project's conversation with workbench-remote, and the answer comes back to the same phone chat.
//
// Real parts: the built gateway (apps/host/dist), its workbench-remote command and spool, the channel
// core, and — with `--shots` — the built UI (apps/web/dist) in Chromium. Stand-ins: the Bot API and
// Slack (fake-telegram.ts, fake-slack.ts) on 127.0.0.1 as the phone, the engines (fake-claude.mjs,
// fake-codex.mjs, the remote's rules played by fake-remote.mjs instead of a model), the keyring
// (fake-secret.mjs). Nothing here contacts Telegram or Slack; the gateway is stopped by its PID.
//
// Usage (through ux/run-isolated.sh, after `npm run build -w @workbench/host`, and the web build for --shots):
//   node scripts/phone-remote-check.ts <out-dir> [--shots]
// One PASS/FAIL line per check; exits 1 when any failed. `<out-dir>/phone-telegram.txt` and
// `phone-slack.txt` are the stand-ins' record of what the phone was sent; with --shots, PNGs of the PC.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelsState, Session, Snapshot, TranscriptItem } from "@workbench/contracts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "../apps/host/src/channels/fake-slack.ts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const out = resolve(process.argv[2] ?? join(tmpdir(), "wb-phone-remote")); mkdirSync(out, { recursive: true });
const shots = process.argv.includes("--shots");
const dataDir = mkdtempSync(join(tmpdir(), "wb-phone-remote-"));
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await what()) return true; await sleep(100); }
  return false;
};

const tg = new FakeTelegram(), slack = new FakeSlack();
await tg.start();
await slack.start();
let child: ChildProcess | null = null;
let ready: { url: string; token: string } | null = null;
const api = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
  const response = await fetch(`${ready!.url}${path}`, { method, headers: { authorization: `Bearer ${ready!.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
};
const snapshot = () => api<Snapshot>("/api/snapshot");
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>(`/api/sessions/${id}/items`)).items;
const sessionsIn = async (workId: string) => (await snapshot()).sessions.filter((session) => session.workId === workId && !session.archivedAt);
const tgTexts = () => tg.texts();
const slackTexts = () => slack.texts().map((text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
const tgPress = (label: string) => { const button = tg.button(label); tg.press(button.data, { messageId: button.messageId }); };
/** A text sent after `from` that passes `test`. */
const said = (list: () => string[], from: number, test: (text: string) => boolean, ms = 60_000) => wait(() => list().slice(from).some(test), ms);
const head = (text: string) => text.split("\n")[0]!;

try {
  child = spawn(process.execPath, [process.env.CHANNEL_SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_VAULT_SUGGEST: "",
      WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      WORKBENCH_TELEGRAM_API: tg.url, WORKBENCH_SLACK_API: slack.url,
      WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"), FAKE_SECRET_OFF: join(dataDir, "keyring-off"),
      FAKE_ENGINE_STATE: join(dataDir, "fake-engine-state"),
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

  // Both messengers registered and paired, as the PC screen does it.
  await api("/api/channels/telegram/bots", "POST", { token: FAKE_TOKEN });
  await api("/api/channels/slack/bots", "POST", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN, appName: "Workbench 노트북" });
  const botOf = async (kind: "telegram" | "slack") => (await api<ChannelsState>("/api/channels")).bots.find((bot) => bot.kind === kind)!;
  await wait(async () => (await botOf("telegram"))?.status.state === "connected" && (await botOf("slack"))?.status.state === "connected");
  const link = await api<{ link: string }>(`/api/channels/telegram/bots/${tg.botId}/pairing`, "POST", {});
  tg.message(`/start ${new URL(link.link).searchParams.get("start")}`);
  await wait(async () => Boolean((await botOf("telegram")).pairing.request));
  await api(`/api/channels/telegram/bots/${tg.botId}/pairing/${(await botOf("telegram")).pairing.request!.id}`, "POST", { approve: true });
  await api(`/api/channels/slack/bots/${slack.botId}/pairing`, "POST", {});
  slack.message("연결");
  await wait(async () => Boolean((await botOf("slack")).pairing.request));
  await api(`/api/channels/slack/bots/${slack.botId}/pairing/${(await botOf("slack")).pairing.request!.id}`, "POST", { approve: true });
  const welcome = "프로젝트 이름을 대고 시키면 그 프로젝트에서 일합니다.";
  check("both paired; each welcome has the remote's one line", await wait(() => tgTexts().some((text) => text.startsWith("연결되었습니다") && text.includes(welcome)) && slackTexts().some((text) => text.startsWith("연결되었습니다") && text.includes(welcome))));

  // The person's projects, made at the PC.
  // Named by the person (a title the person typed is kept; an untitled one would be renamed from its first request).
  const project = async (title: string) => { const work = await api<{ id: string }>("/api/works", "POST", { title, cwd: null }); await api(`/api/works/${work.id}`, "PATCH", { title }); return work; };
  const syllabus = await project("강의계획서");
  const notes = await project("연구노트");
  await project("학회 발표");

  // 1. A project and an engine named: a new Claude conversation there, the hand-over line, the remote's one line, the answer under its head line.
  let from = tgTexts().length;
  const first = "강의계획서 프로젝트에서 클로드로 서론을 질문 하나로 시작하게 다시 써 줘";
  tg.message(first);
  check("a conversation appears in the named project with the person's words as its first request", await wait(async () => {
    const made = (await sessionsIn(syllabus.id))[0];
    if (!made || made.provider !== "claude") return false;
    const request = (await items(made.id)).find((item) => item.kind === "user");
    return request?.kind === "user" && request.text === first && request.origin?.channel === "telegram";
  }));
  const target = (await sessionsIn(syllabus.id))[0]!;
  check("the gateway's hand-over line in the chat shows where and what was sent", await said(tgTexts, from, (text) => text.startsWith("→ 「강의계획서」 · 새 Claude 대화에 맡겼습니다") && text.includes(`보낸 말: ${first}`)));
  check("the remote answers in one line", await said(tgTexts, from, (text) => text.split("\n")[0] === "「강의계획서」 프로젝트 · 새 Claude 대화에 맡겼습니다"));
  check("the project conversation's answer arrives in the phone chat under its head line", await said(tgTexts, from, (text) => head(text) === `강의계획서 · ${target.purpose} · Claude` && text.length > 60), tgTexts().slice(from).map(head).join(" | "));
  const reports = () => tgTexts().filter((text) => head(text) === `강의계획서 · ${target.purpose} · Claude`).length;
  await sleep(1_500);
  check("…exactly once", reports() === 1, String(reports()));
  const remoteId = (await botOf("telegram")).bindings[0]!.pointerSessionId;
  const remote = (await snapshot()).sessions.find((session) => session.id === remoteId)!;
  const home = (await snapshot()).works.find((work) => work.id === remote.workId);
  check("the chat stays at the remote, in the messenger's place", Boolean(home?.messengerHome));
  check("the remote's transcript keeps the person's words and a readable hand-over line", await wait(async () => {
    const list = await items(remote.id);
    return list.some((item) => item.kind === "user" && item.text === first) && list.some((item) => item.kind === "notice" && item.text.startsWith("→ 「강의계획서」"));
  }));

  // 2. No engine named and no default: the choice buttons; the pick starts it.
  from = tgTexts().length;
  tg.message("연구노트 프로젝트에서 이번 주 실험 요약 정리해 줘");
  check("no engine and no default: the remote asks with [Claude] [Codex]", await said(tgTexts, from, (text) => text.includes("어느 엔진으로 할까요?")) && await wait(() => { try { tg.button("Codex"); return true; } catch { return false; } }));
  check("…and nothing was started yet", (await sessionsIn(notes.id)).length === 0);
  from = tgTexts().length;
  tgPress("Codex");
  check("the pick starts a Codex conversation in that project", await wait(async () => (await sessionsIn(notes.id)).some((session) => session.provider === "codex")));
  const codex = (await sessionsIn(notes.id)).find((session) => session.provider === "codex")!;
  check("its answer arrives under its head line", await said(tgTexts, from, (text) => head(text) === `연구노트 · ${codex.purpose} · Codex`), tgTexts().slice(from).map(head).join(" | "));

  // 3. An unclear project: choices of the likeliest; a pick goes on.
  from = tgTexts().length;
  tg.message("기말 프로젝트에서 클로드로 채점표 만들어 줘");
  check("an unknown project is not made: the remote asks with project buttons", await said(tgTexts, from, (text) => text.includes("어느 프로젝트에서 할까요?")) && await wait(() => { try { tg.button("학회 발표"); return true; } catch { return false; } }));
  check("…no project was created", (await snapshot()).works.filter((work) => !work.messengerHome).length === 3);
  tgPress("학회 발표");
  const conference = (await snapshot()).works.find((work) => work.title === "학회 발표")!;
  check("the picked project gets the conversation", await wait(async () => (await sessionsIn(conference.id)).length === 1));
  const third = (await sessionsIn(conference.id))[0]!;
  check("…and its answer comes back", await said(tgTexts, from, (text) => head(text) === `학회 발표 · ${third.purpose} · Claude`));

  // 4. 이 대화로 들어가기: the next line goes there; then back to the remote in one press.
  await sleep(500);
  tgPress("이 대화로 들어가기");
  check("이 대화로 들어가기 moves the chat into that conversation", await wait(async () => (await botOf("telegram")).bindings[0]!.pointerSessionId === third.id));
  tg.message("마지막 문항에 배점도 적어 줘");
  check("a follow-up line goes straight to that conversation", await wait(async () => (await items(third.id)).some((item) => item.kind === "user" && item.text === "마지막 문항에 배점도 적어 줘")));
  check("…and not to the remote", !(await items(remote.id)).some((item) => item.kind === "user" && item.text === "마지막 문항에 배점도 적어 줘"));
  await wait(async () => { try { tg.button("리모콘으로 돌아가기"); return true; } catch { return false; } });
  tgPress("리모콘으로 돌아가기");
  check("리모콘으로 돌아가기 brings the chat back to the remote in one press", await wait(async () => (await botOf("telegram")).bindings[0]!.pointerSessionId === remote.id));

  // 5. The same on Slack, and nothing crosses to Telegram.
  const tgBefore = tg.calls.length;
  let slackFrom = slackTexts().length;
  slack.message("강의계획서 프로젝트에서 클로드로 목차를 정리해 줘");
  check("Slack: a new conversation in the project, and its answer under the head line in Slack", await said(slackTexts, slackFrom, (text) => /^강의계획서 · .+ · Claude$/.test(head(text)) && text.length > 60), slackTexts().slice(slackFrom).map(head).join(" | "));
  check("Slack: the hand-over line shows what was sent", slackTexts().slice(slackFrom).some((text) => text.startsWith("→ 「강의계획서」") && text.includes("보낸 말: 강의계획서 프로젝트에서 클로드로 목차를 정리해 줘")));
  await sleep(1_000);
  check("nothing of Slack's remote reached Telegram", tg.calls.slice(tgBefore).every((call) => !String(call.params.text ?? "").includes("목차")));
  slackFrom = slackTexts().length;
  slack.message("강의계획서 프로젝트 지금 뭐 해?");
  check("Slack: \"…프로젝트 지금 뭐 해?\" is answered from projects/peek in a few lines", await said(slackTexts, slackFrom, (text) => text.startsWith("「강의계획서」 · ") && text.split("\n\n")[0]!.split("\n").length <= 3));

  // Nothing secret leaves: no key variable named in anything the phones got.
  const phone = [...tgTexts(), ...slackTexts()].join("\n");
  check("no key or key variable in anything sent to the phones", !phone.includes("WORKBENCH_REMOTE_KEY") && !/[A-Za-z0-9_-]{43}/.test(phone));
  writeFileSync(join(out, "phone-telegram.txt"), tgTexts().map((text, index) => `--- ${index + 1}\n${text}`).join("\n"));
  writeFileSync(join(out, "phone-slack.txt"), slackTexts().map((text, index) => `--- ${index + 1}\n${text}`).join("\n"));
  const audit = await api<{ rows: { action: string; result: string | null }[] } | { action: string; result: string | null }[]>(`/api/channels/audit?limit=200`).catch(() => null);
  const rows = Array.isArray(audit) ? audit : audit?.rows ?? [];
  check("every command call wrote an audit row", rows.filter((row) => row.action.startsWith("remote.")).length >= 5, String(rows.filter((row) => row.action.startsWith("remote.")).length));

  if (shots) {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch();
    try {
      await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true } });
      let revision = 0;
      const frame = async (name: string, session: Session, theme: "light" | "dark", size: { width: number; height: number }) => {
        const tab = { id: "t", workId: session.workId, sessionId: session.id, view: { kind: "work" } };
        revision = (await api<{ record: { revision?: number } | null }>("/api/layouts/global")).record?.revision ?? 0;
        await api("/api/layouts/global", "PUT", { expectedRevision: revision, layout: { version: 2, focus: "p", panes: [{ ...tab, id: "p", tabs: [tab], activeTabId: "t", recentTabIds: ["t"] }] } });
        await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true, theme } });
        const context = await browser.newContext({ viewport: size, colorScheme: theme });
        const page = await context.newPage();
        await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), session.workId);
        await page.goto(`${ready!.url}/?token=${ready!.token}`);
        await page.locator(".transcript .turn").first().waitFor({ timeout: 30_000 });
        await sleep(800);
        // The project conversation from its start: its first request with the phone's mark.
        if (name === "project") { await page.evaluate(() => { const scroller = document.querySelector<HTMLElement>(".transcript"); if (scroller) scroller.scrollTop = 0; }); await sleep(400); }
        await page.screenshot({ path: join(out, `${name}-${theme}-${size.width}.png`) });
        await context.close();
      };
      const now = (await snapshot()).sessions;
      const remoteNow = now.find((session) => session.id === remote.id)!, targetNow = now.find((session) => session.id === target.id)!;
      for (const theme of ["light", "dark"] as const) {
        await frame("remote", remoteNow, theme, { width: 1440, height: 900 });
        await frame("project", targetNow, theme, { width: 1440, height: 900 });
      }
      await frame("remote", remoteNow, "light", { width: 1000, height: 800 });
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  check("the rig ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((done) => child!.once("exit", done));
    console.log(`gateway ${child.pid} stopped`);
  }
  await tg.stop?.();
  await slack.stop?.();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
