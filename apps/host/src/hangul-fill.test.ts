import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { OfficeSkills } from "./office-skills.ts";
import { EditorGrants } from "./editors.ts";
import { defaultNamed, emptyUntouched } from "./hangul-document.ts";

// doc-default point 2 (0.5.2's leftover 4d): "한글 문서 만들기" into an EMPTY untouched open document.
// The real bundled hallym-kordoc runner makes the document; the open one is a real blank HWPX from 새 문서.

const REQUEST = { prompt: "공문서 하나 만들어줘", title: "시설 점검 안내", values: { purpose: "시설 점검 일정 안내" },
  sections: { "추진 배경": "정기 점검 시기입니다.", "현황과 문제": "노후 설비가 있습니다.", "제안 내용": "다음 주 점검을 진행합니다.", "추진 일정": "- 일시: 미정", "기대효과": "안전 확보" } };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wb-hangul-fill-")), store = new Store(join(dir, "state.sqlite"));
  const manager = new SessionManager(store, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir, skillHomeDir: join(dir, "home") });
  const work = manager.createWork({ title: "한글" }), session = manager.createSession(work.id, { provider: "claude" });
  const blank = await manager.createOfficeDocument(work.id, { format: "hwpx" });
  const grants = new EditorGrants();
  const view = manager.documents.registry.open(blank.id, { viewId: "view", windowId: "window", sessionId: session.id, claim: true });
  const token = grants.issue(blank.id, { viewId: "view", writeToken: view.writeToken }, session.id);
  const context = { artifactId: blank.id, token, grants };
  const service = new OfficeSkills(manager, store);
  return { dir, manager, work, session, blank, context, service,
    typed: (dirty: boolean) => manager.documents.registry.open(blank.id, { viewId: "view", windowId: "window", sessionId: session.id, dirty }),
    close: async () => { await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

it("the rule's parts: empty = every saved revision without text and nothing unsaved; HWPX only; the default name is 새 문서's, until renamed", async () => {
  const blank = (texts: string[], dirty = false, format = "hwpx") => emptyUntouched({ format, revisions: texts.map((_, i) => i + 1), dirty, text: async (r) => texts[r - 1]! });
  expect(await blank([""])).toBe(true);
  expect(await blank(["", " \n "])).toBe(true);
  expect(await blank(["", "가"])).toBe(false);
  expect(await blank(["가", ""])).toBe(false);
  expect(await blank([""], true)).toBe(false);
  expect(await blank([""], false, "hwp")).toBe(false);
  expect(await emptyUntouched({ format: "hwpx", revisions: [1], dirty: false, text: async () => { throw new Error("unreadable"); } })).toBe(false);
  expect(defaultNamed({ note: "새 한글 문서" }, {})).toBe(true);
  expect(defaultNamed({ note: "새 한글 문서" }, { renamed: { from: "a", to: "b" } })).toBe(false);
  expect(defaultNamed({ note: "작업 폴더에서 열기" }, {})).toBe(false);
});

it("empty and untouched: the made document becomes THIS document's next revision when the turn ends; the tab stays; the default name follows the title", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.blank.path), folder = dirname(f.blank.path);
    const made = await f.service.makeHangul(f.context, REQUEST) as { made: boolean; inPlace?: boolean; artifactId?: string };
    expect(made).toMatchObject({ made: true, inPlace: true, artifactId: f.blank.id });
    // Not under the running turn: nothing written yet, no file beside it.
    expect(readFileSync(f.blank.path).equals(before)).toBe(true);
    expect(readdirSync(folder).filter((name) => name.endsWith(".hwpx"))).toEqual([basename(f.blank.path)]);
    // The turn ends: the view asks for what it made.
    expect(await f.service.action(f.context, "open-made", {})).toEqual({ ok: true, tabId: f.blank.id });
    const after = f.manager.documents.get(f.blank.id);
    expect(after.revision).toBe(2);
    expect(after.name).toBe("시설 점검 안내.hwpx");
    expect(readFileSync(after.path).subarray(0, 2).toString()).toBe("PK");
    expect(readFileSync(after.path).equals(before)).toBe(false);
    expect(await f.manager.documents.view(f.blank.id, 2)).toContain("정기 점검");
    // One new revision; the blank before it stays restorable.
    expect(f.manager.documents.revisions(f.blank.id).map(({ revision, author }) => [revision, author])).toEqual([[1, "user"], [2, "engine"]]);
    expect(existsSync(f.blank.path)).toBe(false);
    expect(readdirSync(dirname(after.path)).filter((name) => name.endsWith(".hwpx"))).toEqual(["시설 점검 안내.hwpx"]);
  } finally { await f.close(); }
}, 90_000);

it("one character typed (unsaved) → a new HWPX in a new tab, the open document untouched", async () => {
  const f = await fixture();
  try {
    f.typed(true);
    const made = await f.service.makeHangul(f.context, REQUEST) as { made: boolean; inPlace?: boolean; artifactId?: string; name?: string };
    expect(made).toMatchObject({ made: true, inPlace: false, name: "시설 점검 안내.hwpx" });
    expect(made.artifactId).not.toBe(f.blank.id);
    expect(f.manager.documents.get(f.blank.id).revision).toBe(1);
    expect(await f.service.action(f.context, "open-made", {})).toEqual({ ok: true, tabId: made.artifactId });
  } finally { await f.close(); }
}, 90_000);

it("typed in after the document was made, before the turn ended → beside it after all, never over the typing", async () => {
  const f = await fixture();
  try {
    await f.service.makeHangul(f.context, REQUEST);
    f.typed(true);
    const opened = await f.service.action(f.context, "open-made", {}) as { ok: boolean; tabId: string };
    expect(opened.ok).toBe(true);
    expect(opened.tabId).not.toBe(f.blank.id);
    expect(f.manager.documents.get(f.blank.id).revision).toBe(1);
    expect(f.manager.documents.get(opened.tabId).name).toBe("시설 점검 안내.hwpx");
  } finally { await f.close(); }
}, 90_000);

it("a saved empty document the person renamed → filled in place, its name kept", async () => {
  const f = await fixture();
  try {
    f.manager.renameDocument(f.blank.id, "내 메모");
    const made = await f.service.makeHangul(f.context, REQUEST) as { inPlace?: boolean };
    expect(made.inPlace).toBe(true);
    await f.service.action(f.context, "open-made", {});
    const after = f.manager.documents.get(f.blank.id);
    expect(after.revision).toBe(2);
    expect(after.name).toBe("내 메모.hwpx");
  } finally { await f.close(); }
}, 90_000);

it("the reloaded view's open-made (an executor turn's end) finds THIS document's made one past another document's", async () => {
  const f = await fixture();
  try {
    // Another Hangul document of the same session made one first (its own tab, already opened).
    const other = await f.manager.createOfficeDocument(f.work.id, { format: "hwpx", name: "다른 문서" });
    const view = f.manager.documents.registry.open(other.id, { viewId: "other", windowId: "window", sessionId: f.session.id, claim: true });
    f.manager.documents.registry.open(other.id, { viewId: "other", windowId: "window", sessionId: f.session.id, dirty: true });
    const token = f.context.grants.issue(other.id, { viewId: "other", writeToken: view.writeToken }, f.session.id);
    const otherContext = { artifactId: other.id, token, grants: f.context.grants };
    const elsewhere = await f.service.makeHangul(otherContext, { ...REQUEST, title: "다른 결과" }) as { artifactId: string };
    expect(await f.service.action(otherContext, "open-made", { artifactId: elsewhere.artifactId })).toEqual({ ok: true, tabId: elsewhere.artifactId });
    await f.service.makeHangul(f.context, REQUEST);
    expect(await f.service.action(f.context, "open-made", {})).toEqual({ ok: true, tabId: f.blank.id });
    expect(f.manager.documents.get(f.blank.id).revision).toBe(2);
  } finally { await f.close(); }
}, 120_000);
