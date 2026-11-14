import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { binding, CAUGHT, catchOf, cleanAll, CODE, end, ENDED, ENDINGS, KEY, KINDS, LINK, MESSENGERS, NEXTS, endTurn, metaKey, openInput, reached, RELEASE, rig, wait, type Ending, type Kind, type Messenger, type Next, type Outcome } from "./matrix-kit.ts";
import { tick } from "./test-kit.ts";

// Fix round 4, ruling P3: the gate is a matrix, not a list. Every cell of
//   {input kind} × {way of ending} × {next message} × {Telegram, Slack}
// is generated here and either run or listed as not applicable WITH its reason (printed at the end,
// never skipped silently). Each cell runs a whole gateway (the real Telegram adapter against the
// stand-in Bot API, or the real Slack adapter against the stand-in Slack, both on 127.0.0.1, the real
// ChannelCore, VaultChat/LoginChat, CredentialService and LoginFiller with a stand-in page and a
// stand-in engine) and asserts:
//   - what reached the AI: nothing value-shaped, and every ordinary line unless it was held with
//     [그대로 보내기] (which then forwards it);
//   - what the chat was told: never nothing (the ending line of ruling P1 for every reason but
//     `taken`, and an answer for every caught line);
//   - what was deleted (Telegram deletes a caught line; Slack cannot).
// Made-up values only.
//
// Fix round 5, ruling Q1: the ending line says what is true NOW. With the chat paused or locked
// (the endings pause, lockPc, lockWord, lockButton) it says the gate's sentence instead of "지금부터
// 보내는 글은 AI에게 갑니다". The shapes of the next message are the other matrix
// (input-shape-matrix.test.ts).

/** Q1: what an ending under a closed gate says instead of ENDED (the app's words for each gate state). */
const GATE_ENDED = (ending: Ending) => `지금은 채널이 ${ending === "pause" ? "멈춰" : "잠겨"} 있어 보내는 글이 전달되지 않습니다.`;
const GATED: ReadonlySet<Ending> = new Set(["pause", "lockPc", "lockWord", "lockButton"]);


afterEach(cleanAll);

function nextText(kind: Kind, next: Next, site: string): string | null {
  const shape = catchOf(kind);
  switch (next) {
    case "awaited": return kind === "secret" ? KEY : kind === "approve" ? null : shape === "code" ? CODE : LINK(site);
    case "marked": return kind === "secret" ? `키: ${KEY}` : shape === "code" ? `[Web발신]\n[도서관] 인증번호 [${CODE}]를 입력해 주세요.` : `[도서관] 로그인하려면 아래 링크를 누르세요. ${LINK(site)}`;
    case "number": return "회의는 1430호에서 해요";
    case "ordinary": return "다른 일 해 줘";
    case "appWord": return "도움말";
  }
}

/** Not applicable, with the reason; or what must happen. */
function expected(messenger: Messenger, kind: Kind, ending: Ending, next: Next): Outcome | { na: string } {
  if (messenger === "telegram" && (kind === "pcCode" || kind === "pcLink")) return { na: "Telegram has the in-chat input: a code or link step never waits 'at the PC' there (that is the code/link rows)" };
  if (messenger === "slack" && kind === "secret") return { na: "Slack has no in-chat secret input: the hand-over says to enter the value at the PC and opens nothing (slack-service.test.ts 'secret input on Slack')" };
  if (messenger === "slack" && (kind === "code" || kind === "link")) return { na: "on Slack a code/link step is the 'at the PC' step (pcCode/pcLink rows)" };
  if (ending === "cancelButton" && kind !== "secret") return { na: "this input has no cancel button (the step offers only the word 취소); unit 8's [나중에] is the only one" };
  if (ending === "stopButton") return { na: "the chat has no 멈춰 button: 멈춰 is a word (also '/stop' from the command list, which is the same word)" };
  if (next === "awaited" && kind === "approve") return { na: "an approval awaits a button press ([했어요]), no text has its shape" };
  const shaped = next === "awaited" || next === "marked";
  const caughtShape = shaped && catchOf(kind) !== "none";
  if (next === "appWord") {
    if (["pause", "lockPc", "lockWord", "lockButton"].includes(ending)) return "gate";
    if (ending === "unpaired") return "stranger";
    return "app";
  }
  if (ending === "open") {
    if (messenger === "slack") return caughtShape ? "caught" : "ai";
    // Telegram, while open (round 2's modal rule): a code-shaped line or one candidate is the value; anything else is held.
    if (kind === "secret") return "value";
    if (kind === "approve") return "caught";
    if (kind === "code") return shaped || next === "number" ? "value" : "caught";
    return shaped ? "value" : "caught";
  }
  if (ending === "unpaired") return "stranger";
  if (["pause", "lockPc", "lockWord", "lockButton"].includes(ending)) return messenger === "telegram" && caughtShape ? "caught" : "gate";
  if (ending === "timeoutFound" || ending === "restartFound") {
    // The input was found ended by this very message (nobody told the person yet): on Telegram it is
    // caught whatever it is (as the open input would have kept it from the AI); on Slack by its shape.
    if (messenger === "telegram") return "caught";
    return caughtShape ? "caught" : "ai";
  }
  if (ending === "aiSide") return caughtShape ? "caught" : "archived";
  return caughtShape ? "caught" : "ai";
}

// The matrix

type Cell = { messenger: Messenger; kind: Kind; ending: Ending; next: Next; expect: Outcome | { na: string } };
const cells: Cell[] = [];
for (const messenger of MESSENGERS) for (const kind of KINDS) for (const ending of ENDINGS) for (const next of NEXTS) cells.push({ messenger, kind, ending, next, expect: expected(messenger, kind, ending, next) });
const notApplicable = cells.filter((cell) => typeof cell.expect === "object");

afterAll(() => {
  const reasons = new Map<string, number>();
  for (const cell of notApplicable) { const reason = (cell.expect as { na: string }).na; reasons.set(reason, (reasons.get(reason) ?? 0) + 1); }
  console.log(`input-end matrix: ${cells.length} cells, ${cells.length - notApplicable.length} run, ${notApplicable.length} not applicable`);
  for (const [reason, count] of reasons) console.log(`  n/a ×${count}: ${reason}`);
});

describe("ruling P3: what happens to the next message after a human-only input ends", () => {
  it("every not-applicable cell names its reason", () => {
    for (const cell of notApplicable) expect((cell.expect as { na: string }).na.length).toBeGreaterThan(20);
    expect(cells.length).toBe(MESSENGERS.length * KINDS.length * ENDINGS.length * NEXTS.length);
  });

  for (const cell of cells) {
    if (typeof cell.expect === "object") continue;
    const outcome = cell.expect;
    it(`${cell.messenger} · ${cell.kind} · ${cell.ending} · ${cell.next} → ${outcome}`, async () => {
      const r = await rig(cell.messenger);
      await openInput(r, cell.kind);
      await end(r, cell.kind, cell.ending);
      // Ruling P1: every way of ending but `taken` (and a disconnected chat, which can hear nothing) says one line.
      if (cell.ending !== "taken" && cell.ending !== "open" && cell.ending !== "unpaired" && cell.ending !== "timeoutFound" && cell.ending !== "restartFound") {
        const line = GATED.has(cell.ending) ? GATE_ENDED(cell.ending) : ENDED;
        await wait(() => r.texts().some((text) => text.includes(line)), 1_500).catch(() => undefined);
        expect(r.texts().filter((text) => text.includes(line)), "the ending is said in one line").toHaveLength(1);
        // Q1: never "goes to the AI" while the gate is closed.
        if (GATED.has(cell.ending)) expect(r.texts().filter((text) => text.includes(ENDED)), "no false sentence under a closed gate").toHaveLength(0);
        if (cell.ending !== "newWord" && cell.ending !== "stopWord") expect(r.texts().some((text) => text === "지금 멈출 일이 없습니다.")).toBe(false);
      }
      if (cell.ending === "taken") expect(r.texts().some((text) => text.includes(ENDED))).toBe(false);
      const text = nextText(cell.kind, cell.next, r.site)!;
      const said = r.texts().length;
      const sent = r.send(text);
      const answered = () => r.texts().length > said;
      if (outcome === "ai") await wait(() => reached(r, text));
      else if (outcome === "value") await wait(() => sent.deleted() || answered());
      else if (outcome === "stranger") await tick(150);
      // A caught line: wait for ITS answer. Any new text is not enough — the stand-in turn's late
      // "기다립니다." can land first, and under load the cell then looked before the answer came.
      else if (outcome === "caught") await wait(() => r.texts().slice(said).some((line) => CAUGHT.test(line))).catch((error: unknown) => { throw new Error(`${String(error)}; told: ${JSON.stringify(r.texts().slice(-4))}`); });
      else await wait(answered).catch((error: unknown) => { throw new Error(`${String(error)}; told: ${JSON.stringify(r.texts().slice(-4))}`); });
      await r.g.channels.core.idle();
      await tick(20);
      const valueShaped = cell.next === "awaited" || cell.next === "marked";
      const replies = r.texts().slice(said);
      if (outcome === "ai") {
        expect(reached(r, text)).toBe(true);
        expect(sent.deleted()).toBe(false);
        return;
      }
      expect(reached(r, text), "not to the AI").toBe(false);
      if (valueShaped && catchOf(cell.kind) !== "none") expect(reached(r, cell.kind === "approve" || catchOf(cell.kind) === "code" ? CODE : "zz-fake-magic-0909")).toBe(false);
      if (outcome === "stranger") return;
      expect(replies.length, "the chat is told").toBeGreaterThan(0);
      if (outcome === "gate") expect(replies.some((line) => line.includes("멈춰") || line.includes("잠겨") || CAUGHT.test(line))).toBe(true);
      if (outcome === "archived") expect(replies.some((line) => line.includes("보관되어"))).toBe(true);
      if (outcome === "caught") {
        const answer = replies.find((line) => CAUGHT.test(line));
        expect(answer, "a caught line is answered with why").toBeTruthy();
        expect(sent.deleted()).toBe(r.messenger === "telegram");
        const gateClosed = Boolean(binding(r).pausedAt || binding(r).lockedAt);
        if (!gateClosed) {
          expect(r.labels((line) => CAUGHT.test(line))).toContain(RELEASE);
          // Always releasable: [그대로 보내기] forwards it as the person's ordinary message.
          const before = r.texts().length;
          r.press(RELEASE);
          // Its conversation was archived at the PC (aiSide): the line goes the way any line goes there (told, with a way to a new one).
          if (cell.ending === "aiSide") await wait(() => r.texts().slice(before).some((line) => line.includes("보관되어")));
          else await wait(() => reached(r, text));
        }
      }
      if (outcome === "value") expect(r.messenger === "telegram" ? sent.deleted() : true).toBe(true);
    });
  }
});

// Re-review 3's reproductions are cells above:
//   NEW-I-f  telegram · link · stopWord|newWord · awaited → caught
//   NEW-I-g  telegram · code · cancelWord · marked → caught
//   NEW-I-h  telegram · secret · stopWord|newWord|retryWord|lockWord · * → the ending line is said (P1); unit 8 catches nothing by shape (stated limit)
//   NEW-I-i  slack · pcCode · open · number|ordinary → ai (and the lines below)
//   NEW-M-g  telegram · code · stopWord · marked (word and SMS in one batch) → below
describe("ruling P3: the reproductions that are not one message after an ending", () => {
  it("NEW-I-i: on Slack, while the step waits at the PC, '…이어서 2025 보고서 열어 줘' ends the hold and goes to the AI; '회의는 1430호에서 해요' goes to the AI", async () => {
    const r = await rig("slack");
    await openInput(r, "pcCode");
    r.send("회의는 1430호에서 해요");
    await wait(() => reached(r, "1430호"));
    r.send("이어서 2025 보고서 열어 줘");
    await wait(() => reached(r, "2025 보고서"));
    r.send("이 code 2048 버전 고쳐줘");
    await wait(() => reached(r, "2048 버전"));
  });

  it("NEW-M-g: a starting word and the SMS in one batch: the SMS is caught (never typed, never to the AI), and the AI is not told of a PC restart", async () => {
    const r = await rig("telegram");
    await openInput(r, "code");
    r.send("멈춰");
    const sms = r.send(`[Web발신] 인증번호 [${CODE}]를 입력해 주세요`);
    await wait(() => sms.deleted());
    await r.g.channels.core.idle();
    await tick(50);
    expect(reached(r, CODE)).toBe(false);
    expect(reached(r, "step_lost")).toBe(false);
    expect(r.page.state.typed).toEqual([]);
  });
});


describe("ruling P2: [그대로 보내기] after a restart, and nothing caught is written down", () => {
  it("a caught SMS is in no file of the data folder; after a restart its button says the text is gone and asks to write it again; nothing reaches the AI", async () => {
    const r = await rig("telegram");
    await openInput(r, "code");
    await end(r, "code", "cancelWord");
    const sms = r.send(`[Web발신]\n[도서관] 인증번호 [${CODE}]를 입력해 주세요.`);
    await wait(() => sms.deleted() && r.texts().some((line) => CAUGHT.test(line)));
    await r.restart();
    const before = r.texts().length;
    r.press(RELEASE);
    await wait(() => r.texts().slice(before).some((line) => line.includes("남아 있지 않습니다") && line.includes("다시 적어")));
    await r.g.channels.core.idle();
    expect(reached(r, CODE)).toBe(false);
    expect(r.page.state.typed).toEqual([]);
    await r.g.close();
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(path); } };
    walk(r.dataDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file).includes(Buffer.from(CODE)), file).toBe(false);
  });
});

describe("ruling P1: one way an input ends", () => {
  it("nothing but SecretWindows.finish clears an input; no module keeps a hold of its own", () => {
    const here = new URL(".", import.meta.url).pathname;
    const own = readFileSync(join(here, "secret-window.ts"), "utf8");
    // The window is set to null in exactly one place: `finish`.
    expect(own.match(/\.window = null/g)).toHaveLength(1);
    const finish = own.slice(own.indexOf("private finish("), own.indexOf("end(chat: ChatRef"));
    expect(finish).toContain("state.window = null");
    for (const name of readdirSync(here)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "secret-window.ts") continue;
      const code = readFileSync(join(here, name), "utf8");
      for (const other of [/windows[!?]?\.close\(/, /\.endHandoff\(/, /\.wordEnded\(/, /\.codeEnded\(/, /\.window = /, /waitsAtPc/, /\.expired\(/]) expect(code, `${name}: ${other}`).not.toMatch(other);
    }
  });
});

// Ruling Q5: [다시 넣기] pressed after the step (or the request) is over says ONE true line, and nothing opens.
describe("ruling Q5: [다시 넣기] after the step is over", () => {
  for (const kind of ["code", "secret"] as const) {
    it(`${kind} · ${kind === "code" ? "취소" : "[나중에]"} · the conversation archived at the PC · [다시 넣기] → one line: it is over, what to do instead`, async () => {
      const r = await rig("telegram");
      await openInput(r, kind);
      await end(r, kind, kind === "code" ? "cancelWord" : "cancelButton");
      await wait(() => r.has("다시 넣기"));
      endTurn(r);
      await r.g.channels.core.idle();
      await tick(50);
      r.g.manager.updateSession(r.sessionId, { archived: true });
      const before = r.texts().length;
      r.press("다시 넣기");
      await wait(() => r.texts().slice(before).some((line) => line.includes("이미 끝났습니다")));
      await r.g.channels.core.idle();
      await tick(100);
      const lines = r.texts().slice(before);
      expect(lines, JSON.stringify(lines)).toHaveLength(1);
      expect(lines[0]).toMatch(/이미 끝났습니다\. 필요하면 AI에게 .*다시 시켜 주세요\./);
      expect(r.g.store.getMeta(metaKey(r)) ?? "").not.toMatch(/"window":\{/);
    });
  }
});
