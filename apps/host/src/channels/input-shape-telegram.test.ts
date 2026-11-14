import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CAUGHT, cleanAll, CODE, end, openInput, reached, RELEASE, rig, runShapeCell, shapeCells, wait, type Ending } from "./matrix-kit.ts";
import { tick } from "./test-kit.ts";

// Fix round 5, ruling Q6: the matrix covers shapes, not only endings (Telegram). Every form of the
// rulings' table (matrix-kit.ts FORMS: re-review 4's list, Q3's caught and passing forms) is sent as
// typed text, as a forwarded message and as a photo's caption, after a code or a link input ended
// by 취소, 멈춰, a timeout or a restart. Caught: not to the AI, deleted, answered once with
// [그대로 보내기], which forwards it. Passing: to the AI, untouched. Made-up values only.

afterEach(cleanAll);
const cells = shapeCells("telegram");
afterAll(() => console.log(`input-shape matrix (Telegram): ${cells.length} cells, ${cells.filter((cell) => typeof cell.expect === "string").length} run`));

describe("ruling Q6 (Telegram): the next message's shape after an input ended", () => {
  for (const cell of cells) {
    if (typeof cell.expect === "object") continue;
    it(`${cell.kind} · ${cell.ending} · ${cell.carrier} · ${cell.form.name} → ${cell.expect}`, () => runShapeCell(cell));
  }
});

// Ruling Q4: each ended input arms its own catch; another input opening, being cancelled or ending never drops it.
describe("ruling Q4: late catches do not cancel each other", () => {
  const firsts: ("code" | "link")[] = ["code", "link"];
  const ways: Ending[] = ["stopWord", "cancelWord"];
  for (const first of firsts) for (const firstEnd of ways) for (const secondEnd of ways) {
    const second = first === "code" ? "link" : "code";
    it(`${first} · ${firstEnd}, then ${second} · ${secondEnd} → the first one's shape is still caught`, async () => {
      const r = await rig("telegram");
      await openInput(r, first);
      await end(r, first, firstEnd);
      await openInput(r, second);
      await end(r, second, secondEnd);
      const text = first === "code" ? `[Web발신]\n[도서관] 인증번호 [${CODE}]를 입력해 주세요.` : `${r.site}/magic?t=zz-fake-magic-0909`;
      const said = r.texts().length;
      const sent = r.send(text);
      await wait(() => sent.deleted() && r.texts().slice(said).some((line) => CAUGHT.test(line))).catch((error: unknown) => { throw new Error(`${String(error)}; reached: ${reached(r, text)}`); });
      await r.g.channels.core.idle();
      await tick(20);
      expect(reached(r, text)).toBe(false);
    });
  }
});

// Ruling Q2: a caught photo is deleted with its caption, never forwarded; [그대로 보내기] forwards the original message, picture included.
describe("ruling Q2: a caught photo goes whole, only by [그대로 보내기]", () => {
  it("code · 취소 · a screenshot with the SMS as its caption: deleted, answered, not to the AI; released with its picture", async () => {
    const r = await rig("telegram");
    await openInput(r, "code");
    await end(r, "code", "cancelWord");
    const caption = `캡처요 인증번호 ${CODE}`;
    const said = r.texts().length;
    const sent = r.send(caption, "caption");
    await wait(() => sent.deleted() && r.texts().slice(said).some((line) => CAUGHT.test(line)));
    await r.g.channels.core.idle();
    await tick(20);
    expect(reached(r, CODE)).toBe(false);
    r.press(RELEASE);
    await wait(() => reached(r, caption));
    const item = r.g.manager.items(r.sessionId).items.findLast((entry) => entry.kind === "user" && entry.text.includes(caption));
    expect(item && item.kind === "user" ? item.attachments?.length : 0, "the picture goes with it").toBe(1);
  });
});
