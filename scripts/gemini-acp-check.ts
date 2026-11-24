/// <reference lib="dom" />
// 0.5.6 — Gemini as a third engine (ux/briefs/gemini-acp-056-brief.md), end to end on the built UI and
// gateway with stand-ins only: the stand-in ACP agent scripts/fixtures/fake-agy.mjs plays Google's
// Antigravity CLI (never the real one, no Google endpoint, nobody signed in), its stand-in installer copies
// it into place, a stand-in terminal worker, the repository's stand-in Claude/Codex, a stand-in keyring,
// a stand-in Telegram Bot API on 127.0.0.1. Steps:
//   1. 설정 › AI 엔진 › Gemini: missing → "Antigravity CLI 설치" runs the (stand-in) installer in a terminal
//      tab → 다시 확인: found; an old version → "업데이트 필요" and its line; Google account → the warning and
//      the opt-in; signed out → "Google 계정으로 로그인" opens a terminal tab running `agy acp --login`, the person
//      types the code into agy there → 다시 확인: 로그인됨
//   2. A Gemini conversation in a project: streamed answer, a plan, a read, a file edit asked with an approval
//      card (no "앞으로 묻지 않기") → 허용 → the file card → its document tab; the model picker filled from the
//      ACP session; 멈춤 (session/cancel); a picture attached; reopen after the engine closed = session/load;
//      the access picker without 전체 접근 and its line
//   3. The same conversation on a phone-sized window (390×844), light and dark
//   4. A messenger (stand-in Telegram) whose default engine is Gemini drives a Gemini conversation
//   5. A schedule and the automation API refuse a Gemini conversation with the line
//   7. An account Google blocked: one line in the conversation and the card, Google's appeal address, nothing retried
//   6. 이 프로젝트의 다른 대화 읽기: the stand-in Gemini gets the workbench-peers MCP server in session/new and reads
//      the project's Codex conversation with read_conversation; a Claude stand-in reads a Gemini conversation
// Usage (through ux/run-isolated.sh, after the web and host builds): node scripts/gemini-acp-check.ts <outDir>
//   GEMINI_HOST_ENTRY (default apps/host/dist/host.mjs), GEMINI_WEB_DIR (default apps/web/dist)
import { gatewayLaunch } from "./fixtures/launch-gateway.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ChannelsState, Session, Snapshot, TerminalSession, TranscriptItem, Work } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const out = resolve(process.argv[2] ?? join(tmpdir(), "wb-gemini-acp")); mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "workbench-gemini-"));
const dataDir = join(temp, "data"), worksDir = join(temp, "works"), auth = join(temp, "auth"), agyBin = join(temp, "agy-home", "bin", "agy");
const agyLog = join(temp, "agy.log"), versionFile = join(temp, "agy-version"), suspendedFlag = join(temp, "agy-suspended");
for (const dir of [dataDir, worksDir, auth]) mkdirSync(dir, { recursive: true });
// Claude and Codex stand-ins are signed in; Gemini's stand-in is not, until its terminal sign-in.
writeFileSync(join(auth, "claude"), "x"); writeFileSync(join(auth, "codex"), "x");
writeFileSync(versionFile, "1.5.1");

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await what(); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((done) => setTimeout(done, 150));
  }
};
const agy = () => (existsSync(agyLog) ? readFileSync(agyLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; method?: string; argv?: string[]; params?: Record<string, unknown>; text?: string }) : []);

const telegram = new FakeTelegram();
await telegram.start();
const started = gatewayLaunch(process.env.GEMINI_HOST_ENTRY ?? "apps/host/dist/host.mjs", resolve("scripts/fixtures/fake-secret.mjs"));
process.on("exit", started.cleanup);
const child: ChildProcess = spawn(started.command, started.args, {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: process.env.GEMINI_WEB_DIR ?? "apps/web/dist", WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_AGY_BIN: agyBin, WORKBENCH_AGY_INSTALLER: resolve("scripts/fixtures/fake-agy-installer.mjs"), FAKE_AGY_INSTALL_TO: agyBin,
    FAKE_AGY_LOG: agyLog, FAKE_AGY_STATE: join(temp, "agy-state"), FAKE_AGY_VERSION_FILE: versionFile, FAKE_ENGINE_AUTH_DIR: auth, FAKE_AGY_SUSPENDED_FILE: suspendedFlag,
    WORKBENCH_PTY_BIN: resolve("scripts/fixtures/fake-pty-worker.mjs"), WORKBENCH_TELEGRAM_API: telegram.url,
    FAKE_SECRET_OFF: join(dataDir, "keyring-off"), ...started.env,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-20_000); });
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code}): ${stderr.slice(-2000)}`)));
  createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
console.log(`gateway pid ${child.pid}`);
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as unknown };
};
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const { status, json } = await call(method, path, body);
  if (status >= 400) throw new Error(`${method} ${path}: ${status} ${JSON.stringify(json).slice(0, 300)}`);
  return json as T;
};
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const ends = async (id: string) => (await items(id)).filter((item) => item.kind === "turnEnd");

let browser: Browser | null = null;
const errors: string[] = [];
const shot = async (page: Page, name: string) => { await page.waitForTimeout(350); await page.screenshot({ path: join(out, `${name}.png`) }); };

try {
  const work = await api<Work>("POST", "/api/works", { title: "Gemini 시험", cwd: join(worksDir, "gemini-project") });
  mkdirSync(work.cwd, { recursive: true });
  writeFileSync(join(work.cwd, "README.md"), "# Gemini 시험\n\n대역 엔진으로 확인합니다.\n");
  writeFileSync(join(work.cwd, "notes.md"), "# 메모\n");
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", theme: "light", sidebar: true } });

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".sidebar, .start-view", { timeout: 30_000 });
  const card = page.locator('.setup-engine[data-provider="gemini"]');
  const openEngines = async () => {
    // The rail's 설정 key, as a person presses it (a focused terminal keeps Ctrl+, to itself).
    const shown = await page.locator(".settings-dialog[open]").first().isVisible().catch(() => false);
    console.log(`openEngines: dialog shown=${shown}, rail keys=${await page.locator('[data-rail="settings"]').count()}, errors=${errors.join(" | ").slice(0, 300)}`);
    if (!shown) await page.locator('[data-rail="settings"]').first().click();
    console.log(`openEngines: after click dialogs=${await page.locator(".settings-dialog").count()} open=${await page.locator(".settings-dialog[open]").count()}`);
    await page.locator(".settings-dialog[open]").first().waitFor({ state: "visible" }).catch(async (error) => { await page.screenshot({ path: join(out, "failure-settings.png"), timeout: 10_000 }).catch(() => undefined); throw error; });
    await page.locator(".settings-nav [data-section=engines]").click();
    await card.waitFor({ timeout: 30_000 }).catch(async (error) => { await page.screenshot({ path: join(out, "failure-card.png"), timeout: 10_000 }).catch(() => undefined); throw error; });
  };
  const cardText = async () => (await card.innerText().catch(() => "")) ?? "";

  // ── 1. settings ─────────────────────────────────────────────────────────────────────────────
  await openEngines();
  check("1a missing: 이 컴퓨터에 없음 and the 설치 key", await wait(async () => (await cardText()).includes("이 컴퓨터에 없음") && (await card.getByRole("button", { name: "Antigravity CLI 설치" }).count()) === 1), await cardText());
  await shot(page, "1440-light-01-settings-missing");
  await card.getByRole("button", { name: "Antigravity CLI 설치" }).click();
  check("1b 설치 opens a terminal tab running the installer", await wait(async () => (await page.locator(".terminal-view").count()) > 0, 20_000));
  check("1b the (stand-in) installer put agy in place", await wait(() => existsSync(agyBin), 20_000));
  await wait(async () => ((await page.locator(".terminal-view").innerText().catch(() => "")) ?? "").includes("Installed agy"), 10_000);
  await shot(page, "1440-light-02-install-terminal");
  await openEngines();
  await card.getByRole("button", { name: "다시 확인" }).click();
  check("1c an old agy: 업데이트 필요 and the line", await wait(async () => (await cardText()).includes("업데이트 필요") && (await cardText()).includes("1.5.2 이상")), await cardText());
  await shot(page, "1440-light-03-settings-old");
  writeFileSync(versionFile, "1.5.5");
  await card.getByRole("button", { name: "다시 확인" }).click();
  check("1c' 1.5.5 works, with one line recommending 1.5.12 or later", await wait(async () => (await cardText()).includes("1.5.12 이상으로 올리면 연결이 더 안정적입니다") && !(await cardText()).includes("업데이트 필요")), await cardText());
  await shot(page, "1440-light-03b-settings-recommend");
  writeFileSync(versionFile, "1.5.13");
  // Waiting for the opt-in the card has no key of its own: the section's 상태 다시 확인 looks again.
  await page.getByRole("button", { name: "상태 다시 확인" }).click();
  check("1d one way in: no API-key or Enterprise choice (subscription login only)", !(await cardText()).includes("Gemini API 키") && !(await cardText()).includes("Gemini Enterprise") && (await card.getByRole("radio").count()) === 0, await cardText());
  check("1d a Google account: the warning and the opt-in first", await wait(async () => (await cardText()).includes("동의 필요") && (await cardText()).includes("계정이 정지될 수 있다고")), await cardText());
  check("1d no 로그인 key before the opt-in", (await card.getByRole("button", { name: "Google 계정으로 로그인" }).count()) === 0);
  await card.getByRole("switch").scrollIntoViewIfNeeded();
  await shot(page, "1440-light-04-settings-optin");
  await card.getByRole("switch", { name: "위 내용을 읽었고 내 Google 계정으로 씁니다" }).click();
  check("1e signed out: 로그인 필요 and the 로그인 key", await wait(async () => (await cardText()).includes("로그인 필요") && (await card.getByRole("button", { name: "Google 계정으로 로그인" }).count()) === 1, 30_000), await cardText());
  await card.getByRole("switch").scrollIntoViewIfNeeded();
  await shot(page, "1440-light-05-settings-signed-out");
  await card.getByRole("button", { name: "Google 계정으로 로그인" }).click();
  check("1f 로그인 opens a terminal tab", await wait(async () => (await page.locator(".terminal-view").count()) > 0, 20_000));
  const terminals = await api<{ terminals: TerminalSession[] }>("GET", `/api/workspaces/${work.defaultWorkspaceId}/terminals`);
  const login = terminals.terminals.find((entry) => entry.label === "Gemini 로그인");
  check("1f the terminal runs agy's own sign-in (acp --login)", Boolean(login && login.args.slice(-2).join(" ") === "acp --login"), login ? `${login.shell} ${login.args.join(" ")}` : "none");
  await wait(async () => ((await page.locator(".terminal-view").last().innerText().catch(() => "")) ?? "").includes("Paste the code"), 15_000);
  await shot(page, "1440-light-06-login-terminal");
  // The person types the code into agy's prompt (Workbench never reads or forwards it).
  await api("POST", `/api/terminals/${login!.id}/input`, { data: "standin-code\n" });
  check("1f agy signed itself in", await wait(() => existsSync(join(auth, "agy")), 15_000));
  await openEngines();
  await card.getByRole("button", { name: "로그인 상태 확인" }).click();
  check("1g signed in: 로그인됨", await wait(async () => (await cardText()).includes("로그인됨"), 30_000), await cardText());
  check("1g signed in: 다른 계정으로 다시 로그인, and no 로그아웃 (agy documents none)", (await card.getByRole("button", { name: "다른 계정으로 다시 로그인" }).count()) === 1 && (await card.getByRole("button", { name: "로그아웃" }).count()) === 0);
  await card.getByRole("button", { name: "다른 계정으로 다시 로그인" }).scrollIntoViewIfNeeded();
  await shot(page, "1440-light-07-settings-signed-in");
  await page.locator(".settings-close").first().click();

  // ── 2. a Gemini conversation in the project ─────────────────────────────────────────────────
  const created = await call("POST", `/api/works/${work.id}/sessions`, { provider: "gemini", purpose: "Gemini 대화", access: "ask" });
  check("2 a Gemini conversation is made in the project", created.status === 201, String(created.status));
  const session = created.json as Session;
  await page.goto(`${ready.url}/?token=${ready.token}`);
  const row = page.locator(`.sidebar [data-row-id="${session.id}"]`);
  if (!(await row.count())) await page.locator(`.sidebar [data-row-id="${work.id}"]`).first().click().catch(() => undefined);
  await row.first().click({ timeout: 20_000 }).catch(async () => { await page.locator(".sidebar .side-row", { hasText: "Gemini 대화" }).first().click(); });
  await page.locator(".work-view .transcript, .work-view").first().waitFor();
  const input = page.locator(".composer-input").last();
  const send = async (text: string) => { await input.click(); await input.fill(text); await input.press("Enter"); };
  check("2 the composer carries Gemini's mark", await wait(async () => (await page.locator('.work-view .engine-mark[data-provider="gemini"]').count()) > 0, 10_000));

  await send("견본 보여 줘");
  check("2a the file edit is asked with an approval card", await wait(async () => (await page.locator('.approval-card[data-state="waiting"]').count()) > 0, 30_000));
  check("2a no 앞으로 묻지 않기 for Gemini", (await page.locator(".approval-trust").count()) === 0);
  await shot(page, "1440-light-08-approval");
  await page.locator('.approval-card[data-state="waiting"]').getByRole("button", { name: /허용/ }).click();
  check("2b the turn ends", await wait(async () => (await ends(session.id)).length === 1, 30_000));
  const done = await items(session.id);
  check("2b streamed answer", done.some((item) => item.kind === "assistant" && item.text.includes("Gemini 대역 답입니다")));
  check("2b a plan, a read and a file change, as for the other engines", done.some((item) => item.kind === "plan") && done.some((item) => item.kind === "tool" && item.tool === "search" && (item.reads?.length ?? 0) > 0) && done.some((item) => item.kind === "tool" && item.tool === "fileChange" && item.status === "completed"));
  check("2b the changed file is a document card", await wait(async () => (await items(session.id)).some((item) => item.kind === "artifact"), 15_000));
  await page.locator(".doc-card.entry-file").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await shot(page, "1440-light-09-answer-file-card");
  await page.locator(".doc-card.entry-file").first().click();
  check("2c the card opens its document tab", await wait(async () => (await page.locator(".document-view").count()) > 0, 20_000));
  await shot(page, "1440-light-10-document-tab");
  // Back to the conversation alone: 곁 화면 닫기 (the document opened beside it).
  await page.getByRole("button", { name: "곁 화면 닫기" }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.locator(".composer-input").last().waitFor();

  // The composer keeps 권한 and 모델 under 도구.
  const openTools = async () => {
    if (!(await page.locator(".work-view .composer-tools[open]").count())) await page.locator(".work-view .composer-tools > summary").last().click();
    await page.locator(".work-view .composer-tools[open]").last().waitFor();
  };
  // Model picker: filled from the ACP session's own selector.
  await openTools();
  const picker = page.locator(".work-view .composer-tools[open] .plain-select[aria-haspopup]").filter({ hasText: /Stand-in|기본/ }).first();
  await picker.click();
  const flash = page.locator(".model-menu button", { hasText: "Stand-in Flash" }).first();
  check("2d the model picker lists the session's models", await wait(async () => (await flash.count()) > 0, 10_000));
  await shot(page, "1440-light-11-model-picker");
  await flash.click().catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);
  await send("안녕");
  // What a Gemini prompt carries: the person's text, nothing added; client instructions are one or two plain lines.
  const plain = await wait(() => agy().some((entry) => entry.event === "prompt" && (entry.text ?? "").endsWith("안녕")), 30_000);
  const said = agy().filter((entry) => entry.event === "prompt" && (entry.text ?? "").endsWith("안녕")).map((entry) => entry.text).at(-1) ?? "";
  check("2d' a plain request reaches agy as exactly the person's text", plain && said === "안녕", JSON.stringify(said).slice(0, 400));
  const append = ((agy().find((entry) => entry.method === "session/new")?.params?._meta as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append) ?? "";
  check("2d' client instructions: at most two plain lines (the peers tool), no other engine's card or manuals", append.length > 0 && append.length < 300 && append.split("\n").length <= 2 && !/playwright|workbench-find|workbench-credential|맥락 카드/.test(append), append);
  check("2d the next turn runs on the chosen model", await wait(async () => (await items(session.id)).some((item) => item.kind === "assistant" && item.text.includes("standin-flash")), 30_000));

  // 멈춤
  await send("길게 써 줘");
  await wait(async () => (await items(session.id)).some((item) => item.kind === "assistant" && item.text.includes("3번째 줄")), 30_000);
  await page.getByRole("button", { name: "중단" }).first().click();
  check("2e 멈춤 sends session/cancel and the turn ends stopped", await wait(async () => (await ends(session.id)).some((item) => item.kind === "turnEnd" && item.status === "interrupted"), 30_000) && agy().some((entry) => entry.method === "session/cancel"));

  // A picture attached (pasted).
  await input.click();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 48; canvas.height = 32;
    const context = canvas.getContext("2d")!; context.fillStyle = "#2f6fdf"; context.fillRect(0, 0, 48, 32);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((value) => done(value!), "image/png"));
    const data = new DataTransfer(); data.items.add(new File([blob], "image.png", { type: "image/png" }));
    const box = [...document.querySelectorAll<HTMLTextAreaElement>(".composer-input")].at(-1)!; box.focus();
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
  await send("이 그림 봐 줘");
  check("2f the picture reached agy as ACP image content", await wait(async () => (await items(session.id)).some((item) => item.kind === "assistant" && item.text.includes("받은 그림 1장")), 30_000));

  // The access picker: no 전체 접근, one line.
  await openTools();
  await page.locator(".work-view .access-select").first().click();
  const accessMenu = page.locator(".access-menu");
  check("2g the access picker has no 전체 접근 and says why", await wait(async () => (await accessMenu.innerText().catch(() => "")).includes("전체 접근을 쓰지 않습니다") && (await accessMenu.locator(".access-full").count()) === 0, 5_000));
  await shot(page, "1440-light-12-access-picker");
  await page.keyboard.press("Escape");

  // Reopen: the engine closed (쉬는 엔진 지금 끄기), the next request loads the conversation.
  await wait(async () => (await snapshot()).sessions.find((entry) => entry.id === session.id)?.status === "idle", 20_000);
  await api("POST", "/api/engines/close-idle", {});
  await send("다시 이어서");
  check("2h reopened with session/load", await wait(() => agy().some((entry) => entry.method === "session/load"), 30_000) && await wait(async () => (await ends(session.id)).length >= 5, 30_000));
  await shot(page, "1440-light-13-conversation");

  // Dark. The light page closes first: an open page saves its own theme back to the preferences.
  await context.close();
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", theme: "dark", sidebar: true } });
  const darkPage = await dark.newPage();
  await darkPage.goto(`${ready.url}/?token=${ready.token}`);
  await darkPage.locator(`.sidebar [data-row-id="${session.id}"]`).first().click({ timeout: 20_000 }).catch(() => undefined);
  await darkPage.locator(".composer-input").last().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await shot(darkPage, "1440-dark-13-conversation");
  await darkPage.locator('[data-rail="settings"]').first().click().catch(() => undefined);
  await darkPage.locator(".settings-nav [data-section=engines]").click().catch(() => undefined);
  await darkPage.locator('.setup-engine[data-provider="gemini"]').waitFor({ timeout: 20_000 }).catch(() => undefined);
  await shot(darkPage, "1440-dark-07-settings-signed-in");
  await dark.close();

  // ── 3. the phone-sized page ───────────────────────────────────────────────────────────────
  for (const scheme of ["light", "dark"] as const) {
    await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", theme: scheme, sidebar: false } });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });
    const p = await phone.newPage();
    p.on("pageerror", (error) => errors.push(`phone: ${error.message}`));
    await p.goto(`${ready.url}/?token=${ready.token}`);
    await p.waitForTimeout(1500);
    const opened = await p.evaluate((id) => { const target = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`); target?.click(); return Boolean(target); }, session.id);
    if (!opened) await p.locator(".side-row, .home-row", { hasText: "Gemini 대화" }).first().click({ timeout: 10_000 }).catch(() => undefined);
    const shows = await wait(async () => (await p.locator(".transcript").innerText().catch(() => "")).includes("Gemini 대역 답입니다"), 20_000);
    if (scheme === "light") check("3 the phone-sized page shows the Gemini conversation", shows);
    await shot(p, `390-${scheme}-14-phone-conversation`);
    await phone.close();
  }
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", theme: "light", sidebar: true } });

  // ── 4. a messenger drives Gemini ──────────────────────────────────────────────────────────
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  const link = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${telegram.botId}/pairing`, {});
  telegram.message(`/start ${new URL(link.link).searchParams.get("start")}`);
  await wait(async () => Boolean((await api<ChannelsState>("GET", "/api/channels")).bots[0]?.pairing.request));
  const request = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.pairing.request!;
  await api("POST", `/api/channels/telegram/bots/${telegram.botId}/pairing/${request.id}`, { approve: true });
  check("4 telegram paired", await wait(() => telegram.texts().some((text) => text.startsWith("연결되었습니다"))));
  await api("PATCH", `/api/channels/telegram/bots/${telegram.botId}`, { defaultEngine: "gemini" });
  const before = telegram.texts().length;
  telegram.message("오늘 할 일 세 줄로 정리해 줘");
  check("4 the messenger's request ran on Gemini and the answer came back", await wait(() => telegram.texts().slice(before).some((text) => text.includes("Gemini 대역 답입니다")), 60_000), telegram.texts().slice(before).join(" | ").slice(0, 300));
  const phoneSession = (await snapshot()).sessions.find((entry) => entry.provider === "gemini" && entry.id !== session.id);
  check("4 the messenger conversation is a Gemini one", Boolean(phoneSession));

  // ── 5. where Gemini is refused ───────────────────────────────────────────
  const schedule = await call("POST", "/api/schedules", { sessionId: session.id, text: "매일 정리", when: { kind: "daily", time: "09:00" } });
  check("5 a schedule is refused with the line", schedule.status === 409 && JSON.stringify(schedule.json).includes("사람이 직접 보내는 요청에만"), `${schedule.status} ${JSON.stringify(schedule.json).slice(0, 160)}`);
  const automation = await call("POST", "/api/automation/submit", { commandId: "gemini-auto-1", hostId: session.hostId, workspaceId: session.workspaceId, sessionId: session.id, text: "자동 요청" });
  check("5 the automation API is refused with the line", automation.status === 409 && JSON.stringify(automation.json).includes("사람이 직접 보내는 요청에만"), `${automation.status}`);

  // ── 6. 이 프로젝트의 다른 대화 읽기 (peer-read), both ways ───────────────────────────────────
  const textOf = async (id: string) => (await items(id)).filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("\n");
  const say = (id: string, requestId: string, text: string) => api("POST", `/api/sessions/${id}/messages`, { requestId, text });
  const codexPeer = (await call("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "Codex 정리", access: "auto" })).json as Session;
  await say(codexPeer.id, "peer-codex-1", "학생 명단을 학년별로 정리해 줘");
  await wait(async () => (await ends(codexPeer.id)).length >= 1, 60_000);
  const geminiPeer = (await call("POST", `/api/works/${work.id}/sessions`, { provider: "gemini", purpose: "Gemini 이어 하기", access: "auto" })).json as Session;
  await say(geminiPeer.id, "peer-gemini-1", "방금 코덱스에서 한 작업 보고 이어서 해 줘");
  await wait(async () => (await ends(geminiPeer.id)).length >= 1, 60_000);
  const opened = agy().filter((entry) => entry.method === "session/new").at(-1);
  const servers = (opened?.params?.mcpServers as { name: string; args: string[]; env: { name: string }[] }[] | undefined) ?? [];
  check("6a the Gemini conversation gets the peers MCP server in session/new", servers.some((server) => server.name === "workbench-peers" && server.args.join(" ") === "mcp" && server.env.some((entry) => entry.name === "WORKBENCH_PEERS_SESSION")), servers.map((server) => server.name).join(", "));
  const geminiRead = await textOf(geminiPeer.id);
  check("6a the stand-in Gemini called read_conversation on the project's Codex conversation", geminiRead.includes("(Codex)") && geminiRead.includes("학생 명단을 학년별로 정리해 줘"), geminiRead.slice(0, 300));
  check("6a the read shows as a step", (await items(geminiPeer.id)).some((item) => item.kind === "tool" && item.title.includes("read_conversation") && item.status === "completed"));
  const claudePeer = (await call("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "Claude 이어 하기", access: "full" })).json as Session;
  await say(claudePeer.id, "peer-claude-1", "방금 제미나이에서 한 작업 보고 이어서 해 줘");
  await wait(async () => (await ends(claudePeer.id)).length >= 1, 60_000);
  const claudeRead = await textOf(claudePeer.id);
  check("6b a Claude conversation lists and reads a Gemini conversation (engine Gemini)", claudeRead.includes("(Gemini)") && /그 대화의 요청: (?!\(없음\))\S/.test(claudeRead) && /그 대화의 답: (?!\(없음\))\S/.test(claudeRead), claudeRead.slice(0, 300));

  // ── 7. an account Google blocked (study § H) ──────────────────────────────────────────────
  writeFileSync(suspendedFlag, "x");
  await api("POST", `/api/sessions/${session.id}/messages`, { requestId: "blocked-1", text: "막힌 계정으로 보내 봄" });
  check("7 the conversation says Google blocked the account, with Google's appeal address", await wait(async () => (await items(session.id)).some((item) => item.kind === "notice" && item.text.includes("Google이 이 계정의 Antigravity 사용을 막았습니다.") && item.text.includes("https://antigravity.google/appeal-standin")), 30_000));
  const promptsBlocked = agy().filter((entry) => entry.event === "prompt").length;
  const again = await call("POST", `/api/sessions/${session.id}/messages`, { requestId: "blocked-2", text: "한 번 더" });
  await new Promise((done) => setTimeout(done, 1500));
  check("7 and sends nothing again", agy().filter((entry) => entry.event === "prompt").length === promptsBlocked, `${again.status}`);
  const blockedPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await blockedPage.goto(`${ready.url}/?token=${ready.token}`);
  await blockedPage.locator('[data-rail="settings"]').first().click();
  await blockedPage.locator(".settings-nav [data-section=engines]").click();
  const blockedCard = blockedPage.locator('.setup-engine[data-provider="gemini"]');
  await blockedCard.waitFor({ timeout: 20_000 });
  check("7 the card: 사용 막힘, the line and Google에 이의 제기", await wait(async () => { const text = await blockedCard.innerText(); return text.includes("사용 막힘") && text.includes("Google이 이 계정의 Antigravity 사용을 막았습니다.") && (await blockedCard.getByRole("button", { name: "Google에 이의 제기" }).count()) === 1; }, 15_000));
  await blockedCard.getByRole("button", { name: "Google에 이의 제기" }).scrollIntoViewIfNeeded();
  await shot(blockedPage, "1440-light-15-settings-blocked");
  rmSync(suspendedFlag);
  await blockedCard.getByRole("button", { name: "로그인 상태 확인" }).click();
  check("7 로그인 상태 확인 after the block is lifted: 로그인됨 again", await wait(async () => (await blockedCard.innerText()).includes("로그인됨"), 30_000));
  await blockedPage.close();

  // ── what agy saw ─────────────────────────────────────────────────────────────────────────
  const starts = agy().filter((entry) => entry.event === "start" && entry.argv?.[0] === "acp" && !entry.argv.includes("--login"));
  check("agy was always started as `agy acp --disable-telemetry` (no -p, no skip-permissions)", starts.length > 0 && starts.every((entry) => entry.argv!.join(" ") === "acp --disable-telemetry"), [...new Set(starts.map((entry) => entry.argv!.join(" ")))].join(" / "));
  const init = agy().find((entry) => entry.method === "initialize");
  check("Workbench named itself achmage-workbench", (init?.params?.clientInfo as { name?: string } | undefined)?.name === "achmage-workbench");
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  for (const [index, open] of (browser?.contexts().flatMap((entry) => entry.pages()) ?? []).entries()) await open.screenshot({ path: join(out, `failure-${index}.png`) }).catch(() => undefined);
  check("rig ran to the end", false, error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 1500) : String(error));
} finally {
  await browser?.close().catch(() => undefined);
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  child.kill("SIGTERM");
  await new Promise((done) => { child.once("exit", done); setTimeout(done, 5_000); });
  await telegram.stop().catch(() => undefined);
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  if (failed) { console.log(stderr.slice(-3000)); process.exit(1); }
}
