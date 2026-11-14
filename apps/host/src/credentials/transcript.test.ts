import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptItem, WorkbenchEvent } from "@workbench/contracts";
import { openKit, until } from "../channels/test-kit.ts";
import { formsOf } from "./forms.ts";
import { installScrubber } from "./install.ts";
import { TranscriptScrubber } from "./scrubber.ts";

// Every way conversation text leaves the engine adapters inside the gateway, with a stored value
// in it: the saved item (and so the search index and every later reader: exports, copies, the
// channel's answers, the devices' routes), the item published to screens, devices and the
// channel, the pieces of a streaming answer, the line under the conversation (activity) and its
// last error. Made-up values only.

const VALUE = "zz-secret-ab12cd34";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function kit(withScrubber: "values" | "empty" | "none" = "values") {
  const dir = mkdtempSync(join(tmpdir(), "wb-scrub-"));
  dirs.push(dir);
  const k = openKit(dir, { now: Date.now() });
  const scrubber = new TranscriptScrubber();
  if (withScrubber === "values") scrubber.set("e1", "학교 포털", [VALUE]);
  if (withScrubber !== "none") installScrubber(k.store, k.manager, scrubber);
  const events: WorkbenchEvent[] = [];
  k.bus.subscribe((event) => { events.push(event); });
  const work = k.manager.createWork({ title: "연구", titleSource: "user" });
  const session = k.manager.createSession(work.id, { provider: "claude", access: "full" });
  return { ...k, dir, scrubber, events, session };
}

/** Every byte of the data folder (database, its write-ahead log, the search index in it, logs). */
function folder(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) out += readFileSync(join(entry.parentPath, entry.name)).toString("latin1") + readFileSync(join(entry.parentPath, entry.name)).toString("utf8");
  return out;
}
const leaks = (text: string) => formsOf(VALUE).filter((form) => text.includes(form));

describe("the scrubber on the conversation's paths", () => {
  it("hides a value in an answer before it is saved, indexed and published", async () => {
    const k = kit();
    await k.manager.send(k.session.id, "r1", "포털에서 성적 받아 줘");
    k.engine.say(k.session.id, `로그인에 ${VALUE}를 썼습니다. 성적표를 받았습니다.`);
    k.engine.finish(k.session.id);
    const items = k.manager.items(k.session.id).items;
    expect(JSON.stringify(items)).toContain("[비밀: 학교 포털]");
    expect(leaks(JSON.stringify(items))).toEqual([]);
    expect(leaks(JSON.stringify(k.store.items(k.session.id)))).toEqual([]);
    expect(leaks(JSON.stringify(k.events))).toEqual([]);
    // The answer was indexed (its words are found), without the value.
    const indexed = k.store.search.cached({}).map((row) => row.body).join("\n");
    expect(indexed).toContain("성적표");
    expect(indexed).toContain("[비밀: 학교 포털]");
    expect(leaks(indexed)).toEqual([]);
    await k.manager.shutdown();
    k.store.close();
    expect(leaks(folder(k.dir))).toEqual([]);
  });

  it("hides a value split across the pieces of a streaming answer, in every piece and in what is kept", async () => {
    const k = kit();
    await k.manager.send(k.session.id, "r1", "보여 줘");
    const id = "stream-1";
    k.manager.sink.upsertItem(k.session.id, { kind: "assistant", id, text: "", streaming: true, at: Date.now() });
    for (const piece of ["값: ", VALUE.slice(0, 7), VALUE.slice(7, 13), `${VALUE.slice(13)} 입니다`]) k.manager.sink.delta(k.session.id, id, piece);
    const pieces = k.events.flatMap((event) => (event.type === "item.delta" ? [event.textDelta] : []));
    expect(leaks(pieces.join(""))).toEqual([]);
    expect(pieces.join("")).not.toContain(VALUE.slice(0, 7));
    // Held back, not lost: what the conversation shows now, and after the turn ends, has the label.
    k.engine.finish(k.session.id);
    const shown = k.manager.items(k.session.id).items.find((item) => item.id === id) as Extract<TranscriptItem, { kind: "assistant" }>;
    expect(shown.text).toBe("값: [비밀: 학교 포털] 입니다");
    expect(leaks(JSON.stringify(k.events))).toEqual([]);
    await k.manager.shutdown();
    k.store.close();
    expect(leaks(folder(k.dir))).toEqual([]);
  });

  it("hides a value in a command, its output, the activity line and the last error", async () => {
    const k = kit();
    await k.manager.send(k.session.id, "r1", "올려 줘");
    k.manager.sink.upsertItem(k.session.id, { kind: "tool", id: "t1", tool: "command", title: `curl -u me:${VALUE} https://x`, status: "running", at: Date.now() } as TranscriptItem);
    k.engine.doing(k.session.id, `curl -u me:${VALUE}`);
    k.manager.sink.updateSession(k.session.id, { lastError: `401 for ${VALUE}` });
    k.engine.finish(k.session.id);
    expect(leaks(JSON.stringify(k.manager.snapshot().sessions))).toEqual([]);
    expect(leaks(JSON.stringify(k.events))).toEqual([]);
    expect(leaks(JSON.stringify(k.manager.items(k.session.id).items))).toEqual([]);
  });

  it("hides a value the person typed at the PC, and one in items written straight to the store (a copy, an import)", async () => {
    const k = kit();
    await k.manager.send(k.session.id, "r1", `비밀번호는 ${VALUE} 입니다`);
    expect(leaks(JSON.stringify(k.manager.items(k.session.id).items))).toEqual([]);
    k.store.saveItem(k.session.id, { kind: "assistant", id: "imported", text: `가져온 기록: ${VALUE}`, streaming: false, at: 1 });
    expect(leaks(JSON.stringify(k.store.items(k.session.id)))).toEqual([]);
  });

  it("with nothing stored, passes the very same items and pieces through", async () => {
    for (const mode of ["empty", "none"] as const) {
      const k = kit(mode);
      await k.manager.send(k.session.id, "r1", "그대로");
      const item: TranscriptItem = { kind: "assistant", id: "same", text: `글 ${VALUE}`, streaming: true, at: 7 };
      k.manager.sink.upsertItem(k.session.id, item);
      k.manager.sink.delta(k.session.id, "same", " 조각");
      const published = k.events.flatMap((event) => (event.type === "item.upserted" && event.item.id === "same" ? [event.item] : []));
      expect(published[0]).toBe(item);
      expect(k.events.findLast((event) => event.type === "item.delta")).toMatchObject({ textDelta: " 조각" });
      expect(JSON.stringify(k.store.items(k.session.id).find((entry) => entry.id === "same"))).toBe(JSON.stringify(item));
    }
  });
});

// Fix round 1 (review C1, I1, I2, I3): what is kept is whole; only the live copy may wait, and only
// for a tail that could begin a stored value; ordinary text, ids and paths are left alone.
const SHORT = "zz-secret-q1w2e3r4t5"; // 20 characters
const LONG = `zz-${"k".repeat(60)}${"Q9".repeat(28)}`.slice(0, 120); // a 120-character key
function kitWith(values: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "wb-scrub-"));
  dirs.push(dir);
  const k = openKit(dir, { now: Date.now() });
  const scrubber = new TranscriptScrubber();
  values.forEach((value, index) => scrubber.set(`e${index}`, `값${index}`, [value]));
  installScrubber(k.store, k.manager, scrubber);
  const events: WorkbenchEvent[] = [];
  k.bus.subscribe((event) => { events.push(event); });
  const work = k.manager.createWork({ title: "연구", titleSource: "user" });
  const session = k.manager.createSession(work.id, { provider: "claude", access: "full" });
  return { ...k, dir, scrubber, events, session };
}
const ordinary = (length: number) => Array.from({ length }, (_, index) => "가나다라 마바사 아자차 카타파하 "[index % 18]).join("");
const kept = (k: ReturnType<typeof kitWith>, id: string) => k.manager.items(k.session.id).items.find((item) => item.id === id) as { text?: string; output?: string } | undefined;
const savedRow = (k: ReturnType<typeof kitWith>, id: string) => k.store.items(k.session.id).find((item) => item.id === id) as { text?: string; output?: string } | undefined;

describe("fix round 1: nothing is lost, nothing waits that need not", () => {
  it("keeps a thinking block whole (first piece upserted, the rest as pieces) with an 18- and a 120-character value stored", async () => {
    const k = kitWith([SHORT.slice(0, 18), LONG]);
    await k.manager.send(k.session.id, "r1", "생각해 줘");
    const text = ordinary(255);
    k.manager.sink.upsertItem(k.session.id, { kind: "reasoning", id: "think", text: text.slice(0, 40), at: 1 });
    for (let at = 40; at < text.length; at += 17) k.manager.sink.delta(k.session.id, "think", text.slice(at, at + 17));
    expect(kept(k, "think")!.text).toBe(text);
    k.engine.finish(k.session.id);
    expect(kept(k, "think")!.text).toBe(text);
    // Pieces reach SQLite in batches (every half second, as before).
    await new Promise((done) => setTimeout(done, 600));
    expect(savedRow(k, "think")!.text).toBe(text);
    // And what the screens got ends whole too.
    const last = k.events.findLast((event) => event.type === "item.upserted" && event.item.id === "think");
    const shown = (last?.type === "item.upserted" ? (last.item as { text: string }).text : "") + k.events.filter((event) => event.type === "item.delta" && event.itemId === "think" && k.events.indexOf(event) > k.events.indexOf(last!)).map((event) => (event as { textDelta: string }).textDelta).join("");
    expect(shown).toBe(text);
  });

  it("keeps an interrupted streaming answer (a document AI's) and a running command's output whole, also in SQLite while they run", async () => {
    const k = kitWith([LONG]);
    await k.manager.send(k.session.id, "r1", "문서 고쳐 줘");
    const answer = ordinary(450), output = ordinary(600);
    k.manager.sink.upsertItem(k.session.id, { kind: "assistant", id: "office-answer", text: answer, streaming: true, at: 1 });
    k.manager.sink.upsertItem(k.session.id, { kind: "tool", id: "cmd", tool: "command", title: "make", detail: null, output, status: "running", at: 1 });
    expect(savedRow(k, "office-answer")!.text).toBe(answer);
    expect(savedRow(k, "cmd")!.output).toBe(output);
    await k.manager.interrupt(k.session.id);
    expect(kept(k, "office-answer")!.text).toBe(answer);
    expect(kept(k, "cmd")!.output).toBe(output);
  });

  it("with a 120-character key stored, broadcasts a streaming answer piece by piece without delay", async () => {
    const k = kitWith([LONG]);
    await k.manager.send(k.session.id, "r1", "답해 줘");
    k.manager.sink.upsertItem(k.session.id, { kind: "assistant", id: "a", text: "", streaming: true, at: 1 });
    const pieces = ["첫 줄입니다. ", "둘째 줄, ", "셋째 줄", " 끝."];
    for (const piece of pieces) k.manager.sink.delta(k.session.id, "a", piece);
    expect(k.events.filter((event) => event.type === "item.delta").map((event) => (event as { textDelta: string }).textDelta)).toEqual(pieces);
  });

  it("holds back only a tail that begins a stored value, and sends it when the turn ends", async () => {
    const k = kitWith([SHORT]);
    await k.manager.send(k.session.id, "r1", "답해 줘");
    k.manager.sink.upsertItem(k.session.id, { kind: "assistant", id: "a", text: "", streaming: true, at: 1 });
    k.manager.sink.delta(k.session.id, "a", `값은 ${SHORT.slice(0, 9)}`);
    const live = k.events.filter((event) => event.type === "item.delta").map((event) => (event as { textDelta: string }).textDelta).join("");
    expect(live).toBe("값은 ");
    expect(kept(k, "a")!.text).toBe(`값은 ${SHORT.slice(0, 9)}`);
    k.engine.finish(k.session.id);
    const last = k.events.findLast((event) => event.type === "item.upserted" && event.item.id === "a");
    expect((last as { item: { text: string } }).item.text).toBe(`값은 ${SHORT.slice(0, 9)}`);
  });

  it("does not touch a number inside a longer number, ids or tracked paths (a secret inside a longer word is hidden: round 2, N2)", async () => {
    const k = kitWith(["20261113", "hongkildong"]);
    await k.manager.send(k.session.id, "r1", "보여 줘");
    k.engine.say(k.session.id, "전화 0102026111356, 학번 20261113, 사용자 hongkildongs 와 hongkildong.");
    k.manager.sink.upsertItem(k.session.id, { kind: "tool", id: "t-hongkildong", tool: "fileChange", title: "write", detail: "/home/hongkildong/a.md", output: null, status: "completed", paths: ["/home/hongkildong/a.md"], at: 1 } as TranscriptItem);
    const answer = k.manager.items(k.session.id).items.find((item) => item.kind === "assistant") as { text: string };
    expect(answer.text).toBe("전화 0102026111356, 학번 [비밀: 값0], 사용자 [비밀: 값1]s 와 [비밀: 값1].");
    const tool = kept(k, "t-hongkildong") as unknown as { paths: string[]; detail: string; id: string };
    expect(tool.paths).toEqual(["/home/hongkildong/a.md"]);
    expect(tool.id).toBe("t-hongkildong");
    expect(tool.detail).toBe("/home/[비밀: 값1]/a.md");
  });

  it("hides values in what sub-agents show; a request typed at the PC that waits is the person's draft, shown as typed (R6, fix round 3)", async () => {
    const k = kitWith([SHORT]);
    await k.manager.send(k.session.id, "r1", "일 해 줘");
    // As the PC's composer sends it (marked as the person's own, fix round 4).
    await k.manager.send(k.session.id, "r2", `다음엔 ${SHORT} 로 로그인`, [], null, null, "queue", { draft: true });
    expect(k.manager.snapshot().sessions.find((session) => session.id === k.session.id)!.queued.map((entry) => entry.text)).toEqual([`다음엔 ${SHORT} 로 로그인`]);
    expect(k.events.some((event) => event.type === "session.upserted" && event.session.queued.some((entry) => entry.text === `다음엔 ${SHORT} 로 로그인`))).toBe(true);
    const saved = k.manager.tasks.scrub!([{ preview: `하위 작업이 ${SHORT} 를 썼습니다`, title: "하위" }]);
    expect(leaksOf(JSON.stringify(saved), SHORT)).toEqual([]);
    // What goes to the engine is what the person typed.
    k.engine.finish(k.session.id);
    await until(() => k.engine.sent.length === 2);
  });
});
const leaksOf = (text: string, value: string) => formsOf(value).filter((form) => text.includes(form));
