// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact, Session, Work } from "@workbench/contracts";
import { initialState } from "../../state.ts";
import { WorkCard } from "./ProjectBits.tsx";

afterEach(cleanup);

const work = { id: "w", title: "3주차 강의", titleSource: "user", cwd: "/p", cwdManaged: false, activeSessionId: null, pinned: false, tags: [], folderId: null, archivedAt: null, sort: 0, createdAt: 1, updatedAt: 1 } as Work;
const session = (id: string, purpose: string, extra: Partial<Session> = {}) =>
  ({ id, workId: "w", provider: "codex", purpose, status: "idle", unread: false, previewAt: null, seenAt: null, createdAt: 1, updatedAt: 1, sort: 0, archivedAt: null, ...extra }) as Session;
const doc = (id: string, name: string) => ({ id, workId: "w", name, path: `/p/${name}`, format: "markdown", revision: 1, updatedAt: 1 }) as Artifact;

function card(sessions: Session[], docs: Artifact[]) {
  const open = { session: vi.fn(), doc: vi.fn(), project: vi.fn() };
  const { container } = render(
    <WorkCard state={{ ...initialState, works: { w: work } }} work={work} sessions={sessions} docs={docs} pending={new Map()} stages={[]} fields={["chips"]} open={open} />,
  );
  return { container: container.firstElementChild as HTMLElement, open };
}

it("shows a document that has an AI once, on its document chip, and calls conversations 대화", () => {
  const { container, open } = card(
    [session("chat", "슬라이드 정리"), session("ai", "강의안.md · 문서 AI", { documentAgent: { artifactId: "d1", parentSessionId: null } })],
    [doc("d1", "강의안.md"), doc("d2", "구성.md")],
  );
  expect(container.textContent!.match(/강의안\.md/g)).toHaveLength(1);
  expect(container.textContent).not.toContain("문서 AI ·");
  expect(container.textContent).not.toContain("채팅");
  expect(screen.getByText("대화 · 1")).toBeTruthy();
  const chip = screen.getByRole("button", { name: /강의안\.md/ });
  expect(within(chip).getByLabelText(/문서 AI/)).toBeTruthy();
  fireEvent.click(chip);
  expect(open.doc).toHaveBeenCalledWith("d1");
});

it("keeps an AI whose document is not on the card among the conversations", () => {
  const { container } = card([session("ai", "옛 문서.md · 문서 AI", { documentAgent: { artifactId: "gone", parentSessionId: null } })], []);
  expect(screen.getByText("대화 · 1")).toBeTruthy();
  expect(container.textContent).toContain("옛 문서.md · 문서 AI");
});
