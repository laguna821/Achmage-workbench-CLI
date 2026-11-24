import { afterEach, describe, expect, it } from "vitest";
import { cleanKits, pair, press, say, sessionOf, StandInEngine, startKit, userItems, type Kit } from "./test-kit.ts";

// Security review 0.5.6 (item 1): the messenger's remote (workbench-remote) is another AI handing work over, not the
// person typing. A Gemini conversation (subscription login only) takes only what a person sends (study § G rule 6): `tell` into it and `start` with Gemini as the messenger's default are refused with one line the person
// sees; the person entering that conversation from the messenger and writing there is allowed.

afterEach(() => cleanKits());

const GEMINI_REMOTE = "Gemini 대화에는 다른 AI가 일을 넘길 수 없습니다. 메뉴 › 대화 바꾸기로 그 대화에 직접 들어가 보내 주세요.";
const json = (answer: { stdout: string }) => JSON.parse(answer.stdout) as { ok: boolean; error?: string; message?: string; engine?: string };

async function kitWithGemini(personOnly: boolean) {
  const kit = await startKit();
  const gemini = Object.assign(new StandInEngine(() => kit.manager.sink, "gemini"), { personOnly: () => personOnly });
  kit.manager.registerAdapter(gemini);
  await pair(kit);
  await say(kit, "강의계획서 프로젝트에서 서론 다시 써 줘");
  const remote = sessionOf(kit, kit.core.bindings()[0]!.pointerSessionId!);
  const work = kit.manager.createWork({ title: "강의계획서", titleSource: "user" });
  const session = kit.manager.createSession(work.id, { provider: "gemini", purpose: "Gemini 대화", access: "auto" });
  return { kit, gemini, remote, work, session };
}
const run = (kit: Kit, sessionId: string, args: string[], input = "") => kit.core.remote(sessionId, args, input);

describe("the messenger's remote and a Gemini conversation", () => {
  it("tell is refused with the line, and nothing reaches Gemini", async () => {
    const { kit, gemini, remote, session } = await kitWithGemini(true);
    const answer = await run(kit, remote.id, ["tell", "--conversation", session.id], "이어서 써 줘");
    expect(json(answer)).toMatchObject({ ok: false, error: "person_only", message: GEMINI_REMOTE });
    expect(gemini.sent).toEqual([]);
    expect(userItems(kit, session.id)).toEqual([]);
  });

  it("start with Gemini as the messenger's default asks for an engine instead", async () => {
    const { kit, remote, work } = await kitWithGemini(true);
    kit.core.setDefaultEngine("telegram", kit.adapter.botId, "gemini");
    const before = kit.manager.snapshot().sessions.filter((entry) => entry.workId === work.id).length;
    expect(json(await run(kit, remote.id, ["start", "--project", work.id], "해 줘"))).toMatchObject({ ok: false, error: "engine_needed" });
    expect(kit.manager.snapshot().sessions.filter((entry) => entry.workId === work.id)).toHaveLength(before);
  });

  it("the person entering the Gemini conversation from the messenger and writing there is allowed", async () => {
    const { kit, gemini, session } = await kitWithGemini(true);
    // 메뉴 › 프로젝트 바꾸기 › the project › its Gemini conversation, as the person does it in the chat.
    const menu = (await say(kit, "메뉴"), kit.adapter.sent.at(-1)!.messageId);
    await press(kit, "프로젝트 바꾸기");
    await press(kit, kit.adapter.labelsOf(menu).find((label) => label.endsWith("강의계획서"))!);
    const into = kit.adapter.labelsOf(menu).find((label) => label.includes("Gemini 대화"));
    if (!into) await press(kit, "대화 바꾸기");
    await press(kit, kit.adapter.labelsOf(menu).find((label) => label.includes("Gemini 대화"))!);
    expect(sessionOf(kit, kit.core.bindings()[0]!.pointerSessionId!)).toMatchObject({ id: session.id, provider: "gemini" });
    await say(kit, "결론을 한 문단으로 줄여 줘");
    const text = gemini.sent.map((entry) => entry.text).join("\n");
    expect(text).toContain("결론을 한 문단으로 줄여 줘");
    // Two plain lines from the messenger, not the other engines' phone preamble (its tool manuals and rules).
    expect(text).not.toContain("workbench-credential");
    expect(text.split("결론을 한 문단으로 줄여 줘")[0]!.length).toBeLessThan(200);
  });

});
