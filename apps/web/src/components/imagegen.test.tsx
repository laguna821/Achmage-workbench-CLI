// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_IMAGE_TEMPLATES, type Artifact, type ImageInfo, type ImageItem, type Session, type TranscriptItem } from "@workbench/contracts";
import { initialState, type State } from "../state.ts";
import { showDoc, takeQueued } from "../imagegen.ts";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { DrawChip, ImageCard } from "./ImageGen.tsx";
import { toBlocks } from "./Transcript.tsx";

const session = (id: string, provider: Session["provider"], purpose: string) => ({ id, workId: "w", provider, purpose, status: "idle", archivedAt: null }) as unknown as Session;

const info = (patch: Partial<ImageInfo> = {}): ImageInfo => ({
  id: "d1",
  workId: "w",
  originSessionId: "claude-1",
  drawSessionId: "codex-1",
  status: "done",
  brief: "파란 원 하나",
  template: "인포그래픽",
  templateId: "infographic",
  aspect: "landscape",
  transparent: false,
  prompt: "Flat infographic…\n\n파란 원 하나",
  revisedPrompt: null,
  path: "/w/images/2026-10-28-파란-원-하나.png",
  relPath: "images/2026-10-28-파란-원-하나.png",
  width: 1536,
  height: 1024,
  bytes: 1000,
  insertInto: null,
  error: null,
  createdAt: 1,
  finishedAt: 2,
  ...patch,
});

const item = (patch: Partial<ImageInfo> = {}): ImageItem => ({ kind: "image", id: "image:d1", image: info(patch), at: 1 });

const doc = { id: "doc-1", workId: "w", path: "/w/notes/강의.md", name: "강의.md", format: "markdown", revision: 2 } as unknown as Artifact;

function renderCard(card: ImageItem, viewer = "claude-1") {
  const state: State = {
    ...initialState,
    sessions: { "claude-1": session("claude-1", "claude", "질문"), "codex-1": session("codex-1", "codex", "그림") },
    artifacts: { [doc.id]: doc },
  };
  const actions = { openArtifact: vi.fn(), openSession: vi.fn() } as unknown as DocActions;
  render(
    <DocContext.Provider value={{ state, actions }}>
      <ImageCard item={card} viewer={viewer} />
    </DocContext.Provider>,
  );
  return actions;
}

beforeEach(() => {
  // The gateway: templates as JSON, pictures as PNG bytes.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes("/api/image-templates")
      ? Response.json({ templates: BUILT_IN_IMAGE_TEMPLATES, rules: "" })
      : new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" })),
  ) as typeof fetch;
  URL.createObjectURL = vi.fn(() => "blob:picture");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("picture cards", () => {
  it("stay blocks of their own in the conversation", () => {
    const items: TranscriptItem[] = [{ kind: "user", id: "u", text: "q", at: 1 }, { kind: "tool", id: "t", tool: "command", title: "ls", detail: null, output: null, status: "completed", at: 2 }, item()];
    expect(toBlocks(items).map((block) => block.type)).toEqual(["user", "work", "image"]);
  });

  it("while drawing: who draws, and a way to stop", () => {
    renderCard(item({ status: "drawing", path: null, relPath: null, width: null, height: null }));
    expect(screen.getByText("그리는 중…")).toBeTruthy();
    expect(screen.getByText(/「그림」 Codex 세션이 그림/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "멈춤" })).toBeTruthy();
  });

  it("a failure says why and offers to draw again", () => {
    renderCard(item({ status: "failed", path: null, error: "이미지 생성 한도를 다 써서 그리지 못했습니다." }), "codex-1");
    expect(screen.getByText("그리지 못했습니다")).toBeTruthy();
    expect(screen.getByText(/한도를 다 써서/)).toBeTruthy();
    expect(screen.getByText(/「질문」 대화에서 요청한 그림/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /다시 그리기/ })).toBeTruthy();
  });

  it("'현재 문서에 넣기' waits for a Markdown document, then opens it with the link relative to it", async () => {
    renderCard(item());
    const button = screen.getByRole("button", { name: "현재 문서에 넣기" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("마크다운 문서를 한 번 열면");
    cleanup();
    // The document was on screen once (and is not any more).
    showDoc({ artifactId: doc.id, workId: "w", insertAtCursor: () => undefined })();
    const actions = renderCard(item());
    const enabled = screen.getByRole("button", { name: "현재 문서에 넣기" }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    expect(enabled.title).toContain("「강의.md」");
    fireEvent.click(enabled);
    expect(actions.openArtifact).toHaveBeenCalledWith(doc.id);
    expect(takeQueued(doc.id)).toEqual(["![파란 원 하나](../images/2026-10-28-파란-원-하나.png)"]);
    expect(await screen.findByRole("img", { name: "파란 원 하나" })).toBeTruthy();
  });
});

describe("the chip above the input", () => {
  it("in a Claude conversation says that a Codex session draws and the picture shows here", async () => {
    const state: State = { ...initialState, sessions: {} };
    render(<DrawChip state={state} provider="claude" value={{ on: true, choice: { templateId: "diagram", aspect: "portrait", transparent: true }, via: null }} onClear={() => undefined} />);
    expect(await screen.findByText(/그림 · 개념도 · 세로 · 투명 배경/)).toBeTruthy();
    expect(screen.getByText(/이 작업의 Codex 그림 세션이 그리고, 그림은 이 대화에 보입니다/)).toBeTruthy();
  });
});
