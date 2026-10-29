// A small W3C WebDriver client on fetch, enough to drive the desktop app through tauri-driver
// (WebKitWebDriver underneath): a session, elements, scripts, screenshots and input actions. Pointer
// actions are performed by WebKit's automation as input to the web view (trusted events with real
// hit testing and default actions), not as events dispatched from page JavaScript.

import { writeFileSync } from "node:fs";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export type ElementRef = Record<string, string>;
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export type PointerAction =
  | { type: "pointerMove"; x: number; y: number; duration?: number; origin?: "viewport" | "pointer" }
  | { type: "pointerDown"; button: number }
  | { type: "pointerUp"; button: number }
  | { type: "pause"; duration: number };

export type KeyAction = { type: "keyDown"; value: string } | { type: "keyUp"; value: string } | { type: "pause"; duration: number };

/** W3C key codes for the keys the scenarios press. */
export const KEY = { escape: "", enter: "", control: "", shift: "" } as const;

export class WebDriverError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.code = code;
    this.status = status;
  }
}

export const center = (rect: Rect): Point => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });

/** Pointer moves from `from` to `to` in `steps` even steps, `stepMs` each (a hand, not a jump). */
export function moveSteps(from: Point, to: Point, steps: number, stepMs = 20): PointerAction[] {
  return Array.from({ length: steps }, (_, index) => {
    const t = (index + 1) / steps;
    return { type: "pointerMove" as const, origin: "viewport" as const, duration: stepMs, x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) };
  });
}

export class WebDriver {
  readonly base: string;
  sessionId = "";

  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  async raw<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let value: unknown = null;
    try {
      value = (JSON.parse(text) as { value?: unknown }).value ?? null;
    } catch {
      // Not JSON: reported below with the status.
    }
    const failure = value && typeof value === "object" && "error" in value ? (value as { error: string; message?: string }) : null;
    if (!response.ok || failure) throw new WebDriverError(failure?.error ?? `http ${response.status}`, (failure?.message ?? text).slice(0, 400), response.status);
    return value as T;
  }

  private command<T>(method: string, path: string, body?: unknown, timeoutMs?: number) {
    if (!this.sessionId) throw new Error("no WebDriver session");
    return this.raw<T>(method, `/session/${this.sessionId}${path}`, body, timeoutMs);
  }

  /** New session; returns the capabilities the driver agreed to. */
  async start(capabilities: Record<string, unknown>, timeoutMs = 180_000) {
    const value = await this.raw<{ sessionId: string; capabilities: Record<string, unknown> }>("POST", "/session", { capabilities: { alwaysMatch: capabilities } }, timeoutMs);
    this.sessionId = value.sessionId;
    return value.capabilities;
  }

  /** End the session (the driver closes the app). */
  async quit() {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = "";
    await this.raw("DELETE", `/session/${id}`, undefined, 30_000);
  }

  status() {
    return this.raw<{ ready: boolean; message: string }>("GET", "/status", undefined, 3000);
  }

  title = () => this.command<string>("GET", "/title");
  url = () => this.command<string>("GET", "/url");
  refresh = () => this.command<null>("POST", "/refresh", {});
  windowHandles = () => this.command<string[]>("GET", "/window/handles");
  switchWindow = (handle: string) => this.command<null>("POST", "/window", { handle });
  closeWindow = () => this.command<string[]>("DELETE", "/window");
  windowRect = () => this.command<Rect>("GET", "/window/rect");
  setWindowRect = (rect: Partial<Rect>) => this.command<Rect>("POST", "/window/rect", rect);
  /** Select an iframe's browsing context (null returns to the top page). */
  frame = (element: ElementRef | null) => this.command<null>("POST", "/frame", { id: element });

  /** The first element matching `css` (inside `from`), or null. */
  async find(css: string, from?: ElementRef): Promise<ElementRef | null> {
    try {
      return await this.command<ElementRef>("POST", from ? `/element/${idOf(from)}/element` : "/element", { using: "css selector", value: css });
    } catch (error) {
      if (error instanceof WebDriverError && error.code === "no such element") return null;
      throw error;
    }
  }

  findAll(css: string, from?: ElementRef) {
    return this.command<ElementRef[]>("POST", from ? `/element/${idOf(from)}/elements` : "/elements", { using: "css selector", value: css });
  }

  /** Waits for `css` to match (polling), then returns it; throws with `what` after `timeoutMs`. */
  async waitFor(css: string, timeoutMs = 10_000, what = css): Promise<ElementRef> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const element = await this.find(css);
      if (element) return element;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  /** WebDriver element click: the driver scrolls it into view and clicks its centre with the mouse. */
  click = (element: ElementRef) => this.command<null>("POST", `/element/${idOf(element)}/click`, {});
  sendKeys = (element: ElementRef, text: string) => this.command<null>("POST", `/element/${idOf(element)}/value`, { text });
  text = (element: ElementRef) => this.command<string>("GET", `/element/${idOf(element)}/text`);
  attribute = (element: ElementRef, name: string) => this.command<string | null>("GET", `/element/${idOf(element)}/attribute/${encodeURIComponent(name)}`);
  rect = (element: ElementRef) => this.command<Rect>("GET", `/element/${idOf(element)}/rect`);
  displayed = (element: ElementRef) => this.command<boolean>("GET", `/element/${idOf(element)}/displayed`);

  /** Runs `script` (a function body; `arguments` holds `args`) in the page and returns its value. */
  execute<T>(script: string, ...args: unknown[]) {
    return this.command<T>("POST", "/execute/sync", { script, args });
  }

  /** A screenshot of the window's page (or of one element) as PNG at `path`. */
  async screenshot(path: string, element?: ElementRef) {
    const data = await this.command<string>("GET", element ? `/element/${idOf(element)}/screenshot` : "/screenshot");
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }

  /** W3C Perform Actions with one mouse. The pressed button stays pressed between calls until released. */
  pointer(actions: PointerAction[]) {
    return this.command<null>("POST", "/actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] }, 60_000);
  }

  keys(actions: KeyAction[]) {
    return this.command<null>("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions }] });
  }

  /** Press and release one key (W3C key code or a character). */
  press(key: string) {
    return this.keys([
      { type: "keyDown", value: key },
      { type: "keyUp", value: key },
    ]);
  }

  releaseActions = () => this.command<null>("DELETE", "/actions");
}

export const idOf = (element: ElementRef) => element[ELEMENT_KEY] ?? Object.values(element)[0]!;
export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
