/// <reference lib="dom" />
// 0.5.6, the project list (ux/briefs/nav-qol-056-brief.md), end to end on the built UI and gateway with
// stand-ins only: a stand-in Telegram Bot API and a stand-in Slack (Web API + Socket Mode) on 127.0.0.1,
// the repository's stand-in engines (no model), a stand-in keyring, a temporary data folder.
//   1. Both messengers' places ("텔레그램 대화", "Slack 대화") are renamed at the PC (the row's menu, F2,
//      the emptied field and 이름 지우기 bring the first name back); they stay the messengers' places;
//      the list, the tab and each stand-in bot's 프로젝트 바꾸기 say the new name; a conversation in one
//      is renamed too; the phone page (390×844) renames one through the row's ⋯.
//   2. A folder with two projects (one of them open) folds with its > and the keyboard, hides both, and
//      is still folded after a reload; the open project's tab stays.
// Usage (from the repository, through ux/run-isolated.sh, after the web and host builds):
//   node scripts/nav-qol-056-check.ts <outDir>
// Prints one PASS/FAIL line per check, writes frames and results.json to <outDir>, exits 1 on a failure.
import { gatewayLaunch } from "./fixtures/launch-gateway.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ChannelPairingLink, ChannelsState, Snapshot } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "../apps/host/src/channels/fake-slack.ts";

const out = resolve(process.argv[2] ?? "nav-qol-056-out"); mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "wb-nav-qol-056-"));
// The stand-in engines' logins: a file each in a temporary folder (never the owner's ~/.claude or ~/.codex).
const authDir = join(dataDir, "engine-auth");
mkdirSync(authDir, { recursive: true });
writeFileSync(join(authDir, "claude"), "signed in");
writeFileSync(join(authDir, "codex"), "signed in");
const telegram = new FakeTelegram(); await telegram.start();
const slack = new FakeSlack(); await slack.start();

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
/** Waits for a condition, bounded generously (a slow machine is not a failure). */
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await what()) return true; } catch { /* not yet */ } await new Promise((done) => setTimeout(done, 100)); }
  return false;
};

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [];
const started = gatewayLaunch("apps/host/dist/host.mjs", resolve("scripts/fixtures/fake-secret.mjs"));
try {
  child = spawn(started.command, started.args, {
    env: {
      ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_VAULT_SUGGEST: "",
      WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      WORKBENCH_TELEGRAM_API: telegram.url, WORKBENCH_SLACK_API: slack.url, FAKE_ENGINE_AUTH_DIR: authDir,
      FAKE_SECRET_OFF: join(dataDir, "keyring-off"), ...started.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (data) => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 60_000);
    child!.once("exit", (code) => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  console.log(`gateway pid ${child.pid}`);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const channels = () => api<ChannelsState>("GET", "/api/channels");
  const workOf = async (id: string) => (await snapshot()).works.find((work) => work.id === id)!;

  // ── both messengers registered and paired, as the PC screen does it; one line each makes its place ──
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  const tLink = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${telegram.botId}/pairing`, {});
  telegram.message(`/start ${new URL(tLink.link).searchParams.get("start")}`);
  await wait(async () => Boolean((await channels()).bots.find((bot) => bot.kind === "telegram")?.pairing.request));
  const tRequest = (await channels()).bots.find((bot) => bot.kind === "telegram")!.pairing.request!;
  await api("POST", `/api/channels/telegram/bots/${telegram.botId}/pairing/${tRequest.id}`, { approve: true });
  check("telegram paired", await wait(() => telegram.texts().some((text) => text.startsWith("연결되었습니다"))));
  await api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN });
  await wait(async () => (await channels()).bots.find((bot) => bot.kind === "slack")?.status.state === "connected");
  await api<ChannelPairingLink>("POST", `/api/channels/slack/bots/${slack.botId}/pairing`, {});
  slack.message("연결");
  await wait(async () => Boolean((await channels()).bots.find((bot) => bot.kind === "slack")?.pairing.request));
  const sRequest = (await channels()).bots.find((bot) => bot.kind === "slack")!.pairing.request!;
  await api("POST", `/api/channels/slack/bots/${slack.botId}/pairing/${sRequest.id}`, { approve: true });
  check("slack paired", await wait(() => slack.texts().some((text) => text.startsWith("연결되었습니다"))));
  telegram.message("오늘 할 일 정리해 줘");
  slack.message("오늘 할 일 정리해 줘");
  const homeOf = async (kind: "telegram" | "slack") => (await snapshot()).works.find((work) => work.messengerHome?.kind === kind && !work.archivedAt);
  check("both places made by their first line", await wait(async () => Boolean((await homeOf("telegram")) && (await homeOf("slack"))), 60_000));
  // Their first answers, so the conversations are idle.
  await wait(async () => (await snapshot()).sessions.filter((session) => session.status === "idle").length >= 2, 60_000);
  const tHome = (await homeOf("telegram"))!, sHome = (await homeOf("slack"))!;

  // ── projects: a folder 강의 with two, one outside ──
  const folder = await api<{ id: string }>("POST", "/api/folders", { name: "강의", parentId: null });
  const one = await api<{ id: string }>("POST", "/api/works", { title: "강의 1주차", cwd: null });
  const two = await api<{ id: string }>("POST", "/api/works", { title: "강의 2주차", cwd: null });
  await api("POST", "/api/works", { title: "논문 메모", cwd: null });
  for (const work of [one, two]) await api("PATCH", `/api/works/${work.id}`, { folderId: folder.id });
  const basePrefs = { onboarding: "done", layoutScope: "global", sidebar: true, theme: "light", navigator: { rail: "projects", level: "projects" } };
  await api("PUT", "/api/prefs", { prefs: basePrefs });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const p = page;
  await p.goto(`${ready.url}/?token=${ready.token}`);
  const row = (id: string) => p.locator(`.sidebar [data-row-id="${id}"][data-list-row]`);
  const homes = p.locator('.sidebar [role=tree][aria-label="메신저"]');
  const field = p.locator(".sidebar input.side-rename");
  const toList = async () => {
    if (!(await p.locator('.sidebar[data-rail="projects"]').count())) await p.locator('.nav-rail [data-rail="projects"]').click();
    if (await p.locator(".sidebar[data-level=project]").count()) await p.locator(".sidebar .nav-back").click();
    await p.locator(".sidebar[data-level=projects]").waitFor();
  };
  await toList();
  await row(tHome.id).waitFor();

  // 1a. Telegram's place by the row's menu: 이름 바꾸기 is on, the field is on the row.
  await row(tHome.id).click({ button: "right" });
  const renameItem = p.getByRole("menuitem", { name: /^이름 바꾸기/ });
  check("the place's menu offers 이름 바꾸기, on", (await renameItem.count()) === 1 && !(await renameItem.isDisabled()));
  await renameItem.click();
  await field.waitFor();
  await field.fill("연구실 텔레그램 봇");
  await field.press("Enter");
  check("renamed by its menu: the gateway keeps the name, and the place stays the messenger's", await wait(async () => { const work = await workOf(tHome.id); return work.title === "연구실 텔레그램 봇" && work.messengerHome?.kind === "telegram" && work.messengerHome.registered; }));
  check("the list shows it by its new name, under 메신저", await wait(async () => (await homes.locator(`[data-row-id="${tHome.id}"] .side-row-label`).textContent()) === "연구실 텔레그램 봇"));

  // 1b. Slack's place by F2 on its row.
  await row(sHome.id).focus();
  await p.keyboard.press("F2");
  await field.waitFor();
  await field.fill("Achmage 봇 1호기");
  await field.press("Enter");
  check("renamed by F2", await wait(async () => (await workOf(sHome.id)).title === "Achmage 봇 1호기"));
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, "1440-light-1-renamed-places.png") });

  // 1c. Each stand-in bot's 프로젝트 바꾸기 says the new name.
  const before = telegram.texts().length;
  telegram.message("메뉴");
  await wait(() => telegram.texts().length > before);
  const tMenu = telegram.button("프로젝트 바꾸기");
  telegram.press(tMenu.data, { messageId: tMenu.messageId });
  const tHas = (label: string) => { try { telegram.button(label); return true; } catch { return false; } };
  check("telegram's 프로젝트 바꾸기 lists the place by its new name", await wait(() => tHas("✓ 연구실 텔레그램 봇")), telegram.shown(tMenu.messageId) ?? "");
  check("…and not by the old one", !tHas("✓ 텔레그램 대화") && !tHas("텔레그램 대화"));
  check("…and says where the chat is by that name", (telegram.shown(tMenu.messageId) ?? "").includes("지금: 「연구실 텔레그램 봇」"));
  const tPlace = telegram.button("✓ 연구실 텔레그램 봇");
  telegram.press(tPlace.data, { messageId: tPlace.messageId });
  check("pressing it shows the place's conversations under its name", await wait(() => telegram.shown(tPlace.messageId) === "「연구실 텔레그램 봇」의 최근 대화"));
  const sBefore = slack.texts().length;
  slack.message("메뉴");
  await wait(() => slack.texts().length > sBefore);
  const sMenu = slack.button("프로젝트 바꾸기");
  slack.press(sMenu.value, { messageTs: sMenu.ts });
  const sHas = (label: string) => { try { slack.button(label); return true; } catch { return false; } };
  check("slack's 프로젝트 바꾸기 lists the place by its new name", await wait(() => sHas("✓ Achmage 봇 1호기")), slack.shown(sMenu.ts) ?? "");
  // A new conversation from the phone still goes to the renamed place (its identity is messengerHome).
  telegram.message("새 대화");
  check("새 대화 from the phone goes to the renamed place", await wait(() => telegram.texts().some((text) => text.startsWith("새 대화를 만들었습니다: 「연구실 텔레그램 봇」"))), telegram.texts().slice(-2).join(" | "));
  check("still one place per messenger", (await snapshot()).works.filter((work) => work.messengerHome).length === 2);

  // 1d. Inside the place: the tab says its name; a conversation in it is renamed too.
  await row(tHome.id).click();
  await p.locator(".sidebar[data-level=project]").waitFor();
  check("inside: the list's head says the new name", (await p.locator(".sidebar .nav-project-name").textContent()) === "연구실 텔레그램 봇");
  check("its tab says the new name", await wait(async () => (await p.locator(`.group-tab[data-tab-project="${tHome.id}"]`).allTextContents()).some((text) => text.includes("연구실 텔레그램 봇")), 10_000));
  await wait(async () => (await snapshot()).sessions.every((session) => session.status === "idle"), 60_000);
  const conversation = (await snapshot()).sessions.filter((session) => session.workId === tHome.id).sort((a, b) => a.createdAt - b.createdAt)[0]!;
  const convRow = p.locator(`.sidebar [data-row-id="${conversation.id}"]`).first();
  await convRow.waitFor();
  await convRow.focus();
  await p.keyboard.press("F2");
  const convField = p.locator(".sidebar input.side-rename");
  const convOpened = await convField.waitFor({ timeout: 5_000 }).then(() => true, () => false);
  if (convOpened) { await convField.fill("주간 할 일"); await convField.press("Enter"); }
  check("a conversation in the place is renamed by F2", convOpened && await wait(async () => (await snapshot()).sessions.find((session) => session.id === conversation.id)!.purpose === "주간 할 일"));
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, "1440-light-2-inside-renamed-place.png") });
  await toList();

  // 1e. The first name back: 이름 지우기 (Telegram), an emptied field (Slack); then the new names again.
  await row(tHome.id).click({ button: "right" });
  const clear = p.getByRole("menuitem", { name: /이름 지우기/ });
  check("a renamed place's menu offers 이름 지우기", (await clear.count()) === 1);
  await clear.click();
  check("이름 지우기 brings back 텔레그램 대화", await wait(async () => (await workOf(tHome.id)).title === "텔레그램 대화"));
  await row(sHome.id).focus();
  await p.keyboard.press("F2");
  await field.waitFor();
  check("the field shows the first name as its placeholder", (await field.getAttribute("placeholder")) === "Slack 대화");
  await field.fill("");
  await field.press("Enter");
  check("an emptied name brings back Slack 대화", await wait(async () => (await workOf(sHome.id)).title === "Slack 대화"));
  await api("PATCH", `/api/works/${tHome.id}`, { title: "연구실 텔레그램 봇" });
  await api("PATCH", `/api/works/${sHome.id}`, { title: "Achmage 봇 1호기" });
  // Its place is still kept: moving it into a folder is refused at the gateway in one line.
  const refused = await api("PATCH", `/api/works/${tHome.id}`, { folderId: folder.id }).then(() => "", (error: Error) => error.message);
  check("its place is still kept while registered (no folder)", refused.includes("'연구실 텔레그램 봇'을 폴더로 옮기거나 보관·삭제할 수 없습니다"), refused);

  // 1f. Round 2: a double click on a project row renames it (the first click does not open it first).
  await row(two.id).dblclick();
  const dbl = await field.waitFor({ timeout: 3_000 }).then(() => true, () => false);
  check("round 2: a double click on a project row opens its name field and stays at level 1", dbl && (await p.locator(".sidebar").getAttribute("data-level")) === "projects");
  if (dbl) await field.press("Escape");
  // A single click still opens it (after the double-click window).
  await row(two.id).click();
  check("round 2: a single click still opens the project", await wait(async () => (await p.locator(".sidebar[data-level=project]").count()) === 1, 5_000));
  // 이름 바꾸기 from the level-2 head's ⋯ renames in the head; the list stays inside.
  await p.locator(".sidebar .nav-head-inside .nav-head-tools .icon-button[aria-haspopup=menu]").click();
  await p.getByRole("menuitem", { name: /^이름 바꾸기/ }).click();
  const headField = p.locator(".sidebar .nav-project-head input.side-rename");
  const inHead = await headField.waitFor({ timeout: 5_000 }).then(() => true, () => false);
  check("round 2: 이름 바꾸기 at level 2 keeps level 2, the field in the head", inHead && (await p.locator(".sidebar[data-level=project]").count()) === 1);
  if (inHead) { await headField.fill("강의 2주차 (보강)"); await headField.press("Enter"); }
  check("…and renames the project", await wait(async () => (await workOf(two.id)).title === "강의 2주차 (보강)"));
  // The top bar's name on a project tab renames it too (a button there).
  const barButton = p.locator("button.topbar-title");
  const barOk = await barButton.waitFor({ timeout: 5_000 }).then(() => true, () => false);
  if (barOk) await barButton.click();
  const barField = p.locator("input.topbar-title-edit");
  const barOpened = barOk && await barField.waitFor({ timeout: 5_000 }).then(() => true, () => false);
  if (barOpened) { await barField.fill("강의 2주차"); await barField.press("Enter"); }
  check("round 2: the top bar's name on a project tab renames the project", barOpened && await wait(async () => (await workOf(two.id)).title === "강의 2주차"));
  await toList();
  // A messenger place dragged says why it does not move.
  const box = (await row(tHome.id).boundingBox())!;
  await p.mouse.move(box.x + 40, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + 40, box.y + box.height / 2 + 30, { steps: 4 });
  await p.mouse.move(box.x + 40, box.y + box.height / 2 + 60, { steps: 4 });
  await p.mouse.up();
  check("round 2: dragging a messenger place says why it does not move", await wait(async () => (await p.getByText("메신저의 자리는 옮길 수 없습니다").count()) > 0, 5_000));
  check("…and the drag does not open it", (await p.locator(".sidebar[data-level=projects]").count()) === 1);
  await toList();

  // ── 2. a folder that folds: 강의 holds 강의 1주차 (open now, its tab on the strip) and 강의 2주차 ──
  await row(one.id).click();
  await p.locator(".sidebar[data-level=project]").waitFor();
  await toList();
  const folderRow = row(folder.id);
  check("unfolded: both projects listed", (await row(one.id).count()) === 1 && (await row(two.id).count()) === 1);
  await folderRow.locator(".row-chevron").click();
  check("its > folds it: both projects hidden, the open one too", await wait(async () => (await row(one.id).count()) === 0 && (await row(two.id).count()) === 0, 5_000));
  check("the folder row says folded", (await folderRow.getAttribute("aria-expanded")) === "false");
  check("the open project's tab is still on the strip", (await p.locator(`.group-tab[data-tab-project="${one.id}"]`).count()) > 0);
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, "1440-light-3-folder-folded.png") });
  await folderRow.focus();
  await p.keyboard.press("ArrowRight");
  check("→ unfolds it", await wait(async () => (await row(one.id).count()) === 1 && (await row(two.id).count()) === 1, 5_000));
  await p.keyboard.press("ArrowLeft");
  check("← folds it", await wait(async () => (await row(one.id).count()) === 0 && (await row(two.id).count()) === 0, 5_000));
  await p.keyboard.press("Enter");
  check("Enter unfolds it", await wait(async () => (await row(one.id).count()) === 1, 5_000));
  await p.keyboard.press(" ");
  check("Space folds it", await wait(async () => (await row(one.id).count()) === 0, 5_000));
  check("the fold is kept in the screen preferences", await wait(async () => ((await snapshot()).prefs as { tree?: { closedFolders?: string[] } }).tree?.closedFolders?.includes(folder.id) === true, 10_000));
  await p.reload();
  await p.locator(".sidebar").waitFor();
  await toList();
  await folderRow.waitFor();
  check("after a reload the folder is still folded", (await folderRow.getAttribute("aria-expanded")) === "false" && (await row(one.id).count()) === 0 && (await row(two.id).count()) === 0);
  check("…and the places keep their names", (await homes.locator(`[data-row-id="${tHome.id}"] .side-row-label`).textContent()) === "연구실 텔레그램 봇" && (await homes.locator(`[data-row-id="${sHome.id}"] .side-row-label`).textContent()) === "Achmage 봇 1호기");
  await p.mouse.move(1000, 600);
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, "1440-light-4-after-reload.png") });

  // ── round 2 B: 설정 › AI 엔진, the same keys for both engines (stand-ins) ──
  await p.keyboard.press("Control+,");
  await p.locator(".settings-dialog[open]").waitFor();
  await p.locator(".settings-nav [data-section=engines]").click();
  const card = (provider: string) => p.locator(`.settings-pane[data-section=engines] .setup-engine[data-provider="${provider}"]`);
  for (const provider of ["claude", "codex"]) {
    // An idle engine's state is unknown: 로그인 상태 확인 asks it.
    const ask = card(provider).getByRole("button", { name: "로그인 상태 확인" });
    if (await ask.count()) await ask.click();
  }
  const keysShown = async (provider: string) => (await card(provider).getByRole("button", { name: "다른 계정으로 다시 로그인" }).count()) === 1 && (await card(provider).getByRole("button", { name: "로그아웃" }).count()) === 1;
  check("settings: signed in, both engines offer 다른 계정으로 다시 로그인 and 로그아웃", await wait(async () => (await keysShown("claude")) && (await keysShown("codex")), 30_000));
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, "1440-light-6-engines-signed-in.png") });
  for (const [provider, name] of [["codex", "Codex"], ["claude", "Claude"]] as const) {
    await card(provider).getByRole("button", { name: "로그아웃" }).click();
    const confirm = p.getByRole("group", { name: `${name} 로그아웃 확인` });
    await confirm.waitFor();
    check(`settings: ${name} 로그아웃 asks first and says to log out after the answer ends`, ((await confirm.textContent()) ?? "").includes(`진행 중인 ${name} 대화는 중간에 멈출 수 있으니 답이 끝난 뒤에 하세요.`));
    if (provider === "codex") await p.screenshot({ path: join(out, "1440-light-7-codex-logout-confirm.png") });
    await confirm.getByRole("button", { name: "로그아웃" }).click();
    check(`settings: ${name} signed out through its own logout; "${name} 로그인" shown`, await wait(async () => !existsSync(join(authDir, provider)) && (await card(provider).getByRole("button", { name: `${name} 로그인` }).count()) === 1, 30_000));
  }
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, "1440-light-8-engines-signed-out.png") });
  await p.keyboard.press("Escape");
  await p.locator(".settings-dialog[open]").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);

  // ── dark: the same list ──
  // A new page on the stored preferences (the open page would save its own theme back).
  await p.close();
  const kept = (await snapshot()).prefs;
  await api("PUT", "/api/prefs", { prefs: { ...kept, theme: "dark" } });
  const dark = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  dark.on("pageerror", (error) => errors.push(`dark: ${error.message}`));
  await dark.goto(`${ready.url}/?token=${ready.token}`);
  await dark.locator(`.sidebar [data-row-id="${folder.id}"][data-list-row]`).waitFor();
  await dark.mouse.move(1000, 600);
  await dark.waitForTimeout(2_000);
  console.log(`INFO dark: root ${JSON.stringify(await dark.evaluate(() => ({ data: { ...document.documentElement.dataset }, body: getComputedStyle(document.body).backgroundColor, list: getComputedStyle(document.querySelector(".sidebar")!).backgroundColor })))}`);
  check("dark: the folder is still folded", (await dark.locator(`.sidebar [data-row-id="${one.id}"][data-list-row]`).count()) === 0);
  await dark.screenshot({ path: join(out, "1440-dark-list.png") });
  await dark.close();
  await api("PUT", "/api/prefs", { prefs: { ...kept, theme: "light" } });

  // ── the phone page (390×844): rename the Slack place through its ⋯ ──
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  phone.on("pageerror", (error) => errors.push(`phone: ${error.message}`));
  await phone.goto(`${ready.url}/?token=${ready.token}`);
  const phoneRow = phone.locator(`.sidebar [data-row-id="${sHome.id}"][data-list-row]`);
  const reached = await wait(async () => {
    if (await phoneRow.isVisible()) return true;
    const opener = phone.getByRole("button", { name: "사이드바 열기" });
    if (await opener.isVisible()) { await opener.click(); return false; }
    const rail = phone.locator('.nav-rail [data-rail="projects"]');
    if (await rail.isVisible()) await rail.click();
    else if (await phone.locator(".sidebar .nav-back").isVisible()) await phone.locator(".sidebar .nav-back").click();
    return phoneRow.isVisible();
  }, 20_000);
  check("phone: the place is listed", reached);
  if (!reached) await phone.screenshot({ path: join(out, "390-phone-failure.png") });
  if (reached) {
    await phoneRow.locator(".row-more").click();
    await phone.getByRole("menuitem", { name: /^이름 바꾸기/ }).click();
    const phoneField = phone.locator(".sidebar input.side-rename");
    const opened = await phoneField.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if (opened) { await phoneField.fill("휴대폰 Slack 봇"); await phoneField.press("Enter"); }
    check("phone: renamed through the row's ⋯ › 이름 바꾸기", opened && await wait(async () => (await workOf(sHome.id)).title === "휴대폰 Slack 봇"));
    await phone.waitForTimeout(400);
    await phone.screenshot({ path: join(out, "390-phone-renamed-place.png") });
  }
  await phone.close();
  await api("PATCH", `/api/works/${sHome.id}`, { title: "Achmage 봇 1호기" });
  check("no browser exceptions", errors.length === 0, errors.join("; "));
} catch (error) {
  check("nav-qol-056 scenario", false, String(error));
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise<void>((done) => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; }
  started.cleanup();
  await telegram.stop();
  await slack.stop();
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
