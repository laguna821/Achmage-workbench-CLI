// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocOpenRow } from "./components/Connections.tsx";
import { firstView, isTyping, readDocOpen } from "./doc-open.ts";
import { isNewDocument, markNewDocument } from "./doc-new.ts";

// 설정 › 문서 도구 › 문서를 열 때 (doc-pages-first, point 3).

afterEach(() => { cleanup(); localStorage.clear(); });

it("the default is 쪽 보기 first (doc-default); the row lists it first, marks it 기본, and switches to the editor and back", () => {
  expect(readDocOpen()).toBe("pages");
  render(<DocOpenRow />);
  const radios = screen.getAllByRole("radio").map((radio) => radio.textContent);
  expect(radios).toEqual(["쪽 보기로 먼저 열기 (기본)", "편집기로 바로 열기"]);
  expect(screen.getByRole("radio", { name: "쪽 보기로 먼저 열기 (기본)" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/새 문서, 엑셀, 쪽 그림이 아직 없는 문서는 편집기로 엽니다/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "편집기로 바로 열기" }));
  expect(readDocOpen()).toBe("editor");
  // The editor is a choice now: stored explicitly.
  expect(localStorage.getItem("workbench.docOpen")).toBe("editor");
  fireEvent.click(screen.getByRole("radio", { name: "쪽 보기로 먼저 열기 (기본)" }));
  expect(readDocOpen()).toBe("pages");
});

it("a stored choice stays: wave 32's \"pages\" and an explicit \"editor\"; storage refused → 쪽 보기 first", () => {
  localStorage.setItem("workbench.docOpen", "pages");
  expect(readDocOpen()).toBe("pages");
  localStorage.setItem("workbench.docOpen", "editor");
  expect(readDocOpen()).toBe("editor");
  const refused = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("refused"); });
  expect(readDocOpen()).toBe("pages");
  refused.mockRestore();
});

it("a phone-width window keeps the editor as its default (point f); its explicit choice holds", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(width < 40rem)", addEventListener() {}, removeEventListener() {} }));
  expect(readDocOpen()).toBe("editor");
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
  // A desktop window that only says its pointer is coarse (WebKitGTK without a mouse) keeps 쪽 보기 first.
  expect(readDocOpen()).toBe("pages");
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(width < 40rem)", addEventListener() {}, removeEventListener() {} }));
  expect(readDocOpen()).toBe("editor");
  localStorage.setItem("workbench.docOpen", "pages");
  expect(readDocOpen()).toBe("pages");
  vi.unstubAllGlobals();
});

const doc = (format: string, more: { revision?: number; id?: string } = {}) => ({ id: more.id ?? `d-${format}`, format, revision: more.revision ?? 3 }) as never;
const NOW = 100 * 60_000;

it("the first view: only when chosen, only for kinds with a page view, never beside a conversation, not over a view the person picked", () => {
  expect(firstView("editor", doc("docx"), undefined, false, NOW)).toBeNull();
  expect(firstView("pages", doc("docx"), undefined, false, NOW)).toBe("pages");
  expect(firstView("pages", doc("pptx"), undefined, false, NOW)).toBe("pages");
  // (c) formats without a page view are untouched.
  for (const format of ["xlsx", "markdown", "html", "text"]) expect(firstView("pages", doc(format), { mode: "edit" }, false, NOW)).toBeNull();
  expect(firstView("pages", doc("hwpx"), { mode: "edit" }, false, NOW)).toBe("pages");
  expect(firstView("pages", doc("pdf"), undefined, false, NOW)).toBe("preview");
  // (f) beside a conversation: untouched.
  expect(firstView("pages", doc("docx"), undefined, true, NOW)).toBeNull();
  // 글 보기 the person left the tab in stays.
  expect(firstView("pages", doc("docx"), { mode: "preview" }, false, NOW)).toBeNull();
});

it("(a) a new document — made by this window's create flow, still its first revision, under 10 minutes ago — opens in its editor", () => {
  markNewDocument("made", NOW - 60_000);
  expect(isNewDocument(doc("docx", { id: "made", revision: 1 }), NOW)).toBe(true);
  expect(firstView("pages", doc("docx", { id: "made", revision: 1 }), undefined, false, NOW)).toBeNull();
  expect(firstView("pages", doc("hwpx", { id: "made", revision: 1 }), undefined, false, NOW + 8 * 60_000)).toBeNull();
  // Saved again since, or older than that: an existing document to look at.
  expect(firstView("pages", doc("docx", { id: "made", revision: 2 }), undefined, false, NOW)).toBe("pages");
  expect(firstView("pages", doc("docx", { id: "made", revision: 1 }), undefined, false, NOW + 10 * 60_000)).toBe("pages");
  // A first revision nobody made here (a folder's existing file registered a moment ago): to look at.
  expect(firstView("pages", doc("docx", { id: "registered", revision: 1 }), undefined, false, NOW)).toBe("pages");
});

it("(e) a tab the person edited in before it slept wakes in its editor; one only looked at follows 쪽 보기 first", () => {
  expect(firstView("pages", doc("docx"), { mode: "edit", edited: true }, false, NOW)).toBeNull();
  expect(firstView("pages", doc("hwpx"), { mode: "edit", edited: true }, false, NOW)).toBeNull();
  expect(firstView("pages", doc("docx"), { mode: "edit", edited: false }, false, NOW)).toBe("pages");
  expect(firstView("pages", doc("docx"), { mode: "pages", edited: true }, false, NOW)).toBe("pages");
});

it("typing is a character without a modifier", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  expect(isTyping(key("가"))).toBe(true);
  expect(isTyping(key("a"))).toBe(true);
  expect(isTyping(key("ArrowDown"))).toBe(false);
  expect(isTyping(key("c", { ctrlKey: true }))).toBe(false);
  expect(isTyping(key("Tab"))).toBe(false);
});
