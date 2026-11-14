// Transcript A of the design (m02 §6.6) without the browser, on the bundled gateway
// (apps/host/dist/host.mjs), the stand-in Bot API on 127.0.0.1, the stand-in keyring and the
// repository's stand-in Claude (no model): the AI calls `workbench-credential need` → one message in
// the chat → the person gives the two fields by send-and-delete → each message is deleted → the
// entry is kept sealed → one continuation request → the AI's next turn gets `ok`. Then every byte
// of the data folder (database and its log, inbox, record, search index, logs, spool, store) and
// everything the stand-in Telegram received is searched for every form of the values, after
// showing that the search finds a planted one. The values are random and never printed.
//
// Usage (through ux/run-isolated.sh): node scripts/credential-smoke.ts   (build the host bundle first)

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelsState, Snapshot, TranscriptItem } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";
import { formsOf } from "../apps/host/src/credentials/forms.ts";

const ID = `zz-secret-${randomBytes(8).toString("base64url")}`;
const PASSWORD = `zz-secret-${randomBytes(8).toString("base64url")}`;
// Round 1: a key given by replying to the hand-over message, a value retried after a failed store, a value after the input ran out.
const KEY = `zz-secret-${randomBytes(12).toString("base64url")}`;
const TOO_LONG = `zz-secret-${randomBytes(2600).toString("hex")}`;
const RETRIED = `zz-secret-${randomBytes(8).toString("base64url")}`;
const LATE = `zz-secret-${randomBytes(8).toString("base64url")}`;
const AT_PC = `zz-secret-${randomBytes(8).toString("base64url")}`;
const RESUMED = `zz-secret-${randomBytes(8).toString("base64url")}`;
const CUT = `zz-secret-${randomBytes(8).toString("base64url")}`;
const DRAFT = `zz-secret-${randomBytes(8).toString("base64url")}`;
const DRAFT_TEXT = `다음엔 ${DRAFT} 로 들어가 봐`;
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const wait = async (what: string, test: () => boolean | Promise<boolean>, ms = 60_000) => {
  const start = Date.now();
  while (!(await test())) {
    if (Date.now() - start > ms) { check(false, `${what} (timed out)`); return false; }
    await new Promise((done) => setTimeout(done, 100));
  }
  return true;
};

const dataDir = mkdtempSync(join(tmpdir(), "workbench-credential-smoke-"));
const fake = new FakeTelegram();
await fake.start();
const output: string[] = [];
const child = spawn(process.execPath, [process.env.SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_TELEGRAM_API: fake.url, WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr!.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
  child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code})`)));
  createInterface({ input: child.stdout! }).on("line", (line) => { output.push(line); if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
});
console.log(`gateway pid ${child.pid}`);
// Whatever happens to this script, its gateway does not outlive it.
process.on("exit", () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  output.push(text);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return JSON.parse(text) as T;
};
const deleted = (update: Record<string, unknown>) => fake.of("deleteMessage").filter((call) => call.params.message_id === (update.message as { message_id: number }).message_id).length;

let sessionId = "";
let live = "", liveFiles: string[] = [];
try {
  // Register and pair, as the PC screen and the phone do.
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  const { link } = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${fake.botId}/pairing`, {});
  fake.message(`/start ${new URL(link).searchParams.get("start")}`);
  await wait("the phone's pairing request reaches the PC", async () => Boolean((await api<ChannelsState>("GET", "/api/channels")).bots[0]?.pairing.request));
  const request = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.pairing.request!;
  await api("POST", `/api/channels/telegram/bots/${fake.botId}/pairing/${request.id}`, { approve: true });

  // The person asks; the (stand-in) AI meets a login and asks for it, then ends its turn.
  fake.message("학술정보원 사이트에서 내 대출 목록 받아서 반납일 순으로 정리해 줘. 비밀 필요: need --name 학술정보원 --kind login --site lib.example.ac.kr --fields 아이디,비밀번호");
  await wait("one hand-over message in the chat", () => fake.texts().some((text) => text.includes("'학술정보원' 로그인 정보가 필요합니다")));
  check(fake.texts().filter((text) => text.includes("'학술정보원' 로그인 정보가 필요합니다")).length === 1, "the hand-over is one message");
  check(fake.buttonData("나중에").length > 0, "with the one control (나중에); the input is already open");
  const snapshot = await api<Snapshot>("GET", "/api/snapshot");
  sessionId = snapshot.sessions.find((session) => session.purpose.startsWith("휴대폰"))!.id;
  await wait("the AI's first turn ends", async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items.some((item) => item.kind === "turnEnd"));
  const first = (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items;
  check(first.some((item) => item.kind === "assistant" && item.text.includes("workbench-credential: fail:handover_sent")), "the AI got fail:handover_sent");

  // The input opened with the hand-over message (R4): the person just sends the two fields, each deleted.
  check(fake.texts().some((text) => text.includes("다음에 보내는 메시지를 '학술정보원'의 아이디로 받습니다.") && text.includes("이 값은 텔레그램을 거쳐 옵니다. 받는 즉시 지웁니다.")), "the hand-over message opens the input for 아이디, with the notice");
  const one = fake.message(ID);
  await wait("the 아이디 message is deleted", () => deleted(one) === 1);
  await wait("아이디 is confirmed by name, and 비밀번호 asked for", () => fake.texts().some((text) => text.startsWith("'학술정보원'의 아이디를 받았습니다") && text.includes("비밀번호로 받습니다")));
  const two = fake.message(PASSWORD);
  await wait("the 비밀번호 message is deleted", () => deleted(two) === 1);
  await wait("the chat is told it is kept", () => fake.texts().some((text) => text.startsWith("'학술정보원'의 비밀번호를 받았습니다. 보관함에 봉인해 두었고 이 채팅에서는 지웠습니다.")));
  const kept = await api<{ entries: { name: string; held: string }[] }>("GET", "/api/channels/credentials");
  check(kept.entries.some((entry) => entry.name === "학술정보원" && entry.held === "sealed"), "the entry is kept, sealed");

  // One continuation; the AI's next turn sees ok; its answer comes to the chat.
  await wait("the continuation's turn ends with ok", async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items.some((item) => item.kind === "assistant" && item.text.includes("workbench-credential: ok")), 90_000);
  const items = (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items;
  const continuations = items.filter((item) => item.kind === "user" && item.id.startsWith("user:cont:"));
  check(continuations.length === 1, "one continuation request (cont:<handoffId>)");
  check(continuations[0]?.kind === "user" && continuations[0].text === "[자동 이어 하기] '학술정보원'가 준비되었습니다. 멈춘 곳에서 이어 하세요." && Boolean(continuations[0].origin), "with the fixed words, from the chat");
  await wait("the continuation's answer reaches the chat", () => fake.texts().some((text) => text.includes("workbench-credential: ok")), 90_000);
  // R4: a reply to the hand-over message is the value, also after 나중에 closed the input.
  fake.message("노션 연구 노트 목록을 정리해 줘. 비밀 필요: need --name 노션키 --kind api-key --site notion.so --fields 키");
  await wait("a second hand-over", () => fake.texts().some((text) => text.includes("'노션키' API 키가 필요합니다")), 90_000);
  const asked = fake.of("sendMessage").findLast((call) => String(call.params.text).includes("'노션키' API 키가 필요합니다"))!;
  (() => { const button = fake.button("나중에"); fake.press(button.data, { messageId: button.messageId }); })();
  // Fix round 4 (P1): the input's one ending line says it closed and how to give it later.
  await wait("나중에 closes the input", () => fake.texts().some((text) => text.includes("입력을 닫았습니다") && text.includes("나중에 넣으려면")));
  const replied = fake.message(KEY, { extra: { reply_to_message: { message_id: fake.sentIdOf(asked) } } });
  await wait("a reply to the hand-over message is taken and deleted", () => deleted(replied) === 1);
  await wait("and kept", async () => (await api<{ entries: { name: string }[] }>("GET", "/api/channels/credentials")).entries.some((entry) => entry.name === "노션키"));
  // C3: a field that fails to store is asked for again at that field; the retry is kept.
  fake.message("카드도 넣어 둬. 비밀 필요: need --name 카드1 --kind other --fields 값");
  await wait("a third hand-over", () => fake.texts().some((text) => text.includes("'카드1' 값이 필요합니다")), 90_000);
  const failed = fake.message(TOO_LONG);
  await wait("a value that cannot be kept is deleted and said", () => deleted(failed) === 1 && fake.texts().some((text) => text.startsWith("받은 값을 저장하지 못했습니다")));
  const retried = fake.message(RETRIED);
  await wait("the retry is kept as that field", async () => deleted(retried) === 1 && (await api<{ entries: { name: string }[] }>("GET", "/api/channels/credentials")).entries.some((entry) => entry.name === "카드1"));
  // C2: a value sent after the input ran out is deleted, not kept, not passed on.
  fake.message("하나 더. 비밀 필요: need --name 도서관2 --kind other --fields 값");
  await wait("a fourth hand-over", () => fake.texts().some((text) => text.includes("'도서관2' 값이 필요합니다")), 90_000);
  const db = new DatabaseSync(join(dataDir, "state.sqlite"));
  const key = `channel.secret:telegram:${fake.botId}:555`;
  const window = JSON.parse(String(db.prepare("SELECT value FROM meta WHERE key = ?").get(key)!.value)) as { window: { expiresAt: number } };
  window.window.expiresAt = Date.now() - 1_000;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(window), key);
  db.close();
  const late = fake.message(LATE);
  // Fix round 4 (P1, P2): it found the input ended before the chat was told: deleted, answered with [그대로 보내기]; the ending is said.
  await wait("a value after the input ran out is deleted and said", () => deleted(late) === 1 && fake.texts().some((text) => text.startsWith("입력이 닫힌 것을 알리기 전에 온 글이라")) && fake.texts().some((text) => text.startsWith("입력 시간(10분)이 지나 '도서관2' 값 입력을 닫았습니다")));
  check(!(await api<{ entries: { name: string }[] }>("GET", "/api/channels/credentials")).entries.some((entry) => entry.name === "도서관2"), "the late value is not kept");
  // N3: the value is added at the PC while the chat's input is open: the next chat line is an ordinary request.
  fake.message("메일함도 봐 줘. 비밀 필요: need --name 피시값 --kind other --fields 값");
  await wait("a fifth hand-over, its input open", () => fake.texts().some((text) => text.includes("'피시값' 값이 필요합니다") && text.includes("다음에 보내는 메시지를")), 90_000);
  await api("POST", "/api/channels/credentials", { name: "피시값", kind: "other", site: "", values: { 값: AT_PC } });
  await wait("the chat is told it was added at the PC", () => fake.texts().some((text) => text.startsWith("PC에서 '피시값'을 넣었습니다")));
  const ordinary = fake.message("고마워, 이제 받은편지함 제목만 알려 줘");
  await wait("the next chat line is an ordinary request to the AI", async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items.some((item) => item.kind === "user" && item.text === "고마워, 이제 받은편지함 제목만 알려 줘"), 90_000);
  check(deleted(ordinary) === 0, "and it was not deleted");
  // N4: a hand-over while the chat is paused: nothing opens, nothing typed is deleted, its message comes at resume, once.
  const bindingId = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.bindings[0]!.id;
  await wait("the AI's turns are over", async () => !(await api<Snapshot>("GET", "/api/snapshot")).sessions.find((session) => session.id === sessionId)!.queued.length && (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items.at(-1)?.kind === "turnEnd", 90_000);
  await api("PATCH", `/api/channels/bindings/${bindingId}`, { paused: true });
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId: "smoke-paused-ask", text: "학교 메일 정리. 비밀 필요: need --name 학교메일 --kind other --fields 값" });
  await wait("the hand-over waits at the PC", async () => (await api<{ waiting: { name: string }[] }>("GET", "/api/channels/credentials")).waiting.some((handoff) => handoff.name === "학교메일"), 90_000);
  check(!fake.texts().some((text) => text.includes("'학교메일' 값이 필요합니다")), "nothing is asked in the paused chat");
  const told = fake.texts().filter((text) => text === "지금은 PC에서 채널을 멈춰 두었습니다.").length;
  const meanwhile = fake.message("멈춘 동안 보낸 글");
  await wait("a line sent while paused is answered as before", () => fake.texts().filter((text) => text === "지금은 PC에서 채널을 멈춰 두었습니다.").length > told);
  check(deleted(meanwhile) === 0, "and not deleted");
  await api("PATCH", `/api/channels/bindings/${bindingId}`, { paused: false });
  await wait("at resume the hand-over message comes, with its input", () => fake.texts().some((text) => text.includes("'학교메일' 값이 필요합니다") && text.includes("다음에 보내는 메시지를")));
  const resumed = fake.message(RESUMED);
  await wait("the value is taken, deleted and kept", async () => deleted(resumed) === 1 && (await api<{ entries: { name: string }[] }>("GET", "/api/channels/credentials")).entries.some((entry) => entry.name === "학교메일"));
  check(fake.texts().filter((text) => text.includes("'학교메일' 값이 필요합니다")).length === 1, "the hand-over message came once");
  // N6: the stand-in Bot API applies the hand-over message and drops the connection before answering.
  const idle = async () => !(await api<Snapshot>("GET", "/api/snapshot")).sessions.find((session) => session.id === sessionId)!.queued.length && (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items.at(-1)?.kind === "turnEnd";
  await wait("the AI's turns are over (before N6)", idle, 90_000);
  fake.nextSend = ["cut-after"];
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId: "smoke-cut", text: "드라이브 정리. 비밀 필요: need --name 끊긴키 --kind other --fields 값" });
  await wait("the hand-over message reached the chat, its answer lost", () => fake.texts().some((text) => text.includes("'끊긴키' 값이 필요합니다")), 90_000);
  check(fake.nextSend.length === 0, "the connection was dropped right after the hand-over message was applied");
  const cut = fake.message(CUT);
  await wait("the value sent then is taken as the value and deleted", () => deleted(cut) === 1, 90_000);
  await wait("and kept", async () => (await api<{ entries: { name: string }[] }>("GET", "/api/channels/credentials")).entries.some((entry) => entry.name === "끊긴키"));
  check(fake.texts().filter((text) => text.includes("'끊긴키' 값이 필요합니다") && text.includes("다음에 보내는 메시지를")).length === 1, "the hand-over message was sent once");
  // The confirmation is sent after the value is kept: give it a moment rather than look once.
  const restated = () => fake.texts().some((text) => text.startsWith("'끊긴키'의 값으로 받았습니다 · 요청:"));
  for (let tries = 0; tries < 100 && !restated(); tries += 1) await new Promise((done) => setTimeout(done, 100));
  check(restated(), "taken while its id was unknown, the confirmation restates the request");
  // R6: a request typed at the PC while the conversation is busy is the person's draft: listed as typed
  // at the PC, counted (never shown) in the chat, and hidden once it is a transcript item.
  await wait("the AI's turns are over (before the draft)", idle, 90_000);
  await api("POST", "/api/channels/credentials", { name: "초안값", kind: "other", site: "", values: { 값: DRAFT } });
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId: "smoke-long", text: "길게 설명해 줘" });
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId: "smoke-draft", text: DRAFT_TEXT, mode: "queue" });
  const pcQueue = (await api<Snapshot>("GET", "/api/snapshot")).sessions.find((session) => session.id === sessionId)!.queued;
  check(pcQueue.some((entry) => entry.text === DRAFT_TEXT), "the PC lists the draft exactly as typed");
  const states = fake.texts().filter((text) => text.startsWith("지금:")).length;
  fake.message("상태");
  await wait("the chat's 상태 answers", () => fake.texts().filter((text) => text.startsWith("지금:")).length > states);
  check(fake.texts().filter((text) => text.startsWith("지금:")).at(-1)!.includes("기다리는 요청 1개"), "the chat hears that one request waits, not what it says");
  await wait("the draft is sent", async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items.some((item) => item.id === "user:smoke-draft"), 90_000);
  const draftItem = (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items.find((item) => item.id === "user:smoke-draft")!;
  check(draftItem.kind === "user" && draftItem.text === "다음엔 [비밀: 초안값] 로 들어가 봐", "once sent, the transcript carries the placeholder");
  const audit = await api<{ rows: { action: string }[] }>("GET", "/api/channels/audit");
  check(["secret.asked", "secret.received"].every((action) => audit.rows.some((row) => row.action === action)), "the record says the secret was asked for and received");
} catch (error) {
  check(false, `smoke stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // Also while the gateway still runs: its write-ahead log (state.sqlite-wal) is still a file of its own then.
  try {
    liveFiles = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dataDir.length + 1));
    live = folder();
  } catch (error) {
    check(false, `the live search stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
  const code = child.exitCode ?? child.signalCode ?? await new Promise((done) => { child.once("exit", done); child.kill("SIGTERM"); });
  console.log(`gateway pid ${child.pid} exited (${String(code)})`);
  await fake.stop();
}

// Nowhere: every byte of the data folder, everything the stand-in Telegram was sent, the gateway's own output and answers.
function folder(): string {
  let all = "";
  for (const entry of readdirSync(dataDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let bytes: Buffer;
    // While the gateway runs, a spool answer can go between listing and reading it.
    try { bytes = readFileSync(join(entry.parentPath, entry.name)); } catch { continue; }
    all += bytes.toString("latin1") + bytes.toString("utf8");
  }
  return all;
}
const sent = JSON.stringify(fake.calls.filter((call) => call.method !== "getUpdates"));
const fileNames = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dataDir.length + 1));
const files = fileNames.length;
console.log(`while running, searched: ${liveFiles.filter((name) => /sqlite/.test(name)).join(", ")}`);
console.log(`searched files: ${fileNames.filter((name) => /sqlite|store\.json|channel\.log|spool/.test(name)).join(", ")} and ${files} files in all`);
for (const [label, value] of [["아이디", ID], ["비밀번호", PASSWORD], ["키 (답장)", KEY], ["저장하지 못한 값", TOO_LONG], ["다시 넣은 값", RETRIED], ["늦은 값", LATE], ["PC에서 넣은 값", AT_PC], ["다시 열린 뒤 넣은 값", RESUMED], ["답이 끊긴 뒤 넣은 값", CUT]] as const) {
  const forms = formsOf(value);
  check(!forms.some((form) => folder().includes(form)), `no form of the ${label} in the data folder (${files} files)`);
  check(!forms.some((form) => live.includes(form)), `no form of the ${label} in the data folder while the gateway ran (${liveFiles.length} files, WAL included)`);
  check(!forms.some((form) => sent.includes(form)), `no form of the ${label} in anything sent to Telegram`);
  check(!forms.some((form) => output.join("\n").includes(form)), `no form of the ${label} in the gateway's output or HTTP answers`);
}
// The draft (R6): it is expected, as typed, in exactly one place, the queue of its session row
// (sessions.json -> queued[].text) until it is sent, and in the PC's own HTTP answers. Searched:
// every other row of every table of state.sqlite (the item, the index), every other file, the chat.
{
  const forms = formsOf(DRAFT);
  const db = new DatabaseSync(join(dataDir, "state.sqlite"), { readOnly: true });
  let rows = "";
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Record<string, unknown>[]) {
      if (name === "sessions") {
        const session = JSON.parse(String(row.json)) as { queued: { text: string }[] };
        rows += JSON.stringify({ ...row, json: { ...session, queued: session.queued.map((entry) => ({ ...entry, text: "" })) } });
      } else rows += JSON.stringify(row, (_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value));
    }
  }
  db.close();
  let others = "";
  for (const entry of readdirSync(dataDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || /^state\.sqlite/.test(entry.name)) continue;
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    others += bytes.toString("latin1") + bytes.toString("utf8");
  }
  check(!forms.some((form) => rows.includes(form)), "no form of the draft's value in any row of state.sqlite but its session's queue (items and index included)");
  check(!forms.some((form) => others.includes(form)), "no form of the draft's value in any other file of the data folder");
  check(!forms.some((form) => sent.includes(form)), "no form of the draft's value in anything sent to Telegram");
  const pages = ["state.sqlite", "state.sqlite-wal"].map((name) => { try { return readFileSync(join(dataDir, name)).toString("latin1"); } catch { return ""; } }).join("");
  console.log(`note: the draft's bytes in SQLite's own pages (the queue row's earlier versions, not yet overwritten): ${forms.some((form) => pages.includes(form)) ? "present" : "absent"}`);
}
writeFileSync(join(dataDir, "planted"), `x ${encodeURIComponent(PASSWORD)} y`);
check(formsOf(PASSWORD).some((form) => folder().includes(form)), "the same search finds a planted value");
rmSync(dataDir, { recursive: true, force: true });
console.log(`stand-in Bot API calls: ${fake.calls.length} (${[...new Set(fake.calls.map((call) => call.method))].join(", ")})`);
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
