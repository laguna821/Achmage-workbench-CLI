import { afterEach, describe, expect, it } from "vitest";
import { telegramKit, type TelegramKit } from "./telegram-kit.ts";
import { until } from "./test-kit.ts";

// Buttons bound to the message that carries them, through the whole channel and the stand-in Bot
// API: when an answer goes as text plus files (a long answer's .md, a first-page picture), the
// buttons sit on the text, and a press there must be taken.

const kits: TelegramKit[] = [];
afterEach(async () => { for (const kit of kits.splice(0)) await kit.close(); });
const open = async () => { const kit = await telegramKit(); kits.push(kit); await kit.pair(); return kit; };

describe("buttons bound to the message that carries them", () => {
  it("a long plan goes as text + .md, and its [진행] is taken once", async () => {
    const kit = await open();
    await kit.say("계획 먼저: 학회 발표 자료 만들어 줘");
    const turn = kit.engine.sent.at(-1)!;
    kit.engine.say(turn.sessionId, `계획:\n\n${Array.from({ length: 30 }, (_, index) => `${index + 1}. 단계 ${"설명 ".repeat(8)}`).join("\n\n")}`);
    kit.engine.finish(turn.sessionId);
    await until(() => kit.fake.of("sendDocument").length === 1);
    const before = kit.engine.sent.length;
    const at = kit.press("진행");
    // The keyboard sits on the text message; the .md came after it.
    expect(kit.fake.of("sendMessage").some((call) => call.messageId === at)).toBe(true);
    await until(() => kit.engine.sent.length === before + 1);
    expect(kit.engine.sent.at(-1)!.text).toContain("계획대로 진행해 주세요.");
    // A second press of the same button does nothing more.
    kit.fake.press(kit.fake.button("진행").data, { messageId: at });
    await until(() => kit.fake.of("answerCallbackQuery").length >= 2);
    expect(kit.fake.of("answerCallbackQuery").at(-1)!.params.text).toBe("이미 처리됨");
    expect(kit.engine.sent.length).toBe(before + 1);
  });

  it("a choice on a long answer (text + .md) is taken", async () => {
    const kit = await open();
    await kit.say("자료를 찾아 줘");
    const turn = kit.engine.sent.at(-1)!;
    kit.engine.say(turn.sessionId, `${"찾은 것을 정리했습니다. ".repeat(80)}\n\n[[선택: 표로 | 글로]]`);
    kit.engine.finish(turn.sessionId);
    await until(() => kit.fake.of("sendDocument").length === 1);
    const before = kit.engine.sent.length;
    kit.press("표로");
    await until(() => kit.engine.sent.length === before + 1);
    expect(kit.engine.sent.at(-1)!.text).toContain("표로");
  });

  it("an answer whose formatting Telegram refused goes plain once, and its button on that message is taken", async () => {
    const kit = await open();
    await kit.say("자료를 찾아 줘");
    const turn = kit.engine.sent.at(-1)!;
    kit.engine.say(turn.sessionId, "**정리했습니다.**\n\n[[선택: 표로 | 글로]]");
    kit.fake.refuseFormatted = 1;
    kit.engine.finish(turn.sessionId);
    const answer = await kit.sent(/^정리했습니다\./);
    expect(answer.params.entities).toBeUndefined();
    expect(kit.texts().filter((text) => text.startsWith("정리했습니다."))).toHaveLength(1);
    const before = kit.engine.sent.length;
    expect(kit.press("글로")).toBe(answer.messageId);
    await until(() => kit.engine.sent.length === before + 1);
    expect(kit.engine.sent.at(-1)!.text).toContain("글로");
  });
});
