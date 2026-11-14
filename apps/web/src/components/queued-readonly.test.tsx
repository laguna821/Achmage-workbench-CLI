// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "@workbench/contracts";
import { QueuedList } from "./WorkView.tsx";

afterEach(cleanup);

const session = (extra: Partial<Session> = {}) => ({ id: "ai", queued: [{ id: "q1", text: "다음에 할 일", refs: [], create: null, at: 1, held: true }], archivedAt: null, ...extra }) as unknown as Session;
const actions = { send: vi.fn(), cancel: vi.fn(), edit: vi.fn() } as never;

describe("waiting requests of a read-only conversation", () => {
  it("stay visible without 지금 보내기 (nor any other action)", () => {
    render(<QueuedList session={session({ archivedAt: 5 })} busy={false} actions={actions} readOnly />);
    expect(screen.getByText("다음에 할 일")).toBeTruthy();
    expect(screen.getByRole("list").textContent).toContain("대화를 되돌리면 보낼 수 있습니다");
    expect(screen.queryByRole("button", { name: /지금 보내기/ })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keep their actions in a live conversation", () => {
    render(<QueuedList session={session()} busy={false} actions={actions} />);
    expect(screen.getByRole("button", { name: /지금 보내기/ })).toBeTruthy();
  });
});
