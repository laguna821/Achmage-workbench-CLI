/// <reference lib="dom" />
// Browser check of a conversation while the engine works, for Codex and Claude alike, against a
// real gateway driving stand-in engines (scripts/fixtures/fake-codex.mjs, fake-claude.mjs; no model):
// new output is followed only while the reader stays at the bottom and the wheel takes that away at
// once; the request being read stays on top as an opaque band that folds and opens; Enter while
// working goes into the running turn ("작업 중 보냄"), Alt+Enter waits and goes out when the turn
// ends; after a stop the waiting request is kept until sent by hand, and a steered request the stop
// dropped is marked and waits again. Usage: node scripts/chat-flow-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-chat-flow");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-flow-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-flow-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await response.json()) as T;
};
const session = async (id: string) => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
// Straight into the work (the app opens on home by default).
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const browser = await chromium.launch();
const logs: string[] = [];

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const work = await api<Work>("POST", "/api/works", { title: `${label} 흐름`, cwd: worksDir });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "흐름" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const scroll = (p: Page) =>
    p.locator(".transcript").first().evaluate((element) => ({ top: element.scrollTop, distance: element.scrollHeight - element.scrollTop - element.clientHeight, width: element.clientWidth }));
  const type = async (text: string, keys = "Enter") => {
    const input = page.locator(".composer-input");
    await input.fill(text);
    await input.press(keys);
  };
  const idle = () => until(async () => (await session(engine.id)).status === "idle", 15_000);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");

    // ── a long answer: followed while at the bottom, the wheel stops that at once ─────────────
    await type("길게 설명해줘\n- 첫째\n- 둘째");
    await until(async () => (await session(engine.id)).status === "running");
    await page.waitForTimeout(1500);
    const following = await scroll(page);
    pass("응답이 늘어나는 동안 맨 아래를 따라감", following.distance < 4, `distance=${following.distance}`);

    const box = (await page.locator(".transcript").first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(250);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(400);
    const lifted = await scroll(page);
    await page.waitForTimeout(800);
    const later = await scroll(page);
    pass("마우스 휠로 올리면 그 자리에 머묾(맨 아래로 끌려가지 않음)", later.distance > 200 && Math.abs(later.top - lifted.top) < 2, `top ${lifted.top}→${later.top}, distance=${later.distance}`);
    const toBottom = await page.locator(".to-bottom").innerText().catch(() => "");
    pass("위로 올리면 '새 응답 보기' 단추", toBottom.includes("새 응답 보기"), toBottom);

    await page.waitForSelector(".turn-pin", { timeout: 5000 });
    await shot("01-band-folded.png");
    const band = await page.locator(".turn-pin").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, width: element.getBoundingClientRect().width, text: element.textContent ?? "" };
    });
    const opaque = !/rgba\(.*,\s*0(\.\d+)?\)$/.test(band.background) && band.background !== "transparent";
    pass("고정된 요청 띠는 불투명하고 대화 폭 전체를 덮음", opaque && Math.abs(band.width - later.width) < 2 && band.text.includes("길게 설명해줘"), `${band.background} ${Math.round(band.width)}/${later.width}`);
    await page.locator(".turn-pin-toggle").click();
    await page.waitForSelector(".turn-pin.open .turn-pin-full li");
    await shot("02-band-open.png");
    const stored = await page.evaluate(() => localStorage.getItem("workbench.pinOpen"));
    const stillPut = await scroll(page);
    pass("띠를 펼치면 요청 전체(마크다운)가 보이고 상태가 기억됨", stored === "1" && Math.abs(stillPut.top - later.top) < 2, `pinOpen=${stored}`);
    await page.locator(".turn-pin-toggle").click();
    await page.waitForSelector(".turn-pin:not(.open)");

    await page.locator(".to-bottom").click();
    await page.waitForTimeout(900);
    const back = await scroll(page);
    await page.waitForTimeout(600);
    const backLater = await scroll(page);
    pass("'새 응답 보기'를 누르면 다시 맨 아래를 따라감", back.distance < 4 && backLater.distance < 4 && backLater.top > back.top, `distance ${back.distance}/${backLater.distance}`);

    // ── Enter while working goes into the running turn ─────────────────────────────────────────
    const placeholder = await page.locator(".composer-input").getAttribute("placeholder");
    pass("작업 중에도 입력창이 열려 있고 안내가 바뀜", Boolean(placeholder?.includes("끼어들기")), String(placeholder));
    // (Long, so the turn is still running for the next step: Claude answers it as a turn of its own.)
    await type("방향 바꿔서 표로 길게 정리");
    const steered = await until(async () => (await items(engine.id)).some((item) => item.kind === "user" && item.steered === true && item.text === "방향 바꿔서 표로 길게 정리"), 8000);
    const answered = await until(async () => (await items(engine.id)).some((item) => item.kind === "assistant" && item.text.includes("이어서 받은 요청을 반영합니다: 방향 바꿔서 표로 길게 정리")), 12_000);
    await shot("03-steered.png");
    pass("Enter는 하던 작업에 전함(끼어들기, '작업 중 보냄')", steered && answered && (await page.locator(".steer-tag").count()) === 1, `steered=${steered} answered=${answered}`);

    // ── Alt+Enter waits for the end of the turn ───────────────────────────────────────────────
    await until(async () => (await session(engine.id)).status === "running", 3000);
    await type("끝나고 이것도 해줘", "Alt+Enter");
    const queuedText = await page.waitForFunction(() => document.querySelector(".queued-list")?.textContent ?? "", undefined, { timeout: 5000 }).then((handle) => handle.jsonValue());
    await shot("04-queued.png");
    pass("Alt+Enter는 끝나면 보낼 요청으로 입력창 위에 보임", queuedText.includes("끝나고 이것도 해줘"), queuedText.replace(/\s+/g, " "));
    const sentAfter = await until(async () => {
      const list = await items(engine.id);
      const end = list.findIndex((item) => item.kind === "turnEnd");
      const next = list.findIndex((item) => item.kind === "user" && item.text === "끝나고 이것도 해줘");
      return end >= 0 && next > end;
    }, 25_000);
    await idle();
    pass("작업이 끝나자 예약한 요청이 이어서 보내짐", sentAfter && (await page.locator(".queued-list").count()) === 0 && (await session(engine.id)).queued.length === 0);

    // ── after a stop, the waiting request stays until sent by hand ─────────────────────────────
    await type("길게 두 번째");
    await until(async () => (await session(engine.id)).status === "running");
    await page.waitForTimeout(500);
    await type("보류될 요청", "Alt+Enter");
    await page.waitForSelector(".queued-list .queued-row");
    await page.locator('.composer button[aria-label="중단"]').click();
    await idle();
    await page.waitForTimeout(400);
    const held = await session(engine.id);
    const notice = (await items(engine.id)).some((item) => item.kind === "notice" && item.text.includes("보낼 예정인 요청 1개"));
    await shot("05-held.png");
    pass("중단하면 예약한 요청은 보내지 않고 남겨 둠", held.queued.length === 1 && notice && (await page.locator(".queued-list .queued-row").count()) === 1, `queued=${held.queued.length} notice=${notice}`);
    await page.locator(".queued-row .link", { hasText: "지금 보내기" }).click();
    const manual = await until(async () => (await items(engine.id)).some((item) => item.kind === "user" && item.text === "보류될 요청"), 8000);
    await idle();
    pass("남겨 둔 요청은 '지금 보내기'로 보냄", manual && (await session(engine.id)).queued.length === 0);

    // ── a stop right after steering: the engine had not taken it yet ───────────────────────────
    await type("길게 느리게 세 번째");
    await until(async () => (await session(engine.id)).status === "running");
    await page.waitForTimeout(600);
    await type("멈추면 못 갈 요청");
    await until(async () => (await items(engine.id)).some((item) => item.kind === "user" && item.text === "멈추면 못 갈 요청"), 5000);
    await page.locator('.composer button[aria-label="중단"]').click();
    await idle();
    const marked = await until(async () => (await items(engine.id)).some((item) => item.kind === "user" && item.text === "멈추면 못 갈 요청" && item.undelivered === true), 5000);
    const back2 = await session(engine.id);
    const dropNotice = (await items(engine.id)).some((item) => item.kind === "notice" && item.text.includes("작업 중에 보낸 요청 1개"));
    await page.waitForTimeout(300);
    await shot("06-dropped.png");
    pass(
      "끼어든 직후 멈추면 '전해지지 않음'으로 표시하고 다시 보낼 목록에 둠",
      marked && dropNotice && back2.queued.some((entry) => entry.text === "멈추면 못 갈 요청") && (await page.locator(".steer-tag.undelivered").count()) === 1,
      `marked=${marked} notice=${dropNotice} queued=${back2.queued.map((entry) => entry.text).join("|")}`,
    );
    // Nothing runs on its own after the stop.
    await page.waitForTimeout(1500);
    const quiet = await session(engine.id);
    pass("멈춘 뒤 엔진이 혼자 이어 가지 않음", quiet.status === "idle" && !(await items(engine.id)).some((item) => item.kind === "assistant" && item.text.includes("멈추면 못 갈 요청")), quiet.status);
    await shot("07-final.png");
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
