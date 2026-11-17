import { afterEach, describe, expect, it } from "vitest";
import { cleanKits, pair, press, restartKit, say, sessionOf, settle, startKit, type Kit } from "./test-kit.ts";

// Unit 13 "확인 받기" (design m02 §7.3): per chat, off by default. On, every conversation the chat
// makes from then on is `auto` instead of `full`, and what those conversations ask comes to the
// chat as the bound buttons [허용] [거절]. Conversations that already exist keep their mode.

afterEach(() => cleanKits());

const ON_LINE = "확인 받기를 켰습니다. 앞으로 이 채팅이 만드는 새 대화는 '자동' 모드입니다: Claude는 파일 읽기·고치기만 알아서 하고 명령 실행·웹 접근 같은 다른 일은 먼저 묻고, Codex는 작업 폴더 안의 일만 인터넷 없이 알아서 하고 그 밖의 일은 먼저 묻습니다. 지금 있는 대화는 그대로입니다.";
const OFF_LINE = "확인 받기를 껐습니다. 앞으로 새 대화는 전처럼 묻지 않고 끝까지 합니다. 지금 있는 대화는 그대로입니다.";
const HELP_LINE = "· 메뉴 › 알림 › 확인 받기 — 켜면 새 대화가 명령 실행 같은 일을 하기 전에 [허용] [거절]로 묻습니다";
const ROW_OFF = "꺼짐 · 확인 받기(새 대화가 먼저 묻기)";
const ROW_ON = "켜짐 · 확인 받기(새 대화가 먼저 묻기)";

const binding = (kit: Kit) => kit.core.bindings()[0]!;
const pointer = (kit: Kit) => sessionOf(kit, binding(kit).pointerSessionId!);

async function menu(kit: Kit) {
  await settle(kit);
  const before = kit.adapter.sent.length;
  await say(kit, "메뉴");
  return kit.adapter.sent[before]!.messageId;
}

/** 메뉴 › 알림 › the row, pressed once. */
async function toggle(kit: Kit) {
  const id = await menu(kit);
  await press(kit, "알림");
  const row = kit.adapter.labelsOf(id).find((label) => label.includes("확인 받기"))!;
  await press(kit, row);
  return id;
}

describe("the switch, per chat", () => {
  it("is off by default: a new conversation is full access, the row says 꺼짐, prefs carry nothing", async () => {
    const kit = await startKit();
    await pair(kit);
    expect(binding(kit).prefs.confirm).toBeUndefined();
    await say(kit, "첫 일");
    expect(pointer(kit).access).toBe("full");
    const id = await menu(kit);
    await press(kit, "알림");
    expect(kit.adapter.labelsOf(id)).toContain(ROW_OFF);
    // Off: nothing more in the chat than before (no mode notice for the chat's own conversations).
    expect(kit.adapter.texts().some((text) => text.includes("모드라"))).toBe(false);
  });

  it("one press in 메뉴 › 알림 turns it on (said once, in one line), survives a restart, a second press turns it off", async () => {
    let kit = await startKit();
    await pair(kit);
    const id = await toggle(kit);
    expect(kit.adapter.labelsOf(id)).toContain(ROW_ON);
    expect(binding(kit).prefs.confirm).toBe(true);
    expect(kit.adapter.texts().filter((text) => text === ON_LINE)).toHaveLength(1);
    expect(ON_LINE.includes("\n")).toBe(false);
    kit = await restartKit(kit);
    expect(binding(kit).prefs.confirm).toBe(true);
    await toggle(kit);
    expect(binding(kit).prefs.confirm).toBeUndefined();
    expect(kit.adapter.texts().at(-1)).toBe(OFF_LINE);
    const record = kit.core.auditList({ bindingId: binding(kit).id }).filter((row) => row.action === "confirm").map((row) => row.result);
    expect(record).toEqual(["off", "on"]);
  });

  it("setting the value it already has says nothing again", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.core.setConfirm(binding(kit).id, true);
    kit.core.setConfirm(binding(kit).id, true);
    kit.core.setConfirm(binding(kit).id, false);
    kit.core.setConfirm(binding(kit).id, false);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text === ON_LINE || text === OFF_LINE)).toEqual([ON_LINE, OFF_LINE]);
  });
});

describe("the mode of each way a conversation is made", () => {
  it("on: the first line, 새 대화, 메뉴 새 대화, a new one in a project, another engine — all `auto`; existing ones keep theirs; off: `full` again", async () => {
    const kit = await startKit({ codex: true });
    const work = kit.manager.createWork({ title: "연구계획서", titleSource: "user" });
    await pair(kit);
    await say(kit, "전부터 있던 대화");
    const before = pointer(kit);
    expect(before.access).toBe("full");
    kit.engine.finish(before.id);
    kit.core.setConfirm(binding(kit).id, true);
    await settle(kit);
    expect(sessionOf(kit, before.id).access).toBe("full");

    await say(kit, "새 대화");
    const word = pointer(kit);
    expect(word.id).not.toBe(before.id);
    expect(word.access).toBe("auto");

    const id = await menu(kit);
    await press(kit, "새 대화");
    expect(pointer(kit).access).toBe("auto");

    await press(kit, "← 메뉴");
    await press(kit, "프로젝트 바꾸기");
    await press(kit, kit.adapter.labelsOf(id).find((label) => label.endsWith("연구계획서"))!);
    await press(kit, "이 프로젝트에 새 대화");
    expect(pointer(kit)).toMatchObject({ workId: work.id, access: "auto" });

    await press(kit, "← 메뉴");
    await press(kit, "엔진·모델");
    await press(kit, "Codex");
    expect(pointer(kit)).toMatchObject({ provider: "codex", access: "auto" });
    // No "이 대화는 '자동' 모드라…" for what the person just chose.
    await say(kit, "코덱스로 해 줘");
    expect(kit.adapter.texts().some((text) => text.includes("모드라"))).toBe(false);

    kit.core.setConfirm(binding(kit).id, false);
    await settle(kit);
    const autoOne = pointer(kit).id;
    kit.codex!.finish(autoOne);
    await say(kit, "새 대화");
    expect(pointer(kit).access).toBe("full");
    expect(sessionOf(kit, autoOne).access).toBe("auto");
  });

  it("a conversation the remote starts by hand-over is `auto` when on, `full` when off", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "강의계획서 프로젝트에서 서론 다시 써 줘");
    const remote = pointer(kit);
    const work = kit.manager.createWork({ title: "강의계획서", titleSource: "user" });
    const start = async () => JSON.parse((await kit.core.remote(remote.id, ["start", "--project", work.id, "--engine", "claude"], "서론 다시 써 줘")).stdout).conversation as string;
    expect(sessionOf(kit, await start()).access).toBe("full");
    kit.core.setConfirm(binding(kit).id, true);
    await settle(kit);
    expect(sessionOf(kit, await start()).access).toBe("auto");
  });
});

describe("what those conversations ask comes to the chat", () => {
  async function confirmed(options: { codex?: boolean } = {}) {
    const kit = await startKit(options);
    await pair(kit);
    kit.core.setConfirm(binding(kit).id, true);
    await settle(kit);
    return kit;
  }

  it("Claude: named, what is asked, [허용] [거절]; answered once; a second press is 이미 처리됨", async () => {
    const kit = await confirmed();
    await say(kit, "빌드 지워 줘");
    const session = pointer(kit);
    expect(session.access).toBe("auto");
    expect(kit.engine.sent.at(-1)!.access).toBe("auto");
    kit.engine.ask(session.id, "명령 실행 허용?", "rm -rf ./build");
    await settle(kit);
    const asked = kit.adapter.last()!;
    expect(asked.out.text).toBe(`「${session.purpose}」 · 명령 실행 허용?\nrm -rf ./build`);
    expect(asked.out.buttons!.flat().map((button) => button.label)).toEqual(["허용", "거절"]);
    const { token, messageId } = kit.adapter.buttonOf("허용");
    await press(kit, "허용");
    expect(kit.engine.answered).toEqual([{ sessionId: session.id, itemId: expect.any(String), decision: "accept" }]);
    await kit.adapter.deliver(kit.adapter.press(token, { messageId }));
    await settle(kit);
    expect(kit.engine.answered).toHaveLength(1);
    expect(kit.adapter.acks.at(-1)!.note).toBe("이미 처리됨");
  });

  it("Codex: the same buttons; the PC answering first makes the chat's buttons 이미 처리됨", async () => {
    const kit = await confirmed({ codex: true });
    const id = await menu(kit);
    await press(kit, "엔진·모델");
    await press(kit, "Codex");
    expect(id).toBeTruthy();
    await say(kit, "ls 해 줘");
    const session = pointer(kit);
    expect(session).toMatchObject({ provider: "codex", access: "auto" });
    expect(kit.codex!.sent.at(-1)!.access).toBe("auto");
    const itemId = kit.codex!.ask(session.id, "명령 실행 허용?", "ls -la");
    await settle(kit);
    expect(kit.adapter.last()!.out.text).toBe(`「${session.purpose}」 · 명령 실행 허용?\nls -la`);
    const { token, messageId } = kit.adapter.buttonOf("거절");
    await kit.manager.answerApproval(session.id, itemId, "accept");
    await settle(kit);
    expect(kit.adapter.edits.some((edit) => edit.messageId === messageId && (edit.out.tail ?? edit.out.text).includes("PC에서 허용함"))).toBe(true);
    await kit.adapter.deliver(kit.adapter.press(token, { messageId }));
    await settle(kit);
    expect(kit.codex!.answered.map((entry) => entry.decision)).toEqual(["accept"]);
    expect(kit.adapter.acks.at(-1)!.note).toBe("이미 처리됨");
  });

  for (const provider of ["claude", "codex"] as const) {
    it(`a conversation handed over by the remote (${provider}): its question under the hand-over's head line, answered from the chat`, async () => {
      const kit = await confirmed({ codex: true });
      await say(kit, "강의계획서 프로젝트에서 표 정리해 줘");
      const remote = pointer(kit);
      const work = kit.manager.createWork({ title: "강의계획서", titleSource: "user" });
      const target = JSON.parse((await kit.core.remote(remote.id, ["start", "--project", work.id, "--engine", provider, "--title", "표 정리"], "표 정리해 줘")).stdout).conversation as string;
      expect(sessionOf(kit, target).access).toBe("auto");
      kit.engine.finish(remote.id);
      await settle(kit);
      const engine = provider === "codex" ? kit.codex! : kit.engine;
      engine.ask(target, "명령 실행 허용?", "rm -rf ./build");
      await settle(kit);
      const asked = kit.adapter.sent.find((entry) => entry.out.text.includes("명령 실행 허용?"))!;
      expect(asked.out.text.split("\n")[0]).toBe(`강의계획서 · 표 정리 · ${provider === "codex" ? "Codex" : "Claude"}`);
      expect(asked.out.text).toContain("「표 정리」 · 명령 실행 허용?\nrm -rf ./build");
      expect(asked.out.buttons!.flat().map((button) => button.label)).toEqual(["허용", "거절", "이 대화로 들어가기"]);
      await press(kit, "거절");
      expect(engine.answered.map((entry) => entry.decision)).toEqual(["decline"]);
    });
  }
});

describe("the words", () => {
  it("도움말 has the one line", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "도움말");
    expect(kit.adapter.texts().at(-1)).toContain(HELP_LINE);
  });
});
