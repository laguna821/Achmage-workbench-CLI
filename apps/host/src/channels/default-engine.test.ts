import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanKits, pair, press, say, sessionOf, settle, startKit, type Kit } from "./test-kit.ts";

// "이 메신저의 기본 엔진" (the owner, 2026-11-16: Codex through Telegram, Claude through Slack). One
// setting per messenger; it names the engine of every conversation the channel MAKES for a chat of
// that messenger when no engine was named: the chat's first conversation, "새 대화", and a move to
// another project. Order: named engine › the messenger's default › the chat's conversation › the
// project's. Not set: exactly as before. Here with the core alone (the setting is kept in memory);
// default-engine-service.test.ts has it with the bot's record, both messengers and the PC's route.

afterEach(() => cleanKits());

const BOT = "7000000001";
const pointer = (kit: Kit) => sessionOf(kit, kit.core.bindings()[0]!.pointerSessionId!);
const shownText = (kit: Kit, messageId: string) => kit.adapter.shown(messageId)!.text;
const MODELS = [{ id: "opus", label: "Opus", description: null, efforts: ["low", "high"], defaultEffort: "low", isDefault: true }];

/** Open the menu and return its message id. */
async function menu(kit: Kit) {
  await settle(kit);
  const before = kit.adapter.sent.length;
  await say(kit, "메뉴");
  return kit.adapter.sent.slice(before)[0]!.messageId;
}

/** A project whose current conversation at the PC runs on `provider`. */
function project(kit: Kit, title: string, provider: "claude" | "codex") {
  const work = kit.manager.createWork({ title });
  kit.manager.createSession(work.id, { provider, purpose: `${title} 대화` });
  return work;
}

describe("not set: exactly as before", () => {
  it("a conversation made in a project follows that project's engine, 새 대화 keeps the chat's engine with its model and effort, a move follows the other project", async () => {
    const kit = await startKit({ codex: true });
    kit.codex!.report = { models: MODELS };
    project(kit, "클로드 과제", "claude");
    project(kit, "코덱스 과제", "codex");
    await pair(kit);
    expect(kit.core.defaultEngine("telegram", BOT)).toBeNull();
    // (Unit 2: the chat's first conversation is in the messenger's home, which has no engine of its own yet: Claude.)
    await say(kit, "첫 일");
    expect(pointer(kit)).toMatchObject({ provider: "claude" });
    kit.engine.finish(pointer(kit).id);
    // The project chosen in the menu runs Codex at the PC: the chat's conversation there does too.
    const first = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    await press(kit, kit.adapter.labelsOf(first).find((label) => label.endsWith("코덱스 과제"))!);
    await press(kit, "이 프로젝트에 새 대화");
    expect(pointer(kit)).toMatchObject({ provider: "codex" });
    kit.manager.updateSession(pointer(kit).id, { model: "opus", effort: "high" });
    await say(kit, "새 대화");
    expect(pointer(kit)).toMatchObject({ provider: "codex", model: "opus", effort: "high" });
    // Moving to the other project: that project's engine, nothing carried over.
    const id = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    await press(kit, kit.adapter.labelsOf(id).find((label) => label.endsWith("클로드 과제"))!);
    await press(kit, "이 프로젝트에 새 대화");
    expect(pointer(kit)).toMatchObject({ provider: "claude", model: null, effort: null });
    expect(kit.adapter.texts().some((text) => text.includes("기본 엔진"))).toBe(false);
  });
});

describe("the messenger's default engine names the engine of every conversation the channel makes", () => {
  it("the chat's first conversation", async () => {
    const kit = await startKit({ codex: true });
    project(kit, "클로드 과제", "claude");
    await pair(kit);
    kit.core.setDefaultEngine("telegram", BOT, "codex");
    await say(kit, "첫 일");
    expect(pointer(kit)).toMatchObject({ provider: "codex", access: "full" });
    expect(kit.codex!.sent.map((turn) => turn.text.includes("첫 일"))).toEqual([true]);
    expect(kit.engine.sent).toEqual([]);
  });

  it("새 대화: the default before the chat's conversation; its model and effort are taken only when it is the same engine", async () => {
    const kit = await startKit({ codex: true });
    kit.engine.report = { models: MODELS };
    kit.codex!.report = { models: MODELS };
    await pair(kit);
    await say(kit, "첫 일");
    const first = pointer(kit);
    expect(first.provider).toBe("claude");
    kit.engine.finish(first.id);
    kit.manager.updateSession(first.id, { model: "opus", effort: "high" });
    kit.core.setDefaultEngine("telegram", BOT, "codex");
    // The word and the menu's key both: Codex, and nothing of the Claude conversation's model.
    await say(kit, "새 대화");
    expect(pointer(kit)).toMatchObject({ provider: "codex", model: null, effort: null, workId: first.workId });
    kit.manager.updateSession(pointer(kit).id, { model: "opus", effort: "low" });
    const id = await menu(kit);
    await press(kit, "새 대화");
    expect(shownText(kit, id)).toMatch(/^새 대화를 만들었습니다: /);
    // From a Codex conversation to a Codex one: its model and effort go along, as before.
    expect(pointer(kit)).toMatchObject({ provider: "codex", model: "opus", effort: "low" });
    // The conversation that was there is as it was.
    expect(sessionOf(kit, first.id)).toMatchObject({ provider: "claude", model: "opus", effort: "high" });
  });

  it("a move to another project, and a new project: the default, not that project's engine", async () => {
    const kit = await startKit({ codex: true });
    const other = project(kit, "클로드 과제", "claude");
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(pointer(kit).id);
    kit.core.setDefaultEngine("telegram", BOT, "codex");
    const id = await menu(kit);
    await press(kit, "프로젝트 바꾸기");
    await press(kit, kit.adapter.labelsOf(id).find((label) => label.endsWith("클로드 과제"))!);
    await press(kit, "이 프로젝트에 새 대화");
    expect(pointer(kit)).toMatchObject({ provider: "codex", workId: other.id });
    await press(kit, "← 메뉴");
    await press(kit, "프로젝트 바꾸기");
    await press(kit, "새 프로젝트");
    await say(kit, "가을 특강");
    expect(pointer(kit).provider).toBe("codex");
    expect(kit.manager.snapshot().works.find((work) => work.id === pointer(kit).workId)!.title).toBe("가을 특강");
  });

  it("a document's AI made from the chat follows it; one that exists already is not changed", async () => {
    const kit = await startKit({ codex: true });
    await pair(kit);
    await say(kit, "첫 일");
    const main = pointer(kit);
    kit.engine.finish(main.id);
    const work = kit.manager.snapshot().works.find((entry) => entry.id === main.workId)!;
    writeFileSync(join(work.cwd, "심사 의견서.md"), "# 의견\n");
    writeFileSync(join(work.cwd, "계획서.md"), "# 계획\n");
    const old = kit.manager.openFile(work.id, "계획서.md");
    // 계획서 already has its AI (Claude, made before the default was set).
    const existing = kit.manager.documentSession(old.id, main.id, false);
    expect(existing.provider).toBe("claude");
    kit.core.setDefaultEngine("telegram", BOT, "codex");
    kit.manager.openFile(work.id, "심사 의견서.md");
    const id = await menu(kit);
    await press(kit, "최근 파일");
    await press(kit, "심사 의견서.md");
    await press(kit, "이 문서의 AI에게");
    expect(pointer(kit)).toMatchObject({ provider: "codex" });
    expect(pointer(kit).documentAgent).toBeTruthy();
    expect(shownText(kit, id)).toMatch(/^이제 「심사 의견서」의 AI에게 보냅니다 \(Codex · /);
    await press(kit, "← 메뉴");
    await press(kit, "최근 파일");
    await press(kit, "계획서.md");
    await press(kit, "이 문서의 AI에게");
    expect(pointer(kit).id).toBe(existing.id);
    expect(pointer(kit).provider).toBe("claude");
  });

  it("an engine named in the chat wins over the default at that moment", async () => {
    const kit = await startKit({ codex: true });
    await pair(kit);
    kit.core.setDefaultEngine("telegram", BOT, "codex");
    await say(kit, "첫 일");
    const first = pointer(kit);
    expect(first.provider).toBe("codex");
    kit.codex!.finish(first.id);
    await menu(kit);
    await press(kit, "엔진·모델");
    await press(kit, "Claude");
    expect(pointer(kit)).toMatchObject({ provider: "claude", workId: first.workId });
    expect(sessionOf(kit, first.id).provider).toBe("codex");
  });
});

describe("the default engine is not installed on this PC", () => {
  it("makes the conversation as before and tells the chat once, in one line, which engine was used and why", async () => {
    const kit = await startKit({ codex: true });
    await pair(kit);
    kit.core.setDefaultEngine("telegram", BOT, "codex");
    kit.codex!.report = { installed: false };
    await say(kit, "첫 일");
    expect(pointer(kit).provider).toBe("claude");
    await settle(kit);
    const told = () => kit.adapter.texts().filter((text) => text.includes("설치되어 있지 않아"));
    expect(told()).toEqual(["이 메신저의 기본 엔진 Codex가 이 PC에 설치되어 있지 않아 Claude로 만들었습니다."]);
    kit.engine.finish(pointer(kit).id);
    await say(kit, "새 대화");
    await settle(kit);
    expect(pointer(kit).provider).toBe("claude");
    expect(told()).toHaveLength(1);
    // Installed again: the default is used, with nothing more said about it.
    kit.codex!.report = {};
    await say(kit, "새 대화");
    await settle(kit);
    expect(pointer(kit).provider).toBe("codex");
    expect(told()).toHaveLength(1);
  });
});

describe("the chat's engine screen", () => {
  it("says the default in one line; choosing an engine makes the new conversation AND the messenger's default, in plain words; 정하지 않음 clears it", async () => {
    const kit = await startKit({ codex: true });
    await pair(kit);
    await say(kit, "첫 일");
    const first = pointer(kit);
    kit.engine.finish(first.id);
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    expect(shownText(kit, id)).toMatch(/\n이 메신저의 기본 엔진: 정하지 않음$/);
    expect(kit.adapter.labelsOf(id).slice(0, 3)).toEqual(["✓ Claude", "Codex", "✓ 기본 엔진: 정하지 않음"]);
    await press(kit, "Codex");
    expect(kit.core.defaultEngine("telegram", BOT)).toBe("codex");
    expect(pointer(kit)).toMatchObject({ provider: "codex", workId: first.workId });
    const said = shownText(kit, id);
    expect(said).toMatch(/^이 대화를 Codex로 바꿀 수 없어 Codex로 새 대화를 만들었습니다: 「휴대폰 · [^」]+」\.\n앞으로 이 메신저의 새 대화는 Codex로 만듭니다\.\n\n/);
    expect(said).toMatch(/\n이 메신저의 기본 엔진: Codex$/);
    expect(kit.adapter.labelsOf(id).slice(0, 3)).toEqual(["Claude", "✓ Codex", "기본 엔진: 정하지 않음"]);
    // The conversation's own engine again: nothing is made, the default is said again.
    const before = pointer(kit).id;
    await press(kit, "✓ Codex");
    expect(pointer(kit).id).toBe(before);
    expect(shownText(kit, id)).toMatch(/^이미 Codex 대화입니다\.\n앞으로 이 메신저의 새 대화는 Codex로 만듭니다\.\n\n/);
    await press(kit, "기본 엔진: 정하지 않음");
    expect(kit.core.defaultEngine("telegram", BOT)).toBeNull();
    expect(pointer(kit).id).toBe(before);
    expect(shownText(kit, id)).toMatch(/^이 메신저의 기본 엔진을 정하지 않았습니다\. 앞으로 새 대화는 전처럼 지금 대화나 프로젝트의 엔진으로 만듭니다\.\n\n/);
    expect(shownText(kit, id)).toMatch(/\n이 메신저의 기본 엔진: 정하지 않음$/);
    // The conversation that was there first was never changed.
    expect(sessionOf(kit, first.id).provider).toBe("claude");
  });

  it("an engine that is not on this PC is not made the default", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(pointer(kit).id);
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    await press(kit, "Codex");
    expect(shownText(kit, id)).toMatch(/^Codex가 이 PC에 설치되어 있지 않습니다\. 이 메신저의 기본 엔진은 그대로입니다\.\n\n/);
    expect(kit.core.defaultEngine("telegram", BOT)).toBeNull();
  });

  it("before the chat's first conversation: the default can be chosen, and the first conversation is made with it", async () => {
    const kit = await startKit({ codex: true });
    await pair(kit);
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    expect(shownText(kit, id)).toBe("아직 대화가 없습니다. 적어 보내면 새 대화가 생깁니다.\n이 메신저의 기본 엔진: 정하지 않음");
    expect(kit.adapter.labelsOf(id)).toEqual(["Claude", "Codex", "✓ 기본 엔진: 정하지 않음", "← 메뉴"]);
    await press(kit, "Codex");
    expect(shownText(kit, id)).toBe("앞으로 이 메신저의 새 대화는 Codex로 만듭니다.\n아직 대화가 없습니다. 적어 보내면 새 대화가 생깁니다.\n이 메신저의 기본 엔진: Codex");
    expect(kit.core.bindings()[0]!.pointerSessionId).toBeNull();
    await say(kit, "첫 일");
    expect(pointer(kit).provider).toBe("codex");
  });
});
