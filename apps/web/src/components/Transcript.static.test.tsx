// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact, Attachment, TranscriptItem } from "@workbench/contracts";
import { Transcript } from "./Transcript.tsx";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { PkmContext, type PkmApi } from "./pkm/PkmContext.tsx";
import { initialState, type State } from "../state.ts";
import { forgetStaticMarkup, lightView, staticTurnStats, turnKey, TURN_RENDERER_VERSION } from "../conversation/static-turns.ts";

// The light conversation view (0.5.4): a finished turn is markup drawn by the same components; it wakes into
// components (React hydrates the same nodes) on a person's first event, and everything it could do still works.
const media = vi.hoisted(() => ({ release: vi.fn(), retain: vi.fn(), decode: vi.fn() }));
vi.mock("../api.ts", async (importOriginal) => ({ ...await importOriginal<typeof import("../api.ts")>(), attachmentHostId: () => "host", retainAttachmentUrl: media.retain }));
vi.mock("../../../../vendor/paseo/image-decoding/image-decoding.ts", () => ({ decodeMarkdownImage: media.decode }));

beforeEach(() => {
  localStorage.clear();
  forgetStaticMarkup();
  lightView.on = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  media.release.mockReset(); media.retain.mockReset(); media.decode.mockReset();
  media.retain.mockImplementation(() => ({ promise: Promise.resolve("blob:picture"), release: media.release }));
  media.decode.mockResolvedValue({ width: 320, height: 200 });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); lightView.on = true; });

const picture: Attachment = { id: "pic1", name: "화면.png", mime: "image/png", size: 2048 };
const pdf: Attachment = { id: "pdf1", name: "강의계획.pdf", mime: "application/pdf", size: 40960 };
const doc: Artifact = { id: "doc1", name: "보고서.md", path: "/p/보고서.md", format: "markdown", revision: 2, diskState: "same" } as Artifact;
const ANSWER = "## 정리\n\n**핵심**은 [안내](https://example.com/guide)에 있습니다.\n\n- 첫째 `코드`\n- 둘째\n\n| 주차 | 주제 |\n|---|---|\n| 1 | 소개 |\n\n```ts\nconst a = 1;\n```\n\n> 인용 문장\n\n1. 하나\n2. 둘\n\n~~지움~~ 그리고 *기울임*";

/** A corpus of finished turns: every kind a finished turn can hold (reused from the conversation tests' items, widened). */
const corpus = (): TranscriptItem[] => [
  { kind: "user", id: "u0", text: "첫 요청입니다.\n두 번째 줄", at: 1 },
  { kind: "reasoning", id: "r0", text: "생각을 정리합니다.", at: 2 },
  { kind: "tool", id: "t0", tool: "command", title: "ls -la", detail: null, output: "total 8\nfile", status: "completed", at: 3 },
  { kind: "tool", id: "t0b", tool: "fileChange", title: "강의안.md 수정", detail: "강의안.md\n+ 한 줄", output: null, status: "failed", at: 3 },
  { kind: "assistant", id: "a0", text: ANSWER, streaming: false, at: 4 },
  { kind: "turnEnd", id: "e0", status: "completed", durationMs: 42_000, at: 5 },
  { kind: "user", id: "u1", text: "문서를 보세요", at: 6, attachments: [pdf], refs: [{ artifactId: "doc1", name: "옛 이름.md", revision: 1, mode: "review", selection: null }], notes: [{ path: "노트/a.md", title: "노트 a" }], steered: true, from: { sessionId: "other", label: "다른 대화" } },
  { kind: "approval", id: "ap1", title: "명령 실행", detail: "rm -rf build", reason: "정리", decision: "accept", at: 7 },
  { kind: "notice", id: "n1", level: "info", text: "알림 한 줄", at: 8 },
  { kind: "artifact", id: "ar1", artifactId: "doc1", revision: 2, change: "modified", at: 9 },
  { kind: "assistant", id: "a1", text: "짧은 답", streaming: false, at: 10 },
  { kind: "turnEnd", id: "e1", status: "interrupted", durationMs: 3_000, at: 11 },
  { kind: "user", id: "u2", text: "그림 보기", at: 12, attachments: [picture], scheduled: true },
  { kind: "assistant", id: "a2", text: "끝났습니다.", streaming: false, at: 13 },
  { kind: "turnEnd", id: "e2", status: "completed", durationMs: null, at: 14 },
];

const docState = (artifacts: Record<string, Artifact> = { doc1: doc }): State => ({ ...initialState, artifacts } as State);
const pkmApi = (overrides: Partial<PkmApi> = {}) => ({ state: initialState, open: vi.fn(), client: { messagePage: vi.fn(() => Promise.resolve(doc)) }, onToast: vi.fn(), openArtifact: vi.fn(), api: {}, ...overrides }) as unknown as PkmApi;
function view(items: TranscriptItem[], options: { state?: State; actions?: Partial<DocActions>; pkm?: PkmApi | null; onFork?: (id: string) => void; running?: boolean; focusItem?: { itemId: string; nonce: number } | null; sessionId?: string } = {}) {
  const actions = { openArtifact: vi.fn(), openSession: vi.fn(), ...options.actions } as unknown as DocActions;
  const tree = (
    <DocContext.Provider value={{ state: options.state ?? docState(), actions }}>
      <PkmContext.Provider value={options.pkm === undefined ? pkmApi() : options.pkm}>
        <section className="pane">
          <Transcript sessionId={options.sessionId ?? "s1"} items={items} provider="claude" running={options.running ?? false} loading={false} onAnswer={() => {}} onFork={options.onFork} focusItem={options.focusItem ?? null} />
        </section>
      </PkmContext.Provider>
    </DocContext.Provider>
  );
  return { tree, actions };
}
const strip = (html: string) => html.replace(/<!--.*?-->/g, "");
const turnsOf = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("section.turn")];

it("the static drawing of a finished turn is the live drawing: same elements, text, attributes and labels, for every kind in the corpus", async () => {
  lightView.on = false;
  const live = render(view(corpus(), { onFork: () => {} }).tree);
  await act(async () => { await Promise.resolve(); });
  const expected = turnsOf(live.container).map((section) => strip(section.innerHTML));
  expect(turnsOf(live.container).some((section) => section.hasAttribute("data-static"))).toBe(false);
  cleanup();
  lightView.on = true;
  const light = render(view(corpus(), { onFork: () => {} }).tree);
  const sections = turnsOf(light.container);
  expect(sections.map((section) => section.hasAttribute("data-static"))).toEqual([true, true, true]);
  // The picture turn settles after mount (no IntersectionObserver here: it is woken at once, as Thumb itself loads at once without one).
  expect(sections.map((section) => section.hasAttribute("data-woken"))).toEqual([false, false, true]);
  await act(async () => { await Promise.resolve(); });
  expect(sections.slice(0, 2).map((section) => strip(section.innerHTML))).toEqual(expected.slice(0, 2));
  await waitFor(() => expect(strip(sections[2]!.innerHTML)).toBe(expected[2]));
  expect(staticTurnStats.mismatches).toBe(0);
});

it("a finished turn holds no components until it is used; the turn being written and an open approval stay live", () => {
  const items: TranscriptItem[] = [...corpus().slice(0, 6),
    { kind: "user", id: "u9", text: "허락이 필요합니다", at: 20 }, { kind: "approval", id: "ap9", title: "명령 실행", detail: "make", reason: null, decision: null, at: 21 },
    { kind: "user", id: "u10", text: "지금 쓰는 중", at: 22 }, { kind: "assistant", id: "a10", text: "쓰는", streaming: true, at: 23 }];
  const screen = render(view(items, { running: true }).tree);
  expect(turnsOf(screen.container).map((section) => section.hasAttribute("data-static"))).toEqual([true, false, false]);
  expect(screen.getByRole("button", { name: /허용/ })).toBeTruthy();
});

it("the key: the same items find their markup again (a reopened conversation does not draw again); another content, a renamed document or another renderer version draws again", () => {
  const first = render(view(corpus().slice(0, 6)).tree);
  expect(staticTurnStats.drawn).toBe(1);
  first.unmount();
  // Shown again (a slept tab, a reload of the transcript: new objects, the same content).
  render(view(structuredClone(corpus().slice(0, 6))).tree);
  expect(staticTurnStats.drawn).toBe(1);
  expect(staticTurnStats.reused).toBeGreaterThanOrEqual(1);
  cleanup();
  const changed = corpus().slice(0, 6).map((item) => item.id === "a0" ? { ...item, text: "다른 답" } as TranscriptItem : item);
  render(view(changed).tree);
  expect(staticTurnStats.drawn).toBe(2);
  const items = corpus().slice(0, 2);
  expect(turnKey(items, [])).toMatch(new RegExp(`^v${TURN_RENDERER_VERSION}\\|`));
  expect(turnKey(items, ["a"])).not.toBe(turnKey(items, ["b"]));
});

it("a document chip and a file card show the live name after a rename (the key holds the name)", () => {
  const items = corpus().slice(6, 12);
  const screen = render(view(items).tree);
  expect(screen.container.querySelector(".ref-chip")!.textContent).toContain("보고서.md");
  screen.rerender(view(items, { state: docState({ doc1: { ...doc, name: "새 이름.md" } }) }).tree);
  expect(screen.container.querySelector(".ref-chip")!.textContent).toContain("새 이름.md");
  expect(screen.container.querySelector(".doc-card-name")!.textContent).toBe("새 이름.md");
  expect(turnsOf(screen.container)[0]!.hasAttribute("data-static")).toBe(true);
});

it("a model's text cannot put markup or handlers into the static drawing", () => {
  const evil = "<img src=x onerror=alert(1)><script>alert(2)</script><a href=\"javascript:alert(3)\">a</a> [링크](javascript:alert(4)) ![그림](javascript:alert(5)) <iframe src=\"https://x\"></iframe> <svg onload=alert(6)>";
  const items: TranscriptItem[] = [{ kind: "user", id: "u0", text: evil, at: 1 }, { kind: "tool", id: "t0", tool: "command", title: evil, detail: null, output: evil, status: "completed", at: 2 }, { kind: "assistant", id: "a0", text: evil, streaming: false, at: 3 }, { kind: "turnEnd", id: "e0", status: "completed", durationMs: 1, at: 4 }];
  const screen = render(view(items).tree);
  const section = turnsOf(screen.container)[0]!;
  expect(section.hasAttribute("data-static")).toBe(true);
  expect(section.querySelector("script, iframe, img[onerror], svg[onload]")).toBeNull();
  for (const element of section.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      expect(name.startsWith("on")).toBe(false);
      if (name === "href" || name === "src") expect(element.getAttribute(name)!.trim().toLowerCase().startsWith("javascript:")).toBe(false);
    }
  }
  expect(section.textContent).toContain("<script>alert(2)</script>");
});

it("themes restyle a static turn by CSS alone: its markup carries classes, no inline colours", () => {
  const screen = render(view(corpus().slice(0, 12)).tree);
  for (const element of screen.container.querySelectorAll("section.turn[data-static] [style]")) expect(element.getAttribute("style")).toMatch(/^--fold-lines:\d+;?$/);
});

it("a folded tool line opens, and its output too, on a static turn (woken by the click; the same nodes)", () => {
  const screen = render(view(corpus().slice(0, 6)).tree);
  const section = turnsOf(screen.container)[0]!;
  const head = section.querySelector<HTMLButtonElement>(".work-summary")!;
  expect(head.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(head);
  expect(section.hasAttribute("data-woken")).toBe(true);
  expect(section.querySelector(".work-summary")).toBe(head);
  expect(head.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(section.querySelector<HTMLButtonElement>("[data-item-id='t0'] .tool-row-head")!);
  expect(section.querySelector("[data-item-id='t0'] .tool-output")!.textContent).toContain("total 8");
  expect(staticTurnStats.mismatches).toBe(0);
});

it("a failed step's line under the folded work opens it (static turn)", () => {
  const screen = render(view(corpus().slice(0, 6)).tree);
  fireEvent.click(screen.getByRole("button", { name: /실패: 강의안.md 수정/ }));
  expect(screen.container.querySelector("[data-item-id='t0b']")).toBeTruthy();
});

it("이 요청 전으로 (edit and resend in a new branch) works on a static turn", () => {
  const fork = vi.fn();
  const screen = render(view(corpus().slice(0, 6), { onFork: fork }).tree);
  fireEvent.click(screen.getByRole("button", { name: "이 요청 전으로" }));
  expect(fork).toHaveBeenCalledWith("u0");
});

it("페이지로 만들기 / 결정으로 on a static answer reach the app (the latest app state, through the turn's own root)", async () => {
  const pkm = pkmApi();
  const screen = render(view(corpus().slice(0, 6), { pkm }).tree);
  fireEvent.mouseDown(screen.getAllByRole("button", { name: /페이지로 만들기/ })[0]!);
  fireEvent.click(screen.getAllByRole("button", { name: /페이지로 만들기/ })[0]!);
  await waitFor(() => expect(pkm.client.messagePage).toHaveBeenCalledWith("s1", "a0", null));
});

it("a selection inside a static answer survives waking it (페이지로 만들기 takes the selected part)", async () => {
  const pkm = pkmApi();
  const screen = render(view(corpus().slice(0, 6), { pkm }).tree);
  const quote = turnsOf(screen.container)[0]!.querySelector(".turn-answer blockquote p")!;
  const text = quote.firstChild!;
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 2);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  const button = screen.getAllByRole("button", { name: /페이지로 만들기/ })[0]!;
  fireEvent.mouseDown(button);
  fireEvent.click(button);
  expect(text.isConnected).toBe(true);
  await waitFor(() => expect(pkm.client.messagePage).toHaveBeenCalledWith("s1", "a0", "인용"));
});

it("a document chip and a file card open their document; the from-badge opens the other conversation; a note chip opens the note", () => {
  const pkm = pkmApi();
  const { tree, actions } = view(corpus().slice(6, 12), { pkm });
  const screen = render(tree);
  fireEvent.click(screen.container.querySelector<HTMLButtonElement>(".ref-chip")!);
  expect(actions.openArtifact).toHaveBeenCalledWith("doc1");
  fireEvent.click(screen.container.querySelector<HTMLButtonElement>(".doc-card")!);
  expect(actions.openArtifact).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: /다른 대화에서 온 요청/ }));
  expect(actions.openSession).toHaveBeenCalledWith("other");
  fireEvent.click(screen.container.querySelector<HTMLButtonElement>(".note-chip-open")!);
  expect(pkm.open).toHaveBeenCalledWith({ kind: "note", path: "노트/a.md" });
});

it("an attachment chip opens its 받기 / 공유 card on a static turn", () => {
  const screen = render(view(corpus().slice(6, 12)).tree);
  const chip = screen.getByRole("button", { name: /강의계획.pdf 받기 또는 공유/ });
  fireEvent.click(chip);
  expect(chip.getAttribute("aria-expanded")).toBe("true");
});

it("a picture opens in the viewer (the turn settles: it wakes near the view and loads its thumbnail)", async () => {
  const screen = render(view(corpus().slice(12)).tree);
  const thumb = await screen.findByRole("button", { name: "화면.png 크게 보기" });
  await waitFor(() => expect(thumb.hasAttribute("disabled")).toBe(false));
  fireEvent.click(thumb);
  expect(screen.getByRole("dialog", { name: "화면.png" })).toBeTruthy();
});

it("a long request folds with 더 보기, and opens, on a finished turn", () => {
  const long = Array.from({ length: 12 }, (_, index) => `${index + 1}번째 줄입니다.`).join("\n");
  const screen = render(view([{ kind: "user", id: "u0", text: long, at: 1 }, { kind: "assistant", id: "a0", text: "답", streaming: false, at: 2 }, { kind: "turnEnd", id: "e0", status: "completed", durationMs: 1, at: 3 }]).tree);
  const more = screen.getByRole("button", { name: "더 보기" });
  fireEvent.click(more);
  expect(screen.getByRole("button", { name: "접기" })).toBeTruthy();
});

it("a link keeps its address and the same markup (the window's own link rules apply as before)", () => {
  const screen = render(view(corpus().slice(0, 6)).tree);
  const link = screen.getByRole("link", { name: "안내" });
  expect(link.getAttribute("href")).toBe("https://example.com/guide");
  expect(turnsOf(screen.container)[0]!.hasAttribute("data-woken")).toBe(false);
});

it("a search hit (or 활동 › 기록) on a step of a static turn opens that step, scrolls to it and marks it", () => {
  const done = vi.fn();
  const { tree } = view(corpus().slice(0, 6));
  const screen = render(tree);
  const again = (focusItem: { itemId: string; nonce: number }) => <DocContext.Provider value={{ state: docState(), actions: { openArtifact: vi.fn(), openSession: vi.fn() } as unknown as DocActions }}><PkmContext.Provider value={pkmApi()}><section className="pane"><Transcript sessionId="s1" items={corpus().slice(0, 6)} provider="claude" running={false} loading={false} onAnswer={() => {}} focusItem={focusItem} onFocusDone={done} /></section></PkmContext.Provider></DocContext.Provider>;
  screen.rerender(again({ itemId: "t0", nonce: 1 }));
  const step = screen.container.querySelector<HTMLElement>("[data-item-id='t0']")!;
  expect(step.querySelector(".tool-output")).toBeTruthy();
  expect(step.classList.contains("flash")).toBe(true);
  expect(done).toHaveBeenCalled();
});

it("keyboard: Tab into a static turn wakes it with the focus where it was; Enter acts", () => {
  const fork = vi.fn();
  const screen = render(view(corpus().slice(0, 6), { onFork: fork }).tree);
  const button = screen.getByRole("button", { name: "이 요청 전으로" });
  act(() => button.focus());
  expect(turnsOf(screen.container)[0]!.hasAttribute("data-woken")).toBe(true);
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(fork).toHaveBeenCalledTimes(1);
});

it("a finished answer of this view goes on as components (its open state stays) — it is not swapped while on screen", () => {
  const writing: TranscriptItem[] = [...corpus().slice(0, 5).map((item) => item.id === "a0" ? { ...item, streaming: true } as TranscriptItem : item)];
  const screen = render(view(writing, { running: true }).tree);
  fireEvent.click(screen.container.querySelector<HTMLButtonElement>(".work-summary")!);
  screen.rerender(view(corpus().slice(0, 6), { running: false }).tree);
  const section = turnsOf(screen.container)[0]!;
  expect(section.hasAttribute("data-static")).toBe(false);
  expect(section.querySelector(".work-summary")!.getAttribute("aria-expanded")).toBe("true");
});

it("scrolling up within a screen of the top draws the earlier turns (as markup), the reader staying on what they read", () => {
  const many: TranscriptItem[] = Array.from({ length: 60 }, (_, index) => [
    { kind: "user", id: `u${index}`, text: `요청 ${index}`, at: index * 3 },
    { kind: "assistant", id: `a${index}`, text: `답 ${index}`, streaming: false, at: index * 3 + 1 },
    { kind: "turnEnd", id: `e${index}`, status: "completed", durationMs: 1, at: index * 3 + 2 },
  ] as TranscriptItem[]).flat();
  const screen = render(view(many).tree);
  expect(turnsOf(screen.container)).toHaveLength(40);
  const scroller = screen.container.querySelector<HTMLElement>(".transcript")!;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 9000 });
  act(() => { scroller.scrollTop = 2000; fireEvent.scroll(scroller); });
  expect(turnsOf(screen.container)).toHaveLength(40);
  act(() => { scroller.scrollTop = 300; fireEvent.scroll(scroller); });
  expect(turnsOf(screen.container)).toHaveLength(60);
  expect(turnsOf(screen.container).every((section) => section.hasAttribute("data-static"))).toBe(true);
});

it("while the engine works (WorkView passes no 이 요청 전으로), finished turns are not drawn again; the key is hidden, then back", () => {
  const fork = vi.fn();
  const screen = render(view(corpus().slice(0, 6), { onFork: fork }).tree);
  const drawn = staticTurnStats.drawn;
  screen.rerender(view(corpus().slice(0, 6), { onFork: undefined }).tree);
  expect(staticTurnStats.drawn).toBe(drawn);
  expect(screen.container.querySelector(".transcript-wrap")!.hasAttribute("data-forks-off")).toBe(true);
  screen.rerender(view(corpus().slice(0, 6), { onFork: fork }).tree);
  expect(staticTurnStats.drawn).toBe(drawn);
  expect(screen.container.querySelector(".transcript-wrap")!.hasAttribute("data-forks-off")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "이 요청 전으로" }));
  expect(fork).toHaveBeenCalledWith("u0");
});

it("a window of turns enters the page as one group (one insertion); a page of earlier turns is a group of its own; new turns join without redrawing", () => {
  const many = (count: number): TranscriptItem[] => Array.from({ length: count }, (_, index) => [
    { kind: "user", id: `u${index}`, text: `요청 ${index}`, at: index * 3 },
    { kind: "assistant", id: `a${index}`, text: `답 ${index}`, streaming: false, at: index * 3 + 1 },
    { kind: "turnEnd", id: `e${index}`, status: "completed", durationMs: 1, at: index * 3 + 2 },
  ] as TranscriptItem[]).flat();
  const screen = render(view(many(60), { sessionId: "groups" }).tree);
  const groups = () => [...screen.container.querySelectorAll(".transcript-inner > .turn-group")].map((group) => group.querySelectorAll(":scope > section.turn").length);
  expect(groups()).toEqual([40]);
  const first = screen.container.querySelector("section.turn")!;
  fireEvent.click(screen.getByRole("button", { name: /이전 대화 보기/ }));
  expect(groups()).toEqual([20, 40]);
  expect(screen.container.querySelectorAll("section.turn")[20]).toBe(first);
  screen.rerender(view(many(61), { sessionId: "groups" }).tree);
  expect(groups()).toEqual([20, 40, 1]);
  expect(screen.container.querySelectorAll("section.turn")[20]).toBe(first);
});

it("결정으로 on a static answer writes the answer's first paragraph to the project note", async () => {
  const addProjectEntry = vi.fn(() => Promise.resolve({ token: null }));
  const pkm = pkmApi({ state: { ...initialState, sessions: { s1: { id: "s1", workId: "w1" } }, transcripts: { s1: { items: corpus() } } } as unknown as State, api: { addProjectEntry } as unknown as PkmApi["api"] });
  const screen = render(view(corpus().slice(0, 6), { pkm }).tree);
  fireEvent.click(screen.getAllByRole("button", { name: /결정으로/ })[0]!);
  await waitFor(() => expect(addProjectEntry).toHaveBeenCalledWith("w1", expect.objectContaining({ section: "decision", itemId: "a0" })));
});

it("a selection across two static turns stays while one of them wakes", () => {
  const screen = render(view(corpus().slice(0, 12), { onFork: () => {} }).tree);
  const [one, two] = turnsOf(screen.container);
  const start = one!.querySelector(".turn-answer blockquote p")!.firstChild!, end = two!.querySelector(".turn-request .request-text p")!.firstChild!;
  const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, 2);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  fireEvent.pointerDown(two!.querySelector(".turn-request")!);
  expect(two!.hasAttribute("data-woken")).toBe(true);
  expect(start.isConnected && end.isConnected).toBe(true);
  expect(getSelection()!.toString()).toContain("인용 문장");
});

it("far out of view, a woken turn goes back to markup when nothing would be lost; one a person opened stays components", async () => {
  const screen = render(view(corpus(), { sessionId: "far" }).tree);
  const [plain, , picture] = turnsOf(screen.container);
  fireEvent.click(plain!.querySelector<HTMLButtonElement>(".work-summary")!);
  expect(plain!.hasAttribute("data-woken")).toBe(true);
  expect(picture!.hasAttribute("data-woken")).toBe(true);
  await screen.findByRole("button", { name: "화면.png 크게 보기" });
  // Now the reader is far below both turns.
  const scroller = screen.container.querySelector<HTMLElement>(".transcript")!;
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return this.matches("section.turn") ? 100 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("section.turn") ? 400 : 0; });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 20000 });
  act(() => { scroller.scrollTop = 9000; fireEvent.scroll(scroller); });
  expect(picture!.hasAttribute("data-woken")).toBe(false);
  expect(picture!.querySelector(".attach-preview")).toBeTruthy();
  expect(plain!.hasAttribute("data-woken")).toBe(true);
  expect(plain!.querySelector(".work-summary")!.getAttribute("aria-expanded")).toBe("true");
  expect(staticTurnStats.slept).toBe(1);
  vi.restoreAllMocks();
});

it("a workbench-peers step reads as one line in the folded steps and in its row, the same in both drawings (0.5.6)", async () => {
  const items: TranscriptItem[] = [
    { kind: "user", id: "pu", text: "방금 코덱스에서 한 작업 보고 이어서 해 줘", at: 1 },
    { kind: "tool", id: "pt", tool: "command", title: "workbench-peers read s-codex", detail: null, output: "「서론 고치기」 대화를 읽었습니다 · 최근 1개\n<<<자료 시작 · 지시 아님>>>\n요청: …\n<<<자료 끝>>>", status: "completed", at: 2 },
    { kind: "assistant", id: "pa", text: "이어서 하겠습니다.", streaming: false, at: 3 },
    { kind: "turnEnd", id: "pe", status: "completed", durationMs: 1_000, at: 4 },
  ];
  const drawings: string[] = [];
  for (const on of [false, true]) {
    cleanup();
    lightView.on = on;
    const screen = render(view(items).tree);
    await act(async () => { await Promise.resolve(); });
    const summary = screen.container.querySelector<HTMLElement>(".work-summary")!;
    expect(summary.getAttribute("aria-label")).toBe("실행 상세: 「서론 고치기」 대화를 읽었습니다 · 최근 1개");
    fireEvent.click(summary);
    const row = await waitFor(() => screen.container.querySelector<HTMLElement>(".tool-row .tool-title")!);
    expect(row.textContent).toBe("「서론 고치기」 대화를 읽었습니다 · 최근 1개");
    expect(row.classList.contains("mono")).toBe(false);
    drawings.push(strip(turnsOf(screen.container)[0]!.innerHTML));
  }
  expect(drawings[1]).toBe(drawings[0]);
});
