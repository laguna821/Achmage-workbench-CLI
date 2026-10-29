// The first app-e2e scenarios, run against the real desktop app through WebDriver. Each step prints
// PASS/FAIL with a detail and a screenshot; what is only observed (a picker's list, an opener's
// command) is recorded as INFO and in results.json.

import type { AppRun, Stage } from "./launch.ts";
import type { Report } from "./report.ts";
import type { ElementRef, WebDriver } from "./webdriver.ts";
import { sleep } from "./webdriver.ts";

export type Ctx = { stage: Stage; app: AppRun; report: Report };

export async function shot(ctx: Ctx, name: string, element?: ElementRef) {
  return ctx.app.wd.screenshot(ctx.report.path(name), element);
}

/** Polls `what` until true (or `timeoutMs`); returns the last answer. */
export async function until(what: () => Promise<boolean>, timeoutMs = 10_000, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ok = await what().catch(() => false);
    if (ok || Date.now() > end) return ok;
    await sleep(everyMs);
  }
}

// ── the page probe: errors the page logs, and the input events it receives ──────────────────────

const PROBE = `
if (!window.__e2e) {
  const e2e = (window.__e2e = { errors: [], events: [], recording: false });
  const describe = (target) => {
    if (target === window) return "window";
    if (target === document) return "document";
    if (!(target instanceof Element)) return String(target);
    const row = target.closest("[data-row-id],[data-vault-path],.doc-tab-open,.pane-divider,.pane-head,.now-row,.vault-note");
    const own = target.tagName.toLowerCase() + (target.className && typeof target.className === "string" ? "." + target.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
    return row && row !== target ? own + " in " + row.tagName.toLowerCase() + "." + String(row.className).trim().split(/\\s+/).slice(0, 2).join(".") : own;
  };
  const original = console.error;
  console.error = function (...args) {
    e2e.errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ").slice(0, 300));
    return original.apply(this, args);
  };
  window.addEventListener("error", (event) => e2e.errors.push("error: " + event.message));
  window.addEventListener("unhandledrejection", (event) => e2e.errors.push("unhandled: " + String(event.reason && event.reason.message ? event.reason.message : event.reason)));
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "dragstart", "drag", "dragend", "drop", "selectstart", "blur", "lostpointercapture", "contextmenu"]) {
    window.addEventListener(type, (event) => {
      if (!e2e.recording || e2e.events.length > 4000) return;
      e2e.events.push({ type, trusted: event.isTrusted, x: event.clientX ?? null, y: event.clientY ?? null, buttons: event.buttons ?? null, target: describe(event.target), pointerType: event.pointerType ?? null });
    }, true);
  }
}
return true;`;

export const installProbe = (wd: WebDriver) => wd.execute<boolean>(PROBE);

export type EventSummary = { counts: Record<string, number>; trusted: boolean; order: string[]; dragstart: string | null; cancel: boolean; up: string | null; down: string | null };

export async function record(wd: WebDriver) {
  await installProbe(wd);
  await wd.execute("window.__e2e.events = []; window.__e2e.recording = true; return true;");
}

/** Stops recording; the counts per type, whether every event was trusted, the order of distinct kinds. */
export async function recorded(wd: WebDriver): Promise<EventSummary> {
  const events = await wd.execute<{ type: string; trusted: boolean; target: string }[]>("window.__e2e.recording = false; return window.__e2e.events;");
  const counts: Record<string, number> = {};
  const order: string[] = [];
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    if (order[order.length - 1] !== event.type) order.push(event.type);
  }
  const first = (type: string) => events.find((event) => event.type === type)?.target ?? null;
  return {
    counts,
    trusted: events.length > 0 && events.every((event) => event.trusted),
    order: order.slice(0, 30),
    dragstart: first("dragstart"),
    cancel: Boolean(counts.pointercancel),
    down: first("pointerdown"),
    up: first("pointerup"),
  };
}

export const pageErrors = (wd: WebDriver) => wd.execute<string[]>("return window.__e2e ? window.__e2e.errors.slice() : [];");

// ── 1. the app starts in its own window, the home screen shows, onboarding can be dismissed ──────

export async function startScenario(ctx: Ctx) {
  const { wd } = ctx.app;
  const S = "1 시작";
  await wd.waitFor(".sidebar", 40_000, "the sidebar");
  await installProbe(wd);
  const handles = await wd.windowHandles();
  const title = await wd.title();
  const rect = await wd.windowRect();
  const page = await wd.execute<{ width: number; height: number; dpr: number; visibility: string; tauri: boolean; ua: string }>(
    "return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState, tauri: typeof window.__TAURI_INTERNALS__ === 'object', ua: navigator.userAgent };",
  );
  ctx.report.note(S, `창 ${rect.width}×${rect.height} · 페이지 ${page.width}×${page.height} @${page.dpr} · ${page.visibility} · ${page.ua}`);
  const dialog = await wd.waitFor(".onboarding-backdrop[role=dialog]", 20_000, "the onboarding dialog").catch(() => null);
  const first = await shot(ctx, "1-start-first-screen.png");
  ctx.report.check(
    S,
    "앱이 자기 창 하나로 열리고(Tauri 웹뷰, 게이트웨이 주소) 페이지가 창 크기대로 그려짐",
    handles.length === 1 && title === "Achmage Workbench" && page.tauri && page.width === rect.width && page.dpr === 1 && ctx.app.gateway.url.startsWith("http://127.0.0.1:"),
    `창 ${handles.length}개 · "${title}" · Tauri IPC ${page.tauri ? "있음" : "없음"} · ${ctx.app.gateway.url}`,
    first,
  );
  const home = await wd.execute<{ sidebar: boolean; start: boolean; composer: boolean; engines: string[] }>(
    "return { sidebar: !!document.querySelector('.sidebar'), start: !!document.querySelector('.start-view'), composer: !!document.querySelector('.start-view .composer'), engines: [...document.querySelectorAll('.engine-tabs .engine-tab')].map((tab) => tab.textContent.trim()) };",
  );
  ctx.report.check(S, "첫 화면: 사이드바와 새 세션 홈(엔진 고르기, 입력창)", home.sidebar && home.start && home.composer && home.engines.join(",") === "Claude,Codex", `엔진 탭 ${home.engines.join(" · ")}`, first);
  ctx.report.check(S, "처음 실행이면 처음 안내(온보딩)가 뜸", Boolean(dialog), dialog ? (await wd.text(dialog)).split("\n").slice(0, 4).join(" · ") : "안내가 뜨지 않음", first);
  if (!dialog) return;
  const skip = (await wd.findAll(".onboarding-actions button")).at(0);
  const label = skip ? await wd.text(skip) : "";
  if (skip) await wd.click(skip);
  const gone = await until(async () => !(await wd.find(".onboarding-backdrop")), 8000);
  // Preferences are saved after a 250ms debounce, not when the optimistic UI closes.
  await until(async () => (await ctx.app.api<{ prefs: { onboarding?: string } }>("GET", "/api/snapshot")).prefs.onboarding === "done", 8000);
  const prefs = (await ctx.app.api<{ prefs: { onboarding?: string } }>("GET", "/api/snapshot")).prefs;
  const after = await shot(ctx, "1-start-home.png");
  ctx.report.check(S, `온보딩 '${label}'(실제 클릭)으로 닫히고 기억됨`, label === "건너뛰기" && gone && prefs.onboarding === "done", `prefs.onboarding = ${prefs.onboarding ?? "없음"}`, after);
}
