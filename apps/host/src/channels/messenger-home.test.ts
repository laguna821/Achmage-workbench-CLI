import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../errors.ts";
import { cleanKits, pair, press, say, sessionOf, settle, startKit, type Kit } from "./test-kit.ts";

// A messenger's conversations live in the messenger's own place ("텔레그램 대화", "Slack 대화"), not
// inside a project of the person's (the owner, 2026-11-16: a phone conversation had been planted in
// the sample project). The channel makes that home the first time it needs it; a conversation it
// makes WITHOUT the person choosing a project goes there (the chat's first one, "새 대화"). A project
// chosen in the chat's menu is the person's own act: the chat stays there until they choose again.
// Here with the core alone; messenger-home-service.test.ts has both messengers and an old data folder.

afterEach(() => cleanKits());

const LINE = "새 대화는 이제 '텔레그램 대화'에 만듭니다. 프로젝트에서 하려면 메뉴의 [프로젝트 바꾸기]에서 고르세요.";
const pointer = (kit: Kit) => sessionOf(kit, kit.core.bindings()[0]!.pointerSessionId!);
const workOf = (kit: Kit, id: string) => kit.manager.snapshot().works.find((work) => work.id === id)!;
const homes = (kit: Kit) => kit.manager.snapshot().works.filter((work) => work.messengerHome);
const shownText = (kit: Kit, messageId: string) => kit.adapter.shown(messageId)!.text;
/** The last answer to "새 대화" (a finished answer of the conversation before may land after it). */
const made = (kit: Kit) => kit.adapter.texts().findLast((text) => text.startsWith("새 대화를 만들었습니다"))!;

async function menu(kit: Kit) {
  await settle(kit);
  const before = kit.adapter.sent.length;
  await say(kit, "메뉴");
  return kit.adapter.sent.slice(before)[0]!.messageId;
}

/** A project of the person's with a conversation made at the PC. */
function project(kit: Kit, title: string) {
  const work = kit.manager.createWork({ title, titleSource: "user" });
  const session = kit.manager.createSession(work.id, { provider: "claude", purpose: `${title} 대화`, access: "full" });
  return { work, session };
}
const sessionsIn = (kit: Kit, workId: string) => kit.manager.snapshot().sessions.filter((session) => session.workId === workId);

describe("the first conversation and 새 대화 go to the messenger's home", () => {
  it("makes the home on first use (not before), never picks the project used last, and 새 대화 stays at home", async () => {
    const kit = await startKit();
    const mine = project(kit, "샘플 프로젝트");
    await pair(kit);
    // Paired, nothing written yet: no home.
    expect(homes(kit)).toEqual([]);
    await say(kit, "첫 일");
    const first = pointer(kit);
    const home = workOf(kit, first.workId);
    expect(home).toMatchObject({ title: "텔레그램 대화", titleSource: "user", folderId: null, archivedAt: null, messengerHome: { kind: "telegram", registered: true } });
    expect(home.id).not.toBe(mine.work.id);
    expect(kit.core.bindings()[0]).toMatchObject({ pointerWorkId: home.id });
    kit.engine.finish(first.id);
    await say(kit, "새 대화");
    expect(pointer(kit).id).not.toBe(first.id);
    expect(pointer(kit).workId).toBe(home.id);
    expect(made(kit)).toMatch(/^새 대화를 만들었습니다: 「텔레그램 대화」 › 「휴대폰 · /);
    // The menu's key too; one home, and nothing was put in the person's project.
    const id = await menu(kit);
    await press(kit, "새 대화");
    expect(shownText(kit, id)).toMatch(/^새 대화를 만들었습니다: 「텔레그램 대화」 › /);
    expect(pointer(kit).workId).toBe(home.id);
    expect(homes(kit)).toHaveLength(1);
    expect(sessionsIn(kit, mine.work.id).map((session) => session.id)).toEqual([mine.session.id]);
    expect(kit.manager.snapshot().works.map((work) => work.title).sort()).toEqual(["샘플 프로젝트", "텔레그램 대화"]);
    // Nothing of the one-time line for a chat that was never anywhere else.
    expect(kit.adapter.texts().some((text) => text.includes("이제 '텔레그램 대화'에"))).toBe(false);
  });

  it("the messenger's default engine applies at home as everywhere", async () => {
    const kit = await startKit({ codex: true });
    await pair(kit);
    kit.core.setDefaultEngine("telegram", "7000000001", "codex");
    await say(kit, "첫 일");
    expect(pointer(kit).provider).toBe("codex");
    expect(workOf(kit, pointer(kit).workId).messengerHome?.kind).toBe("telegram");
  });
});

describe("a project chosen in the chat's menu is the person's own act", () => {
  it("the project screen offers the home first and says where the chat is; a chosen project keeps the chat, 새 대화 too, until the home is chosen again", async () => {
    const kit = await startKit();
    const mine = project(kit, "연구계획서");
    await pair(kit);
    await say(kit, "첫 일");
    const home = workOf(kit, pointer(kit).workId);
    kit.engine.finish(pointer(kit).id);
    const id = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    expect(shownText(kit, id)).toBe("어느 프로젝트로 갈까요?\n지금: 「텔레그램 대화」");
    expect(kit.adapter.labelsOf(id)).toEqual(["✓ 텔레그램 대화", "연구계획서", "새 프로젝트", "← 메뉴"]);
    await press(kit, "연구계획서");
    await press(kit, "이 프로젝트에 새 대화");
    expect(pointer(kit).workId).toBe(mine.work.id);
    // 새 대화 stays in the project the person chose.
    await say(kit, "새 대화");
    expect(pointer(kit).workId).toBe(mine.work.id);
    expect(made(kit)).toMatch(/^새 대화를 만들었습니다: 「연구계획서」 › /);
    expect(made(kit)).not.toContain("이제");
    // Back home by choosing it.
    const again = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    expect(shownText(kit, again)).toBe("어느 프로젝트로 갈까요?\n지금: 「연구계획서」");
    expect(kit.adapter.labelsOf(again).slice(0, 2)).toEqual(["텔레그램 대화", "✓ 연구계획서"]);
    await press(kit, "텔레그램 대화");
    expect(shownText(kit, again)).toBe("「텔레그램 대화」의 최근 대화");
    expect(kit.adapter.labelsOf(again)).toContain("여기에 새 대화");
    await press(kit, "여기에 새 대화");
    expect(pointer(kit).workId).toBe(home.id);
    await say(kit, "새 대화");
    expect(pointer(kit).workId).toBe(home.id);
    expect(homes(kit)).toHaveLength(1);
  });

  it("before the chat's first conversation the project screen marks the home (where a line will go) without making it", async () => {
    const kit = await startKit();
    project(kit, "연구계획서");
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    expect(shownText(kit, id)).toBe("어느 프로젝트로 갈까요?\n지금: 「텔레그램 대화」");
    expect(kit.adapter.labelsOf(id)).toEqual(["✓ 텔레그램 대화", "연구계획서", "새 프로젝트", "← 메뉴"]);
    expect(homes(kit)).toEqual([]);
  });

  it("a chat without a conversation is shown the person's last project (as before), never the other messenger's place", async () => {
    const kit = await startKit();
    project(kit, "연구계획서");
    // Slack's place exists and was used last.
    const other = kit.manager.ensureMessengerHome("slack");
    kit.manager.createSession(other.id, { provider: "claude", purpose: "휴대폰 · 11/15", access: "full" });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "대화 바꾸기");
    expect(shownText(kit, id)).toBe("「연구계획서」의 최근 대화");
    await press(kit, "다른 프로젝트…");
    expect(kit.adapter.labelsOf(id)).toEqual(["✓ 텔레그램 대화", "연구계획서", "새 프로젝트", "← 메뉴"]);
  });

  it("a conversation of another project picked in the menu keeps the chat there too", async () => {
    const kit = await startKit();
    const mine = project(kit, "연구계획서");
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(pointer(kit).id);
    const id = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    await press(kit, "연구계획서");
    await press(kit, kit.adapter.labelsOf(id).find((label) => label.startsWith("연구계획서 대화"))!);
    expect(pointer(kit).id).toBe(mine.session.id);
    await say(kit, "새 대화");
    expect(pointer(kit).workId).toBe(mine.work.id);
  });
});

describe("what is already planted stays; the next 새 대화 goes home once", () => {
  it("a chat whose conversation sits in a project from before: the conversation stays there, 새 대화 goes to the home once with one line, then never again", async () => {
    const kit = await startKit();
    const mine = project(kit, "샘플 프로젝트");
    const binding = await pair(kit);
    // As 0.5.0 left it: the chat points at a conversation planted in the person's project, with no marker.
    const planted = kit.manager.createSession(mine.work.id, { provider: "claude", purpose: "휴대폰 · 11/15", access: "full" }, false);
    kit.core.setPointer(binding.id, planted.id);
    // A line still goes to the conversation the chat is in: nothing is moved.
    await say(kit, "하던 일 계속");
    expect(kit.engine.sent.at(-1)!.sessionId).toBe(planted.id);
    kit.engine.finish(planted.id);
    expect(homes(kit)).toEqual([]);
    await say(kit, "새 대화");
    const home = workOf(kit, pointer(kit).workId);
    expect(home.messengerHome).toEqual({ kind: "telegram", registered: true });
    expect(made(kit)).toMatch(/^새 대화를 만들었습니다: 「텔레그램 대화」 › 「휴대폰 · [^」]+」 \([^)]+\)\n/);
    expect(made(kit).split("\n")[1]).toBe(LINE);
    // The planted conversation is where it was, and can be gone back to.
    expect(sessionOf(kit, planted.id)).toMatchObject({ workId: mine.work.id, archivedAt: null });
    const id = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    await press(kit, "샘플 프로젝트");
    await press(kit, kit.adapter.labelsOf(id).find((label) => label.startsWith("휴대폰 · 11/15"))!);
    expect(pointer(kit).id).toBe(planted.id);
    // Chosen now: 새 대화 stays, and the line is not said again.
    await say(kit, "새 대화");
    expect(pointer(kit).workId).toBe(mine.work.id);
    expect(kit.adapter.texts().filter((text) => text.includes(LINE))).toHaveLength(1);
  });

  it("the menu's 새 대화 says the same line in its answer", async () => {
    const kit = await startKit();
    const mine = project(kit, "샘플 프로젝트");
    const binding = await pair(kit);
    kit.core.setPointer(binding.id, kit.manager.createSession(mine.work.id, { provider: "claude", purpose: "휴대폰 · 11/15", access: "full" }, false).id);
    const id = await menu(kit);
    await press(kit, "새 대화");
    expect(shownText(kit, id).split("\n")).toEqual([expect.stringMatching(/^새 대화를 만들었습니다: 「텔레그램 대화」 › /), LINE]);
    expect(workOf(kit, pointer(kit).workId).messengerHome?.kind).toBe("telegram");
  });
});

describe("the home at the PC while its messenger is registered", () => {
  it("cannot be renamed, moved into a folder, archived or deleted, each refused in one plain line; when the messenger is gone it can", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const first = pointer(kit);
    kit.engine.finish(first.id);
    const home = workOf(kit, first.workId);
    const folder = kit.manager.createFolder("강의", null);
    const refused = (run: () => unknown) => { try { run(); return null; } catch (error) { return error; } };
    for (const run of [
      () => kit.manager.updateWork(home.id, { title: "내 대화" }),
      () => kit.manager.updateWork(home.id, { folderId: folder.id }),
      () => kit.manager.updateWork(home.id, { archived: true }),
      () => kit.manager.deleteWork(home.id),
    ]) {
      const error = refused(run);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 409, code: "messenger_home", message: "텔레그램을 연결해 둔 동안에는 '텔레그램 대화'의 이름을 바꾸거나 옮기거나 보관·삭제할 수 없습니다." });
    }
    // What a project row may always do still works (고정, the conversation shown).
    expect(kit.manager.updateWork(home.id, { pinned: true, title: "텔레그램 대화" }).pinned).toBe(true);
    expect(workOf(kit, home.id)).toMatchObject({ title: "텔레그램 대화", folderId: null, archivedAt: null });
    // The messenger removed (service.ts says so): the home and its conversations stay, and it can be archived.
    kit.manager.setMessengerRegistered("telegram", false);
    expect(workOf(kit, home.id).messengerHome).toEqual({ kind: "telegram", registered: false });
    expect(sessionOf(kit, first.id).workId).toBe(home.id);
    expect(kit.manager.updateWork(home.id, { archived: true }).archivedAt).not.toBeNull();
  });

  it("a free home put away under an archived folder is left alone too", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const old = workOf(kit, pointer(kit).workId);
    kit.engine.finish(pointer(kit).id);
    kit.manager.setMessengerRegistered("telegram", false);
    const folder = kit.manager.createFolder("지난 것", null);
    kit.manager.updateWork(old.id, { folderId: folder.id });
    kit.manager.updateFolder(folder.id, { archived: true });
    kit.manager.setMessengerRegistered("telegram", true);
    expect(workOf(kit, old.id).messengerHome).toEqual({ kind: "telegram", registered: false });
    await say(kit, "새 대화");
    expect(pointer(kit).workId).not.toBe(old.id);
    expect(workOf(kit, pointer(kit).workId)).toMatchObject({ title: "텔레그램 대화", folderId: null, messengerHome: { kind: "telegram", registered: true } });
  });

  it("an archived home is left alone: the chat's next conversation gets a new home", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    const old = workOf(kit, pointer(kit).workId);
    kit.engine.finish(pointer(kit).id);
    kit.manager.setMessengerRegistered("telegram", false);
    kit.manager.updateWork(old.id, { archived: true });
    kit.manager.setMessengerRegistered("telegram", true);
    await say(kit, "새 대화");
    const next = workOf(kit, pointer(kit).workId);
    expect(next.id).not.toBe(old.id);
    expect(next).toMatchObject({ title: "텔레그램 대화", archivedAt: null, messengerHome: { kind: "telegram", registered: true } });
    expect(workOf(kit, old.id).archivedAt).not.toBeNull();
  });
});
