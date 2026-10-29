import { describe, expect, it } from "vitest";
import type { Folder, Session, Work } from "@workbench/contracts";
import { homeTarget, pickedWork, projectChoices } from "./entry.ts";
import { initialState, reducer, type State } from "./state.ts";

// ① 들어가는 길: what the home input's project chip offers, and where its request goes.

const NOW = new Date(2026, 9, 29, 10, 0, 0).getTime();
const work = (id: string, extra: Partial<Work> = {}): Work => ({
  id,
  title: id,
  titleSource: "user",
  folderId: null,
  cwd: `/w/${id}`,
  cwdManaged: false,
  activeSessionId: null,
  pinned: false,
  sort: 0,
  archivedAt: null,
  createdAt: 0,
  updatedAt: NOW - 3600_000,
  ...extra,
});
const session = (id: string, workId: string, extra: Partial<Session> = {}): Session => ({
  id,
  workId,
  provider: "claude",
  hostId: "h",
  nativeSessionId: null,
  purpose: id,
  purposeSource: "user",
  model: null,
  effort: null,
  engineModel: null,
  engineEffort: null,
  preview: "답",
  previewAt: NOW - 7200_000,
  status: "idle",
  activity: null,
  lastError: null,
  pinned: false,
  sort: 0,
  archivedAt: null,
  seenAt: NOW - 7000_000,
  unread: false,
  queued: [],
  access: null,
  context: null,
  createdAt: 0,
  updatedAt: NOW - 7200_000,
  ...extra,
});
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
const stateOf = (parts: { folders?: Folder[]; works?: Work[]; sessions?: Session[] }): State => ({
  ...initialState,
  ready: true,
  folders: byId(parts.folders ?? []),
  works: byId(parts.works ?? []),
  sessions: byId(parts.sessions ?? []),
});

describe("the home input's project chip", () => {
  const folders: Folder[] = [{ id: "f", parentId: null, name: "강의", sort: 0, archivedAt: null }, { id: "gone", parentId: null, name: "지난 학기", sort: 1, archivedAt: NOW }];
  const works = [
    work("가을 특강", { folderId: "f", updatedAt: NOW - 5000, cwd: "/home/u/강의/가을" }),
    work("보고서", { updatedAt: NOW - 1000 }),
    work("보관한 일", { archivedAt: NOW, updatedAt: NOW }),
    work("지난 수업", { folderId: "gone", updatedAt: NOW }),
    work("앱 폴더 일", { cwdManaged: true, cwd: "/data/works/x", updatedAt: NOW - 9000 }),
  ];
  const state = stateOf({ folders, works, sessions: [session("s", "앱 폴더 일", { previewAt: NOW - 10, updatedAt: NOW - 10 })] });

  it("offers live projects, most recently active first", () => {
    expect(projectChoices(state).map((entry) => entry.id)).toEqual(["앱 폴더 일", "보고서", "가을 특강"]);
  });

  it("finds a project by name, classification or folder", () => {
    expect(projectChoices(state, "특강").map((entry) => entry.id)).toEqual(["가을 특강"]);
    expect(projectChoices(state, "강의").map((entry) => entry.id)).toEqual(["가을 특강"]);
    expect(projectChoices(state, "/home/u").map((entry) => entry.id)).toEqual(["가을 특강"]);
    // An app-made folder is not something the user typed: it does not match.
    expect(projectChoices(state, "/data/works")).toEqual([]);
    expect(projectChoices(state, "지난")).toEqual([]);
  });

  it("defaults to the folder's live work, and a pick by hand wins", () => {
    const folderWork = state.works["가을 특강"]!;
    expect(pickedWork(state, { kind: "auto" }, folderWork)?.id).toBe("가을 특강");
    expect(pickedWork(state, { kind: "auto" }, null)).toBeNull();
    expect(pickedWork(state, { kind: "new" }, folderWork)).toBeNull();
    expect(pickedWork(state, { kind: "work", workId: "보고서" }, folderWork)?.id).toBe("보고서");
    // Archived meanwhile: a new project instead.
    expect(pickedWork(state, { kind: "work", workId: "보관한 일" }, null)).toBeNull();
  });

  it("asks the gateway at send time when the folder decides", async () => {
    const asked: string[] = [];
    const workAt = async (path: string) => {
      asked.push(path);
      return path === "/home/u/강의/가을" ? state.works["가을 특강"]! : null;
    };
    expect((await homeTarget(state, { kind: "auto" }, "/home/u/강의/가을", workAt))?.id).toBe("가을 특강");
    expect(await homeTarget(state, { kind: "auto" }, "/home/u/새 폴더", workAt)).toBeNull();
    expect(await homeTarget(state, { kind: "auto" }, null, workAt)).toBeNull();
    expect(await homeTarget(state, { kind: "new" }, "/home/u/강의/가을", workAt)).toBeNull();
    expect((await homeTarget(state, { kind: "work", workId: "보고서" }, null, workAt))?.id).toBe("보고서");
    expect(asked).toEqual(["/home/u/강의/가을", "/home/u/새 폴더"]);
  });
});

describe("a session shown at once", () => {
  it("shows the chosen session before the gateway confirms it", () => {
    const owner = work("w", { activeSessionId: "a" });
    const made = session("b", "w");
    const next = reducer(stateOf({ works: [owner], sessions: [session("a", "w")] }), { type: "focus", work: owner, session: made });
    expect(next.works.w!.activeSessionId).toBe("b");
    expect(next.sessions.b).toEqual(made);
    // A newer copy the events already brought stays.
    const newer = { ...made, status: "running" as const };
    const kept = reducer(stateOf({ works: [owner], sessions: [newer] }), { type: "focus", work: owner, session: made });
    expect(kept.sessions.b!.status).toBe("running");
  });
});
