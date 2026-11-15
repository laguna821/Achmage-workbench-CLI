// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { initialState } from "../../state.ts";
import type { Api } from "../../api.ts";
import { DocContext, type DocActions } from "../DocCards.tsx";
import { Transcript } from "../Transcript.tsx";
import { RawNote } from "./RawNote.tsx";

// Every Markdown parse, by the text it was given.
const parsed = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-markdown")>();
  const Counted = (props: { children?: string }) => {
    parsed.push(String(props.children));
    return real.default(props as Parameters<typeof real.default>[0]);
  };
  return { ...real, default: Counted };
});

// Every render of a request's picture strip: it is drawn by the request block itself.
const strips = vi.hoisted(() => [] as string[]);
vi.mock("../Attachments.tsx", async (importOriginal) => {
  const real = await importOriginal<typeof import("../Attachments.tsx")>();
  const Counted = (props: Parameters<typeof real.AttachmentStrip>[0]) => {
    strips.push(props.attachments.map((entry) => entry.id).join(","));
    return real.AttachmentStrip(props);
  };
  return { ...real, AttachmentStrip: Counted };
});

beforeEach(() => {
  parsed.length = 0;
  strips.length = 0;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const docs = { state: initialState, actions: { openArtifact: vi.fn(), openSession: vi.fn() } as unknown as DocActions };

it("does not render or parse an earlier request with attachments again while a later answer streams", () => {
  const request: TranscriptItem = { kind: "user", id: "u1", text: "판서를 보고 정리해 줘", at: 1,
    attachments: [{ id: "p1", name: "판서.png", mime: "image/png", size: 10 }], refs: [{ artifactId: "a1", name: "강의안.md", revision: 1, mode: "review", selection: null }] } as TranscriptItem;
  const later: TranscriptItem = { kind: "user", id: "u2", text: "이어서", at: 3 };
  const streamed = (text: string): TranscriptItem[] => [request, { kind: "assistant", id: "a1", text: "앞 답", streaming: false, at: 2 }, later, { kind: "assistant", id: "a2", text, streaming: true, at: 4 }];
  const view = (text: string) => <DocContext.Provider value={docs}><Transcript sessionId="s" items={streamed(text)} provider="claude" running loading={false} onAnswer={() => {}} onFork={() => {}} /></DocContext.Provider>;
  const ui = render(view("한"));
  for (const text of ["한 글", "한 글자", "한 글자씩", "한 글자씩 옵니다"]) ui.rerender(view(text));
  expect(parsed.filter((text) => text === "판서를 보고 정리해 줘")).toHaveLength(1);
  expect(parsed.filter((text) => text === "앞 답")).toHaveLength(1);
  // The finished request block itself does not render again (not only its memoised words).
  expect(strips.filter((ids) => ids === "p1")).toHaveLength(1);
});

it("keeps the band quiet while the head is in view, and carries the head's essentials once it is not", () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 300 : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("transcript") ? 2000 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("note-head") ? 90 : this.classList.contains("turn") ? 1800 : this.classList.contains("turn-request") ? 50 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("turn") || this.classList.contains("turn-request") ? 100 : 0; });
  const band = { title: "슬라이드 정리", tail: <button type="button" aria-label="노트 메뉴">⋯</button> };
  const items: TranscriptItem[] = [{ kind: "user", id: "u1", text: "요청", at: 1 }, { kind: "assistant", id: "a1", text: "긴 답", streaming: false, at: 2 }];
  const ui = render(<DocContext.Provider value={docs}><Transcript sessionId="band" items={items} provider="codex" running={false} loading={false} onAnswer={() => {}}
    head={<header className="note-head"><button type="button" aria-label="노트 메뉴">⋯</button></header>} band={band} position={{ top: 0, follow: false }} /></DocContext.Provider>);
  const scroller = ui.container.querySelector<HTMLElement>(".transcript")!;
  expect(ui.container.querySelector(".turn-pin")).toBeNull();
  expect(screen.getAllByRole("button", { name: "노트 메뉴" })).toHaveLength(1);
  scroller.scrollTop = 600; fireEvent.scroll(scroller);
  const pin = ui.container.querySelector<HTMLElement>(".turn-pin")!;
  expect(pin).toBeTruthy();
  expect(within(pin).getByRole("button", { name: "노트 메뉴" })).toBeTruthy();
  expect(within(pin).getByText("요청")).toBeTruthy();
});

it("says in the raw note that a running turn is still arriving, and fetches again as items complete", async () => {
  const exportMarkdown = vi.fn(async () => ({ markdown: "# 슬라이드 정리" }));
  const api = { exportMarkdown } as unknown as Api;
  const ui = render(<RawNote api={api} sessionId="s" pulse="3:2:true" running />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toContain("답을 받는 중");
  ui.rerender(<RawNote api={api} sessionId="s" pulse="3:3:false" running={false} />);
  await act(async () => {});
  expect(exportMarkdown).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/답을 받는 중/)).toBeNull();
});
