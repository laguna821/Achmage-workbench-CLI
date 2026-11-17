/// <reference lib="dom" />
// Window UX rig check (0.5.3, unit window-ux): the built UI and gateway (stand-in engines, a temp data folder).
//   tabs:   a tab dragged along its strip shows only an insertion mark (no zone over the panes); over a pane's
//           body only that pane's half is tinted; Esc cancels; one pane and a 2×2 layout.
//   keys:   the window keys at the top bar's right end (자동 shown on a tiling Linux session, 숨김 hides them),
//           설정 › 화면 › 창 단추.
//   notify: a notification's 열기 reported by a stand-in notifier opens THAT conversation in the window.
// Usage: node scripts/window-ux-check.ts <out folder> [tabs|keys|notify …]   (through ux/run-isolated.sh)
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";

const out = resolve(process.argv[2] ?? "window-ux"); mkdirSync(out, { recursive: true });
const parts = new Set(process.argv.slice(3).length ? process.argv.slice(3) : ["tabs", "keys", "notify"]);
const dir = mkdtempSync(join(tmpdir(), "wb-window-ux-"));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

type Box = { left: number; top: number; width: number; height: number };
// Stand-ins (notify): a notify-send that prints its id, waits for the rig's "click", hands a token on fd 3 and prints
// "default" (as MacShell's popup does); the app binary only records a click's arguments. Nothing reaches the desktop.
const rigBin = join(dir, "rig-bin"); mkdirSync(rigBin);
writeFileSync(join(rigBin, "notify-send"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/notify.args"\necho $$\ni=0\nwhile [ ! -e "${dir}/click" ] && [ $i -lt 900 ]; do sleep 0.1; i=$((i+1)); done\nprintf 'rig-token-1' >&3\necho default\n`, { mode: 0o755 });
writeFileSync(join(rigBin, "app"), `#!/bin/sh\n[ "$1" = "--attention" ] && printf '%s\\n' "$@" > "${dir}/app.args"\nexit 0\n`, { mode: 0o755 });
// The desktop shell as the page sees it: Tauri's internals with the commands this check needs.
const fakeShell = () => {
  const callbacks: Record<number, (event: unknown) => void> = {}, listeners: Record<string, number[]> = {};
  let next = 1;
  const shell = { desktop: "niri", tiling: true, minimize: "tray", fullscreen: false };
  const calls: [string, unknown][] = [];
  Object.assign(window, { __shellCalls: calls, __emit: (event: string, payload: unknown) => (listeners[event] ?? []).forEach((id) => callbacks[id]?.({ event, id: 0, payload })),
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: (callback: (event: unknown) => void) => { const id = next++; callbacks[id] = callback; return id; },
      unregisterCallback: (id: number) => { delete callbacks[id]; },
      convertFileSrc: (path: string) => path,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push([command, args]);
        if (command === "plugin:event|listen") { (listeners[args.event as string] ??= []).push(args.handler as number); return args.handler; }
        if (command === "window_keys") {
          if (args.action === "fullscreen") shell.fullscreen = !shell.fullscreen;
          return { ...shell, did: args.action === "state" ? null : args.action };
        }
        if (command === "notify_attention") throw "unsupported";
        if (command === "take_open_files") return [];
        return null;
      } } });
};
let child: ChildProcess | null = null, browser: Browser | null = null;
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env,
    WORKBENCH_DATA_DIR: dir, WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0",
    WORKBENCH_WEB_DIR: resolve("apps/web/dist"),
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "",
    ...(parts.has("notify") ? { PATH: `${rigBin}:${process.env.PATH}`, WORKBENCH_APP_BIN: join(rigBin, "app") } : {}),
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", code => { clearTimeout(timer); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await r.json(); if (!r.ok) throw Error(`${path}: ${r.status} ${result.message}`); return result;
  };
  await api("/api/prefs", "PUT", { prefs: { onboarding: "done", startScreen: "last" } });
  const work = await api("/api/works", "POST", { title: "탭 끌기", cwd: null });
  const sessions: { id: string }[] = [];
  for (const name of ["첫째 대화", "둘째 대화", "셋째 대화", "넷째 대화", "다섯째 대화"]) {
    const session = await api(`/api/works/${work.id}/sessions`, "POST", { provider: "codex", purpose: name });
    await api(`/api/sessions/${session.id}`, "PATCH", { title: name }).catch(() => undefined);
    sessions.push(session);
  }
  const tab = (index: number) => ({ id: `t${index + 1}`, view: { kind: "work" }, workId: work.id, sessionId: sessions[index]!.id });
  browser = await chromium.launch();
  const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const open = async (layout: unknown, theme: "light" | "dark") => {
    await api("/api/prefs", "PUT", { prefs: { onboarding: "done", startScreen: "last", theme } });
    // The layout record the gateway keeps (the window reads it at start); a blank page first so the app saves nothing over it.
    await page.goto("about:blank");
    const { record } = await api("/api/layouts/global");
    await api("/api/layouts/global", "PUT", { expectedRevision: record?.revision ?? 0, layout });
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".group-tabs [data-tab-index]", { timeout: 30_000 });
    await wait(1200);
  };
  const boxOf = (selector: string) => page.evaluate((sel) => { const box = document.querySelector(sel)?.getBoundingClientRect(); return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null; }, selector) as Promise<Box | null>;
  const zones = () => page.evaluate(() => [...document.querySelectorAll(".pane-drop-zone")].map((zone) => { const box = zone.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height }; }));
  const mark = () => page.evaluate(() => { const marked = document.querySelector(".pane:not([hidden]) .group-tab-drop"); if (!marked) return null; const box = marked.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height, pane: marked.closest<HTMLElement>(".group-tabs")?.dataset.paneId ?? "" }; });
  const order = (paneId: string) => page.evaluate((id) => [...document.querySelectorAll(`.pane:not([hidden]) .group-tabs[data-pane-id="${id}"] [data-tab-id]`)].map((row) => (row as HTMLElement).dataset.tabId), paneId);
  const grab = async (tabId: string) => {
    const box = (await boxOf(`.pane:not([hidden]) [data-tab-id="${tabId}"] [role="tab"]`))!;
    await page.mouse.move(box.left + 20, box.top + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.left + 30, box.top + box.height / 2, { steps: 3 });
    return box;
  };

  if (parts.has("tabs")) for (const theme of ["light", "dark"] as const) {
    // One pane, three tabs.
    await open({ version: 2, panes: [{ id: "a", tabs: [tab(0), tab(1), tab(2)], activeTabId: "t1" }], focus: "a" }, theme);
    const pane = (await boxOf(".pane[data-pane='a']:not([hidden])"))!;
    const t3 = (await boxOf(`.pane:not([hidden]) [data-tab-id="t3"]`))!;
    await grab("t1");
    // Between 둘째 and 셋째: the left part of 셋째.
    await page.mouse.move(t3.left + 6, t3.top + t3.height / 2, { steps: 8 });
    await wait(250);
    const strip = { zones: await zones(), mark: await mark() };
    await page.screenshot({ path: join(out, `tab-reorder-${theme}.png`) });
    await page.mouse.up(); await wait(400);
    const reordered = await order("a");
    check(`${theme}: 띠 안에서 끌면 끼울 자리 표시만(칸을 덮는 상자 없음)`, strip.zones.length === 0 && strip.mark !== null && Math.abs(strip.mark.left + strip.mark.width / 2 - t3.left) < 8, JSON.stringify(strip));
    check(`${theme}: 놓으면 표시한 자리(둘째와 셋째 사이)로 감`, JSON.stringify(reordered) === JSON.stringify(["t2", "t1", "t3"]), JSON.stringify(reordered));

    // Over its own pane's body, centre: nothing (it is there already); right edge: the right half.
    await grab("t2");
    await page.mouse.move(pane.left + pane.width / 2, pane.top + pane.height / 2, { steps: 8 }); await wait(200);
    const centre = await zones();
    await page.mouse.move(pane.left + pane.width * 0.92, pane.top + pane.height / 2, { steps: 6 }); await wait(250);
    const right = await zones();
    await page.screenshot({ path: join(out, `tab-over-body-${theme}.png`) });
    await page.keyboard.press("Escape"); await wait(300);
    const cancelled = { zones: await zones(), order: await order("a"), panes: await page.locator(".pane:not([hidden])").count() };
    check(`${theme}: 한 칸의 몸 가운데에는 상자 없음, 가장자리는 그 반만 옅게`, centre.length === 0 && right.length === 1 && right[0]!.width < pane.width * 0.55 && right[0]!.left > pane.left + pane.width * 0.4, JSON.stringify({ centre, right, pane }));
    check(`${theme}: Esc로 끌기 취소(아무것도 바뀌지 않음)`, cancelled.zones.length === 0 && cancelled.panes === 1 && JSON.stringify(cancelled.order) === JSON.stringify(["t2", "t1", "t3"]), JSON.stringify(cancelled));

    // 2×2: a tab onto another pane's strip, then over another pane's body.
    const grid = { version: 2, grid: 2, panes: [
      { id: "a", tabs: [tab(0), tab(4)], activeTabId: "t1" }, { id: "b", tabs: [tab(1)], activeTabId: "t2" },
      { id: "c", tabs: [tab(2)], activeTabId: "t3" }, { id: "d", tabs: [tab(3)], activeTabId: "t4" }], focus: "a",
      tree: { kind: "split", id: "s0", axis: "vertical", ratio: 0.5,
        first: { kind: "split", id: "s1", axis: "horizontal", ratio: 0.5, first: { kind: "pane", id: "a" }, second: { kind: "pane", id: "b" } },
        second: { kind: "split", id: "s2", axis: "horizontal", ratio: 0.5, first: { kind: "pane", id: "c" }, second: { kind: "pane", id: "d" } } } };
    await open(grid, theme);
    const panes = await page.locator(".pane:not([hidden])").count();
    const bStrip = await boxOf(`.pane:not([hidden]) [data-tab-id="t2"]`);
    const dBox = await boxOf(".pane[data-pane='d']:not([hidden])");
    if (panes !== 4 || !bStrip || !dBox) { check(`${theme}: 2×2 배치가 열림`, false, `panes=${panes} ` + await page.evaluate(() => document.querySelector(".panes")?.className + " " + document.querySelectorAll(".pane").length + " " + localStorage.getItem("workbench.paneLayout.v1"))); await page.screenshot({ path: join(out, `grid-missing-${theme}.png`) }); continue; }
    await grab("t1");
    await page.mouse.move(bStrip.left + bStrip.width - 4, bStrip.top + bStrip.height / 2, { steps: 10 }); await wait(250);
    const other = { zones: await zones(), mark: await mark() };
    await page.screenshot({ path: join(out, `tab-to-other-strip-${theme}.png`) });
    await page.mouse.move(dBox.left + dBox.width * 0.9, dBox.top + dBox.height * 0.6, { steps: 10 }); await wait(250);
    const quarter = await zones();
    await page.screenshot({ path: join(out, `tab-over-quarter-${theme}.png`) });
    await page.mouse.move(dBox.left + dBox.width * 0.5, dBox.top + dBox.height * 0.6, { steps: 4 }); await wait(250);
    const whole = await zones();
    await page.screenshot({ path: join(out, `tab-over-other-pane-${theme}.png`) });
    await page.keyboard.press("Escape"); await wait(200);
    check(`${theme}: 2×2에서 다른 칸의 띠 위 → 그 띠에 끼울 자리만`, other.zones.length === 0 && other.mark?.pane === "b", JSON.stringify(other));
    check(`${theme}: 2×2에서 다른 칸 몸의 오른쪽 → 그 칸의 오른쪽 반만(창의 1/8)`, quarter.length === 1 && quarter[0]!.width < dBox.width * 0.55 && quarter[0]!.top >= dBox.top - 1, JSON.stringify({ quarter, dBox }));
    check(`${theme}: 다른 칸 몸 가운데 → 그 칸만(창 전체가 아님)`, whole.length === 1 && whole[0]!.width <= dBox.width + 1 && whole[0]!.height <= dBox.height + 1, JSON.stringify(whole));
    // The drop onto the other strip lands there.
    await grab("t1");
    await page.mouse.move(bStrip.left + bStrip.width - 4, bStrip.top + bStrip.height / 2, { steps: 10 }); await wait(150);
    await page.mouse.up(); await wait(400);
    check(`${theme}: 다른 칸의 띠에 놓으면 그 칸 탭이 됨`, JSON.stringify(await order("b")) === JSON.stringify(["t2", "t1"]), JSON.stringify(await order("b")));
  }

  if (parts.has("keys")) {
    const shellPage: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await shellPage.addInitScript(fakeShell);
    for (const theme of ["light", "dark"] as const) {
      await api("/api/prefs", "PUT", { prefs: { onboarding: "done", startScreen: "last", theme } });
      await shellPage.goto(`${ready.url}/?token=${ready.token}`);
      await shellPage.waitForSelector(".topbar-right", { timeout: 30_000 }); await wait(1200);
      const keys = await shellPage.evaluate(() => [...document.querySelectorAll(".topbar-right .window-keys button")].map((key) => { const box = key.getBoundingClientRect(); return { name: key.getAttribute("aria-label"), w: Math.round(box.width), h: Math.round(box.height), right: Math.round(window.innerWidth - box.right) }; }));
      await shellPage.screenshot({ path: join(out, `topbar-keys-${theme}.png`) });
      await shellPage.screenshot({ path: join(out, `topbar-keys-${theme}-crop.png`), clip: { x: 900, y: 0, width: 540, height: 48 } });
      check(`${theme}: niri(타일링)에서 자동이면 위 막대 오른쪽 끝에 내려놓기 · 전체 화면 · 닫기 (32px)`, JSON.stringify(keys.map((key) => key.name)) === JSON.stringify(["내려놓기", "전체 화면", "닫기"]) && keys.every((key) => key.w === 32 && key.h === 32) && keys[2]!.right < 16, JSON.stringify(keys));
      await shellPage.getByRole("button", { name: "닫기", exact: true }).hover(); await wait(200);
      await shellPage.screenshot({ path: join(out, `topbar-close-hover-${theme}-crop.png`), clip: { x: 900, y: 0, width: 540, height: 48 } });
      await shellPage.getByRole("button", { name: "전체 화면" }).click(); await wait(300);
      const full = await shellPage.evaluate(() => [...document.querySelectorAll(".window-keys button")].map((key) => key.getAttribute("aria-label")));
      await shellPage.screenshot({ path: join(out, `topbar-keys-fullscreen-${theme}-crop.png`), clip: { x: 900, y: 0, width: 540, height: 48 } });
      check(`${theme}: 전체 화면을 누르면 이름과 그림이 '원래 크기로'`, full.includes("원래 크기로"), JSON.stringify(full));
      await shellPage.getByRole("button", { name: "원래 크기로" }).click(); await wait(200);
      await shellPage.getByRole("button", { name: "내려놓기" }).click(); await shellPage.getByRole("button", { name: "닫기", exact: true }).click(); await wait(200);
      const calls = await shellPage.evaluate(() => (window as unknown as { __shellCalls: [string, { action?: string }][] }).__shellCalls.filter(([command]) => command === "window_keys").map(([, args]) => args.action));
      check(`${theme}: 단추는 셸의 window_keys로 (state, fullscreen ×2, minimize, close)`, JSON.stringify(calls.filter((action) => action !== "state")) === JSON.stringify(["fullscreen", "fullscreen", "minimize", "close"]), JSON.stringify(calls));
      // 설정 › 화면 › 창 단추
      await shellPage.keyboard.press("Control+,");
      await shellPage.getByRole("button", { name: "화면", exact: true }).first().click().catch(() => undefined);
      const row = shellPage.locator(".settings-row", { hasText: "창 단추" }).first();
      const shown = await row.waitFor({ timeout: 10_000 }).then(() => true, () => false);
      if (shown) { await row.scrollIntoViewIfNeeded(); await wait(300); await shellPage.screenshot({ path: join(out, `settings-window-keys-${theme}.png`) }); }
      check(`${theme}: 설정 › 화면 › 창 단추 (자동 / 항상 / 숨김)`, shown && (await row.textContent())!.includes("자동") && (await row.textContent())!.includes("niri"), shown ? (await row.textContent())!.slice(0, 160) : "row missing");
      if (shown && theme === "light") {
        await row.getByRole("radio", { name: "숨김" }).click().catch(async () => { await row.getByText("숨김", { exact: true }).click(); });
        await wait(500);
        const hidden = await shellPage.locator(".topbar-right .window-keys").count();
        check("숨김을 고르면 단추가 사라짐", hidden === 0, `count=${hidden}`);
        await row.getByRole("radio", { name: "자동" }).click().catch(async () => { await row.getByText("자동", { exact: true }).click(); });
        await wait(300);
      }
      await shellPage.keyboard.press("Escape");
    }
    // In a browser (no desktop shell) there are no window keys at all.
    await page.goto(`${ready.url}/?token=${ready.token}`); await page.waitForSelector(".topbar-right", { timeout: 30_000 }); await wait(800);
    check("브라우저(데스크톱 앱 아님)에는 창 단추 없음", await page.locator(".window-keys").count() === 0);
    await shellPage.close();
  }

  if (parts.has("notify")) {
    // One pane showing 첫째 대화; 셋째 대화 is not open anywhere. Its turn ends behind → the stand-in notify-send shows it.
    await api("/api/prefs", "PUT", { prefs: { onboarding: "done", startScreen: "last", theme: "light" } });
    const shellPage: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await shellPage.addInitScript(fakeShell);
    await shellPage.goto("about:blank");
    const { record } = await api("/api/layouts/global");
    await api("/api/layouts/global", "PUT", { expectedRevision: record?.revision ?? 0, layout: { version: 2, panes: [{ id: "a", tabs: [tab(0)], activeTabId: "t1" }], focus: "a" } });
    await shellPage.goto(`${ready.url}/?token=${ready.token}`);
    await shellPage.waitForSelector(".group-tabs [data-tab-index]", { timeout: 30_000 }); await wait(1500);
    const third = sessions[2]!;
    await api(`/api/sessions/${third.id}/messages`, "POST", { requestId: "rig-turn-1", text: "안녕하세요", refs: [], create: null, mode: "auto" });
    const notified = await (async () => { for (let i = 0; i < 150; i++) { if (existsSync(join(dir, "notify.args"))) return readFileSync(join(dir, "notify.args"), "utf8"); await wait(100); } return ""; })();
    check("턴이 끝나면 게이트웨이가 알림(대역 notify-send)을 띄움: 본문 클릭과 열기 단추 둘 다", notified.includes("--action=default=열기") && notified.includes("--action=open=열기") && notified.includes("--activation-token-fd=3"), notified.replace(/\n/g, " ").slice(0, 200));
    const before = await shellPage.evaluate(() => document.querySelector(".pane:not([hidden]) .group-tab.active")?.textContent ?? "");
    writeFileSync(join(dir, "click"), "");
    const clicked = await (async () => { for (let i = 0; i < 100; i++) { if (existsSync(join(dir, "app.args"))) return readFileSync(join(dir, "app.args"), "utf8").trim().split("\n"); await wait(100); } return [] as string[]; })();
    check("알림을 누르면 앱이 --attention <그 알림> --activation-token <토큰>으로 불림", clicked[0] === "--attention" && /^[a-f0-9]{64}$/.test(clicked[1] ?? "") && clicked[3] === "rig-token-1", JSON.stringify(clicked));
    // The shell's part (notifications.rs open): show the window, then this event to the page.
    await shellPage.evaluate((id) => (window as unknown as { __emit: (event: string, payload: unknown) => void }).__emit("workbench://open-attention", id), clicked[1]);
    await wait(2500);
    const after = await shellPage.evaluate(() => ({ tab: document.querySelector(".pane:not([hidden]) .group-tab.active")?.textContent ?? "", tabs: [...document.querySelectorAll(".pane:not([hidden]) .group-tab")].map((row) => row.textContent), title: document.querySelector(".topbar-title")?.textContent ?? "" }));
    await shellPage.screenshot({ path: join(out, "notification-opened-light.png") });
    const list = await api("/api/attention") as { events: { id: string; readAt: number | null }[] };
    const snapshot = await api("/api/snapshot") as { sessions: Record<string, { unread?: number | boolean }> } | { sessions: { id: string; unread?: number | boolean }[] };
    const sessionsOf = Array.isArray(snapshot.sessions) ? snapshot.sessions : Object.values(snapshot.sessions);
    const thirdNow = (sessionsOf as { id: string; unread?: number | boolean }[]).find((entry) => entry.id === third.id);
    check("그 대화가 화면에: 닫혀 있던 '셋째 대화' 탭이 열리고 활성", before.includes("첫째 대화") && after.tab.includes("셋째 대화"), JSON.stringify({ before, after }));
    check("알림은 읽음, 대화의 새 답 표시는 지워짐", list.events.find((event) => event.id === clicked[1])?.readAt != null && !thirdNow?.unread, JSON.stringify({ read: list.events.find((event) => event.id === clicked[1])?.readAt ?? null, unread: thirdNow?.unread }));
    await shellPage.close();
  }
} catch (error) {
  check("검사가 끝까지 돎", false, String(error));
} finally {
  await browser?.close().catch(() => undefined);
  if (child && child.exitCode === null) child.kill("SIGTERM");
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter(result => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
