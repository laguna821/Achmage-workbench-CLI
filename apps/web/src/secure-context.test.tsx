// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A page opened over plain http (not localhost) is not a secure context: browsers leave
// crypto.randomUUID undefined there, while crypto.getRandomValues stays.
function removeRandomUUID() { Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true }); }
beforeEach(() => {
  vi.resetModules();
  // What jsdom lacks and every real browser has.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  localStorage.clear(); sessionStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(() => { delete (crypto as { randomUUID?: unknown }).randomUUID; document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("starts the app in a browser without crypto.randomUUID and shows where to connect, not a blank page", async () => {
  removeRandomUUID();
  expect(typeof crypto.randomUUID).toBe("undefined");
  await import("./main.tsx");
  await vi.waitFor(() => expect(document.getElementById("root")!.textContent).toContain("기기 연결"), { timeout: 10_000 });
  // Identifiers the app makes at start are real version 4 UUIDs again.
  const { windowId } = await import("./document-session.ts");
  expect(windowId).toMatch(/^window-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Loads every module of the app: slow on a busy machine.
}, 30_000);

it("makes its identifiers from crypto.getRandomValues, never from a weaker source", async () => {
  removeRandomUUID();
  const strong = vi.spyOn(crypto, "getRandomValues"), weak = vi.spyOn(Math, "random");
  await import("./secure-context.ts");
  const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
  expect(new Set(ids).size).toBe(200);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(strong).toHaveBeenCalledTimes(200);
  expect(strong.mock.calls.every(([buffer]) => buffer instanceof Uint8Array && buffer.byteLength === 16)).toBe(true);
  expect(weak).not.toHaveBeenCalled();
});

it("leaves the browser's own crypto.randomUUID in place where it exists", async () => {
  const native = crypto.randomUUID;
  await import("./secure-context.ts");
  expect(crypto.randomUUID).toBe(native);
});
