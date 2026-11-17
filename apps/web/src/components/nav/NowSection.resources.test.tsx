// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceState, Session, Work } from "@workbench/contracts";
import { initialState, type State } from "../../state.ts";
import { ResourcesContext } from "../ResourceManager.tsx";
import { LinkContext, type LinkApi } from "../../links.ts";
import { NowSection } from "./NavPane.tsx";
import type { NavShared } from "./shared.ts";

// 활동 › 현황 › 지금 (0.5.4): one line per running turn with how long it has run and what its engine holds, and each
// conversation waiting in the line with its place and why — in the list that was already there.

afterEach(cleanup);

const MB = 1024 ** 2;
const work = { id: "w1", title: "강의 준비", archivedAt: null, folderId: null } as unknown as Work;
const session = (id: string, purpose: string, extra: Partial<Session> = {}) =>
  ({ id, workId: "w1", provider: "claude", purpose, status: "idle", archivedAt: null, previewAt: null, seenAt: null, unread: false, queued: [], ...extra }) as unknown as Session;
const state: State = {
  ...initialState,
  works: { w1: work },
  sessions: {
    a: session("a", "3주차 슬라이드", { status: "running" }),
    b: session("b", "회의록", { status: "running" }),
    c: session("c", "자료 조사", { queued: [{ id: "rc", text: "찾아 줘", refs: [], create: null, at: 1, slot: true }] }),
  },
};
const resources = (now: number): ResourceState => ({
  settings: { mode: "auto", manual: 4, background: true, cap: null }, maxLimit: 32, limit: 2,
  running: [
    { sessionId: "a", title: "3주차 슬라이드", forced: false, kind: "conversation", since: now - 12 * 60_000, bytes: 380 * MB },
    { sessionId: "b", title: "회의록", forced: false, kind: "conversation", since: now - 5 * 60_000, bytes: null, relieved: true },
  ],
  waiting: [{ sessionId: "c", requestId: "rc", title: "자료 조사", position: 1, at: 1, kind: "conversation", phone: false }],
  reason: "지금 동시에 2개까지 돌리고 있습니다", pressure: false, sleepNow: 0, stage: 0, capSupport: "enforced", capChoices: [null],
  estimate: { comfortable: 2, totalBytes: 0, otherBytes: 0, costBytes: 0, learned: false, reading: "exact" },
});

const shared = { state, visibleSessionId: null, nav: { sections: {} }, homeOwnsNow: false, actions: { openSession: () => {} }, lookOf: () => "claude", rowMenu: () => {}, saveNav: () => {} } as unknown as NavShared;

const Links = ({ children }: { children: React.ReactNode }) => <LinkContext.Provider value={{ state: initialState } as unknown as LinkApi}>{children}</LinkContext.Provider>;

describe("활동 › 지금 with the resource manager", () => {
  it("a running turn: its time and memory; one giving memory back says its next request waits; a waiting one: its place and why", () => {
    render(<Links><ResourcesContext.Provider value={resources(Date.now())}><NowSection shared={shared} /></ResourcesContext.Provider></Links>);
    const detail = (label: string) => [...document.querySelectorAll<HTMLElement>(".now-row")].find((row) => row.querySelector(".side-row-label")?.textContent === label)?.querySelector(".now-detail")?.textContent;
    expect(detail("3주차 슬라이드")).toBe("12분째 · 380 MB");
    expect(detail("회의록")).toBe("5분째 · 메모리가 부족해 다음 요청은 기다립니다");
    // Its place at the row's end; the reason with the project in the row's title and name (the column is narrow).
    expect(detail("자료 조사")).toBe("1번째");
    const waitingRow = [...document.querySelectorAll<HTMLElement>(".now-row")].find((row) => row.querySelector(".side-row-label")?.textContent === "자료 조사")!;
    expect(waitingRow.getAttribute("aria-label")).toContain("강의 준비 · 지금 동시에 2개까지 돌리고 있습니다");
    expect([...document.querySelectorAll(".now-group-label")].map((label) => label.textContent)).toEqual(["진행 중 2", "대기 중 1"]);
  });
  it("without the resource manager's state (a remote window): the rows as before", () => {
    render(<Links><NowSection shared={shared} /></Links>);
    expect(document.querySelectorAll(".now-detail")).toHaveLength(0);
    expect([...document.querySelectorAll(".now-group-label")].map((label) => label.textContent)).toEqual(["진행 중 2"]);
  });
});
