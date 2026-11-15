/// <reference lib="dom" />
// A messenger conversation ("휴대폰 · 월/일") open in a tab of the PC window: a reader who scrolls
// up stays where they scrolled to — while nothing happens, while a message arrives from the phone,
// while the engine answers and the channel posts its progress, when the answer ends, when the PC
// marks it seen. The same for an ordinary PC conversation, as the control.
//
// Real parts: the built UI (apps/web/dist) in Chromium, the built gateway (apps/host/dist), a
// stand-in Bot API on 127.0.0.1 as the phone, the repository's stand-in engines (no model), a
// stand-in keyring. Nothing here contacts Telegram; the gateway is stopped by its PID.
//
// Usage (through ux/run-isolated.sh, after the web and host builds):
//   node scripts/pc-chat-scroll-check.ts <out-dir> [--quick]
// One PASS/FAIL line per case; exits 1 when a reader was moved. `--quick`: the wheel only.
//
// What it found on 0.5.0 (2026-11-16): at the end of ANY conversation (the phone's and the PC's alike), a
// move up in steps under 24px — a touchpad, a finger — was put back at the end by the next render, so the
// reader never left the end; and a scroll bar dragged up while an answer was being written was put back
// (1 of 4 drags; 4 of 6 once the first was fixed). Wheel notches and PageUp were kept, also through a request from the phone, its answer,
// its end and "seen". Both are fixed in Transcript.tsx (tests in Transcript.position.test.tsx).
import { gatewayLaunch } from "./fixtures/launch-gateway.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ChannelsState, Snapshot } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const out = resolve(process.argv[2] ?? join(tmpdir(), "wb-pc-chat-scroll")); mkdirSync(out, { recursive: true });
const quick = process.argv.includes("--quick");
/** `--only=wheel,touchpad`: these ways of moving only (wheel, touchpad, PageUp, scroll bar, touch). */
const only = process.argv.find(argument => argument.startsWith("--only="))?.slice(7).split(",") ?? null;
const dataDir = mkdtempSync(join(tmpdir(), "wb-pc-chat-scroll-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const until = async (what: () => boolean | Promise<boolean>, timeout = 30_000, label = "condition") => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what()) return; await sleep(80); }
  throw Error(`${label} timed out`);
};

type Sample = { t: number; why: string; top: number; toEnd: number; id: string | null; offset: number | null };
/** In the page: where the shown conversation is, each frame and at each scroll event. */
const TRACER = () => {
  const w = window as unknown as { __pcs: { trace: Sample[]; on: boolean } };
  w.__pcs = { trace: [], on: false };
  const scroller = () => document.querySelector<HTMLElement>('.pane[data-pane-active="true"] .transcript') ?? document.querySelector<HTMLElement>(".transcript");
  const sample = (why: string) => {
    const element = scroller();
    if (!element || !w.__pcs.on) return;
    const box = element.getBoundingClientRect();
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-reading-id]")).find(entry => { const at = entry.getBoundingClientRect(); return at.height > 0 && at.bottom > box.top + 1; });
    w.__pcs.trace.push({ t: Math.round(performance.now()), why, top: Math.round(element.scrollTop), toEnd: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight), id: row?.dataset.readingId ?? null, offset: row ? Math.round(row.getBoundingClientRect().top - box.top) : null });
  };
  const frame = () => { sample("frame"); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  document.addEventListener("scroll", event => { if ((event.target as HTMLElement | null)?.classList?.contains("transcript")) sample("scroll"); }, true);
};

const fake = new FakeTelegram();
await fake.start();
let child: ChildProcess | null = null, browser: Browser | null = null;
const errors: string[] = [];
try {
  const started = gatewayLaunch("apps/host/dist/host.mjs", resolve("scripts/fixtures/fake-secret.mjs"));
  child = spawn(started.command, started.args, { env: { ...process.env,
    WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_VAULT_SUGGEST: "",
    WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_TELEGRAM_API: fake.url, WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"), FAKE_SECRET_OFF: join(dataDir, "keyring-off"), ...started.env,
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  console.log(`gateway pid ${child.pid} on ${new URL(ready.url).host}`);
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const snapshot = () => api<Snapshot>("/api/snapshot");
  const ends = async (id: string) => (await api<{ items: { kind: string }[] }>(`/api/sessions/${id}/items`)).items.filter(item => item.kind === "turnEnd").length;
  const working = async (id: string) => { const status = (await snapshot()).sessions.find(session => session.id === id)?.status; return status === "running" || status === "starting"; };

  // The phone is paired the way the PC screen does it, and a conversation is made from the phone.
  await api("/api/channels/telegram/bots", "POST", { token: FAKE_TOKEN });
  const link = await api<{ link: string }>(`/api/channels/telegram/bots/${fake.botId}/pairing`, "POST", {});
  fake.message(`/start ${new URL(link.link).searchParams.get("start")}`);
  await until(async () => Boolean((await api<ChannelsState>("/api/channels")).bots[0]?.pairing.request), 30_000, "pairing request");
  const request = (await api<ChannelsState>("/api/channels")).bots[0]!.pairing.request!;
  await api(`/api/channels/telegram/bots/${fake.botId}/pairing/${request.id}`, "POST", { approve: true });
  await until(() => fake.texts().some(text => text.startsWith("연결되었습니다")), 30_000, "pairing");
  await api<{ id: string }>("/api/works", "POST", { title: "연구계획서", cwd: null });
  fake.message("길게 지난 학기 강의 평가를 정리해 줘");
  await until(async () => (await snapshot()).sessions.some(session => session.purpose.startsWith("휴대폰")), 30_000, "phone conversation");
  const phone = (await snapshot()).sessions.find(session => session.purpose.startsWith("휴대폰"))!;
  // Since 0.5.1 a phone conversation lives in its messenger's own place ("텔레그램 대화"), not in the project
  // used last: the window is opened on that place, and the PC's control conversation is made there too.
  const work = { id: (phone as unknown as { workId: string }).workId };
  await until(async () => await ends(phone.id) >= 1, 60_000, "first phone answer");
  fake.message("한 줄로 줄여 줘");
  await until(async () => await ends(phone.id) >= 2, 60_000, "second phone answer");
  console.log(`phone conversation: ${phone.purpose} (${phone.provider})`);
  // The control: an ordinary conversation of the same project, asked at the PC below.
  const pc = await api<{ id: string }>(`/api/works/${work.id}/sessions`, "POST", { provider: phone.provider, purpose: "PC 대화" });

  const tabs = [
    { id: "phone", workId: work.id, sessionId: phone.id, view: { kind: "work" } },
    { id: "pc", workId: work.id, sessionId: pc.id, view: { kind: "work" } },
  ];
  await api("/api/layouts/global", "PUT", { expectedRevision: 0, layout: { version: 2, focus: "test-pane", panes: [{ ...tabs[0], id: "test-pane", tabs, activeTabId: "phone", recentTabIds: ["phone"] }] } });
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", layoutScope: "global", startScreen: "last", sidebar: true } });

  // Scroll bars as a PC draws them (the headless default hides them, and then there is nothing to drag).
  browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  const open = async (options: { hasTouch?: boolean }) => {
    const context: BrowserContext = await browser!.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(TRACER);
    await page.addInitScript(id => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.locator('.pane[data-pane-active="true"] .transcript .turn').first().waitFor({ timeout: 30_000 });
    return { context, page };
  };

  const SCROLLER = '.pane[data-pane-active="true"] .transcript';
  /** Everything a case does at one page. */
  const at = (page: Page) => {
    const trace = (reset = false) => page.evaluate(reset => { const store = (window as unknown as { __pcs: { trace: Sample[]; on: boolean } }).__pcs; const copy = store.trace.slice(); if (reset) { store.trace.length = 0; store.on = true; } return copy; }, reset);
    const now = async () => (await page.evaluate(selector => {
      const element = document.querySelector<HTMLElement>(selector)!, box = element.getBoundingClientRect();
      const row = Array.from(element.querySelectorAll<HTMLElement>("[data-reading-id]")).find(entry => { const at = entry.getBoundingClientRect(); return at.height > 0 && at.bottom > box.top + 1; });
      return { t: Math.round(performance.now()), why: "now", top: Math.round(element.scrollTop), toEnd: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight), id: row?.dataset.readingId ?? null, offset: row ? Math.round(row.getBoundingClientRect().top - box.top) : null,
        box: { left: box.left, top: box.top, width: box.width, height: box.height }, gutter: element.offsetWidth - element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    }, SCROLLER));
    const activate = async (id: string) => {
      await page.locator(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`).click();
      await page.locator(`.pane[data-pane-active="true"][data-tab="${id}"]`).waitFor();
      await page.locator(`${SCROLLER} .turn`).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    };
    /** Back to the newest output, the way a person goes there. */
    const toEnd = async () => {
      const jump = page.locator('.pane[data-pane-active="true"] .jump-end');
      if (await jump.count()) await jump.click();
      await until(async () => (await now()).toEnd <= 24, 5_000, "back at the end");
      await sleep(150);
    };
    const middle = async () => { const { box } = await now(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
    const readers: Record<string, () => Promise<string | null>> = {
      // A mouse wheel: a few notches.
      "wheel": async () => { const { x, y } = await middle(); await page.mouse.move(x, y); for (let notch = 0; notch < 5; notch += 1) { await page.mouse.wheel(0, -120); await sleep(40); } return null; },
      // A touchpad (and a smooth-scrolling wheel): many small steps, a frame apart.
      "touchpad": async () => { const { x, y } = await middle(); await page.mouse.move(x, y); for (let step = 0; step < 90; step += 1) { await page.mouse.wheel(0, -6); await sleep(16); } return null; },
      // PageUp, after a click on the words (the conversation takes the keys).
      "PageUp": async () => {
        const point = await page.evaluate(selector => {
          const element = document.querySelector<HTMLElement>(selector)!, box = element.getBoundingClientRect();
          const text = Array.from(element.querySelectorAll<HTMLElement>(".turn-answer .markdown p")).find(entry => { const at = entry.getBoundingClientRect(); return at.top > box.top + 80 && at.bottom < box.bottom - 40; });
          const where = text?.getBoundingClientRect();
          return where ? { x: where.left + 4, y: where.top + 4 } : null;
        }, SCROLLER);
        if (!point) return "no paragraph on screen to click";
        await page.mouse.click(point.x, point.y);
        await page.keyboard.press("PageUp"); await sleep(120); await page.keyboard.press("PageUp");
        return null;
      },
      // The scroll bar's thumb, dragged up.
      "scroll bar": async () => {
        const state = await now();
        if (state.gutter < 4) return "this browser draws no scroll bar to drag (overlay)";
        const x = state.box.left + state.box.width - state.gutter / 2;
        // The track runs between the bar's two arrow keys (each as long as the bar is wide).
        const track = state.box.height - 2 * state.gutter, thumb = Math.max(24, track * state.clientHeight / state.scrollHeight);
        const y = state.box.top + state.gutter + (track - thumb) * (state.top / Math.max(1, state.scrollHeight - state.clientHeight)) + thumb / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        for (let step = 1; step <= 10; step += 1) { await page.mouse.move(x, y - step * 12); await sleep(30); }
        await page.mouse.up();
        return null;
      },
      // A finger on a touch screen (only in the page opened with touch).
      "touch": async () => {
        const { x, y } = await middle();
        const session = await page.context().newCDPSession(page);
        // The finger goes down the screen (the words come down with it), a frame at a time.
        const point = (down: number) => [{ x: Math.round(x), y: Math.round(y - 150 + down), id: 1, radiusX: 4, radiusY: 4, force: 1 }];
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) });
        for (let step = 1; step <= 36; step += 1) { await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(step * 10) }); await sleep(16); }
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
        return null;
      },
    };
    /** Did the reader stay? The first row on screen and its place, in every frame after `from`. */
    const held = (samples: Sample[], from: Sample) => {
      const after = samples.filter(sample => sample.t > from.t);
      const moved = after.filter(sample => sample.id !== from.id || Math.abs((sample.offset ?? 0) - (from.offset ?? 0)) > 3);
      const end = after.filter(sample => sample.toEnd <= 24);
      const worst = moved.reduce<Sample | null>((most, sample) => (!most || Math.abs(sample.top - from.top) > Math.abs(most.top - from.top) ? sample : most), null);
      return { ok: after.length > 0 && !moved.length && !end.length, detail: `${after.length} frames; ${moved.length ? `moved in ${moved.length} (from ${from.id}@${from.offset}px top ${from.top} to ${worst!.id}@${worst!.offset}px top ${worst!.top}, ${worst!.toEnd}px from the end, +${worst!.t - from.t}ms)` : "not moved"}${end.length ? `; at the end in ${end.length}` : ""}` };
    };
    /** One case: the reader moves up by `reader`; `meanwhile` happens (before or after the move); are they still there? */
    const run = async (name: string, reader: string, options: { before?: () => Promise<void>; after?: () => Promise<void>; shot?: string }) => {
      await toEnd();
      await trace(true);
      if (options.before) await options.before();
      const start = await now();
      const skipped = await readers[reader]!();
      if (skipped) { console.log(`SKIP ${name}: ${skipped}`); return; }
      await sleep(250);
      const from = await now();
      if (from.toEnd < 60) {
        // The move itself did not take: that is the bug as the owner describes it.
        const samples = await trace();
        const least = samples.reduce((least, sample) => Math.min(least, sample.top), start.top);
        check(name, false, `the move up did not take: ${from.toEnd}px from the end afterwards (top ${start.top} before, ${from.top} after; highest reached ${least})`);
        if (options.shot) await page.screenshot({ path: join(out, `${options.shot}.png`) });
        writeFileSync(join(out, `${name.replace(/[^\w가-힣]+/g, "-")}.trace.json`), JSON.stringify(samples));
        return;
      }
      if (options.after) await options.after(); else await sleep(1_500);
      await sleep(400);
      const samples = await trace();
      const result = held(samples, from);
      check(name, result.ok, result.detail);
      if (!result.ok) writeFileSync(join(out, `${name.replace(/[^\w가-힣]+/g, "-")}.trace.json`), JSON.stringify(samples));
      if (options.shot) await page.screenshot({ path: join(out, `${options.shot}.png`) });
    };
    return { page, trace, now, activate, toEnd, run };
  };

  /** A long answer asked from the phone; resolves once it is being written (`started`) or over (`ended`). */
  const phoneAsk = async (text: string) => {
    const before = await ends(phone.id);
    fake.message(text);
    return {
      started: () => until(() => working(phone.id), 20_000, "the phone's request reached the engine").then(() => sleep(1_200)),
      ended: () => until(async () => await ends(phone.id) > before && !(await working(phone.id)), 60_000, "the phone's answer ended").then(() => sleep(1_500)),
    };
  };

  const { context, page } = await open({});
  const desk = at(page);
  const methods = (quick ? ["wheel"] : ["wheel", "touchpad", "PageUp", "scroll bar"]).filter(method => !only || only.includes(method));

  // ── The messenger conversation, at the PC ──
  await desk.activate("phone");
  const first = await desk.now();
  check("the phone's conversation is long enough to scroll", first.scrollHeight - first.clientHeight > 600, `${first.scrollHeight - first.clientHeight}px to scroll, a ${first.gutter}px scroll bar`);
  await page.screenshot({ path: join(out, "phone-at-end.png") });
  for (const method of methods) await desk.run(`phone · ${method} · (a) nothing happens`, method, { shot: method === "wheel" ? "phone-scrolled-up" : method === "touchpad" ? "phone-touchpad" : undefined });
  for (const method of methods) {
    // (b) a message arrives from the phone, (c) the engine answers and the channel posts its progress,
    // (d) the answer ends and the closing lines go out, (e) the PC marks it seen — all after the move up.
    await desk.run(`phone · ${method} · (b–e) then a request from the phone, its answer, its end, seen`, method, {
      after: async () => { const asked = await phoneAsk(`길게 ${method} 다음 주 강의 계획을 적어 줘`); await asked.ended(); },
      shot: method === "wheel" ? "phone-after-phone-turn" : undefined,
    });
  }
  for (const method of methods) {
    // The reader follows the answer at the end, then moves up while it is being written.
    let asked: Awaited<ReturnType<typeof phoneAsk>> | null = null;
    await desk.run(`phone · ${method} · (c–e) moving up while the phone's answer is written`, method, {
      before: async () => { asked = await phoneAsk(`길게 ${method} 과제 채점 기준을 적어 줘`); await asked.started(); },
      after: async () => { await asked!.ended(); },
      shot: method === "wheel" ? "phone-during-answer" : undefined,
    });
  }

  // ── The control: an ordinary conversation, asked at the PC ──
  await desk.activate("pc");
  const composer = page.locator('.pane[data-pane-active="true"] .composer-input');
  const pcAsk = async (text: string) => {
    const before = await ends(pc.id);
    await composer.fill(text);
    await page.locator('.pane[data-pane-active="true"]').getByRole("button", { name: "보내기", exact: true }).click();
    return {
      started: () => until(() => working(pc.id), 20_000, "the PC's request reached the engine").then(() => sleep(1_200)),
      ended: () => until(async () => await ends(pc.id) > before && !(await working(pc.id)), 60_000, "the PC's answer ended").then(() => sleep(1_500)),
    };
  };
  await (await pcAsk("길게 지난 학기 강의 평가를 정리해 줘")).ended();
  await (await pcAsk("한 줄로 줄여 줘")).ended();
  for (const method of methods) await desk.run(`pc · ${method} · (a) nothing happens`, method, { shot: method === "touchpad" ? "pc-touchpad" : undefined });
  for (const method of methods) {
    let asked: Awaited<ReturnType<typeof pcAsk>> | null = null;
    await desk.run(`pc · ${method} · (c–e) moving up while the answer is written`, method, {
      before: async () => { asked = await pcAsk(`길게 ${method} 과제 채점 기준을 적어 줘`); await asked.started(); },
      after: async () => { await asked!.ended(); },
    });
  }
  await context.close();

  // ── A touch screen (a page of its own: the PC cases above run without touch) ──
  if (!quick && (!only || only.includes("touch"))) {
    const touch = await open({ hasTouch: true });
    const finger = at(touch.page);
    await finger.activate("phone");
    await finger.run("phone · touch · (a) nothing happens", "touch", { shot: "phone-touch" });
    await finger.run("phone · touch · (b–e) then a request from the phone, its answer, its end, seen", "touch", { after: async () => { const asked = await phoneAsk("길게 touch 다음 주 강의 계획을 적어 줘"); await asked.ended(); } });
    let asked: Awaited<ReturnType<typeof phoneAsk>> | null = null;
    await finger.run("phone · touch · (c–e) moving up while the phone's answer is written", "touch", {
      before: async () => { asked = await phoneAsk("길게 touch 과제 채점 기준을 적어 줘"); await asked.started(); },
      after: async () => { await asked!.ended(); },
    });
    await finger.activate("pc");
    await finger.run("pc · touch · (a) nothing happens", "touch", {});
    await touch.context.close();
  }
  check("no browser exceptions", errors.length === 0, errors.join("; "));
} catch (error) {
  check("pc chat scroll scenario", false, String(error));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once("exit", () => done())); child.kill("SIGTERM"); await exited; console.log(`gateway ${child.pid} stopped`); }
  await fake.stop();
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors }, null, 2));
  console.log(`${results.filter(result => result.ok).length}/${results.length} passed`);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
