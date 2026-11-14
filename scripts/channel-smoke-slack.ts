// The phone's ten common conversations (design m02 §5.7) driven end to end against the bundled
// gateway over Slack: a stand-in Slack on 127.0.0.1 (Web API + Socket Mode) plays the person, the
// repository's stand-in engines play Claude and Codex (no model), a stand-in keyring seals the two
// tokens. The same conversations as scripts/channel-smoke.ts drives over Telegram (the Telegram one
// reads Bot API calls, this one Slack's, so the scenario is written again rather than shared), plus
// what is Slack's own: an envelope delivered again, a socket dropped in the middle of an event, a
// refresh, and what was written while the gateway was off. Nothing here contacts Slack.
//
// Usage (from the repository, through ux/run-isolated.sh, after `npm run build -w @workbench/host`):
//   node scripts/channel-smoke-slack.ts
// Prints one PASS/FAIL line per check and exits 1 when any failed. The gateway is stopped by its PID.

import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelPairingLink, ChannelsState, Schedule, Snapshot } from "@workbench/contracts";
import { FAKE_APP_TOKEN, FAKE_BOT_TOKEN, FakeSlack } from "../apps/host/src/channels/fake-slack.ts";

const dataDir = mkdtempSync(join(tmpdir(), "workbench-channel-smoke-slack-"));
const fake = new FakeSlack();
await fake.start();

type Gateway = { child: ChildProcess; ready: { url: string; token: string }; stderr: () => string };
async function launch(): Promise<Gateway> {
  const child = spawn(process.execPath, [process.env.CHANNEL_SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_HOST_LABEL: "노트북",
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
      WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      WORKBENCH_SLACK_API: fake.url,
      WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
      FAKE_SECRET_OFF: join(dataDir, "keyring-off"),
      WORKBENCH_SCHEDULE_TICK_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
  });
  console.log(`gateway pid ${child.pid} on ${new URL(ready.url).host}`);
  return { child, ready, stderr: () => stderr };
}
async function stop(gateway: Gateway) {
  if (gateway.child.exitCode !== null) return gateway.child.exitCode;
  gateway.child.kill("SIGTERM");
  const code = await new Promise<number | null>((done) => gateway.child.once("exit", (exit) => done(exit)));
  console.log(`gateway ${gateway.child.pid} exited ${code}`);
  return code;
}
let gateway = await launch();
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${gateway.ready.url}${path}`, { method, headers: { authorization: `Bearer ${gateway.ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
};

const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const wait = async (what: () => boolean | Promise<boolean>, ms = 30_000) => {
  const start = Date.now();
  while (!(await what())) {
    if (Date.now() - start > ms) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
  return true;
};
/** What the person reads, raw text as Slack got it (mrkdwn escapes undone for matching). */
const texts = () => fake.texts().map((text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
const textsSince = (count: number) => texts().slice(count);
const shown = (ts: string) => (fake.shown(ts) ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const has = (label: string) => { try { fake.button(label); return true; } catch { return false; } };
const press = (label: string) => { const button = fake.button(label); fake.press(button.value, { messageTs: button.ts }); return button.ts; };
const answered = (count: number, match: (text: string) => boolean, ms = 30_000) => wait(() => textsSince(count).some(match), ms);
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const state = () => api<ChannelsState>("GET", "/api/channels");
const sharedNames = () => fake.shared.map((entry) => entry.name);
/** A button on a message by a part of its label. */
const buttonOn = (ts: string, part: string) => {
  const message = fake.messages.find((entry) => entry.ts === ts)!;
  for (const block of message.blocks ?? []) for (const element of (block.elements ?? []) as { value: string; text: { text: string } }[]) if (element.text.text.includes(part)) return element.value;
  return null;
};

try {
  // Registration and pairing, as the PC screen does them.
  await api("POST", "/api/channels/slack/bots", { botToken: FAKE_BOT_TOKEN, appToken: FAKE_APP_TOKEN });
  check("registered and connected by Socket Mode", await wait(async () => (await state()).bots[0]?.status.state === "connected") && fake.open() === 1);
  // Outside the PC's pairing window the bare word is only the private line; inside it, it pairs.
  fake.message("연결");
  check("a bare 연결 outside the window is the private line", await wait(() => texts().includes("이 앱은 개인용입니다.")));
  const link = await api<ChannelPairingLink>("POST", `/api/channels/slack/bots/${fake.botId}/pairing`, {});
  fake.message("연결");
  await wait(async () => Boolean((await state()).bots[0]?.pairing.request));
  const request = (await state()).bots[0]!.pairing.request!;
  check("the bare 연결 got the digits in the DM", await wait(() => texts().at(-1) === `PC 화면에 같은 숫자가 보이면 PC에서 [연결]을 눌러 주세요: ${request.digits.split("").join(" ")}`, 5_000));
  await api("POST", `/api/channels/slack/bots/${fake.botId}/pairing/${request.id}`, { approve: true });
  check("pairing", await answered(0, (text) => text.startsWith("연결되었습니다")));
  await api("POST", "/api/works", { title: "연구계획서" });

  // 1. 그냥 시키기.
  let count = texts().length;
  const first = fake.message("어제 받은 학생 명단 엑셀에서 3학년만 뽑아서 따로 저장해 줘");
  check("1 status line", await answered(count, (text) => text === "작업 중 · 0:00"));
  // Slack delivers the same envelope again: it runs once.
  fake.redeliver(first.envelopeId!);
  check("1 answer", await answered(count, (text) => text.includes("답이 길어 앞부분만 보냈습니다"), 60_000));
  check("1 status edited to 끝남", fake.messages.some((message) => message.edited && /^끝남 · \d+:\d{2}$/.test(message.text)));
  // The file is shared after the answer's text: wait for it rather than look once.
  check("1 whole answer as .md", await wait(() => sharedNames().some((name) => name.endsWith(" 답.md"))), sharedNames().join(", "));
  const firstSession = (await snapshot()).sessions.find((session) => session.purpose.startsWith("휴대폰"))!;
  const firstUsers = (await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${firstSession.id}/items`)).items.filter((item) => item.kind === "user");
  check("1 a redelivered envelope ran once", firstUsers.length === 1, String(firstUsers.length));

  // 2. 문서 만들기.
  count = texts().length;
  let files = fake.shared.length;
  fake.message("견본 문서 만들어 줘");
  check("2 answer", await answered(count, (text) => !text.startsWith("작업 중") && !text.startsWith("대기열"), 60_000));
  await wait(() => fake.shared.length > files, 10_000);
  check("2 the made document attached", fake.shared.slice(files).some((entry) => entry.name === "슬라이드-구성.md"), sharedNames().join(", "));

  // 3. 사진을 보내며 시키기.
  count = texts().length;
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000031b0ec3a", "hex");
  fake.message("이거 표로 정리해 줘", { files: [fake.file("칠판.png", png, { mimetype: "image/png" })], subtype: "file_share" });
  check("3 picture reached the engine", await answered(count, (text) => text.includes("받은 그림 1장"), 60_000));

  // 4. 일하는 중 덧붙이기, 그리고 멈추기.
  count = texts().length;
  fake.message("논문 초록 세 편 요약해 줘");
  await answered(count, (text) => text === "작업 중 · 0:00");
  fake.message("아 그리고 각 요약 끝에 연구 방법도 한 줄씩");
  check("4 added while working", await answered(count, (text) => text === "(덧붙인 말을 지금 일에 넣었습니다)" || text.startsWith("대기열에 넣었습니다")), textsSince(count).join(" | "));
  fake.message("멈춰");
  check("4 stopped", await answered(count, (text) => text.startsWith("멈췄습니다")));
  check("4 stop offers 이어서 하기", await wait(() => has("이어서 하기"), 5_000));

  // 5. 음성: a Slack voice clip is not taken yet (unit 11); said, not dropped.
  count = texts().length;
  fake.message("", { files: [{ ...fake.file("audio_message.webm", Buffer.from("webm"), { mimetype: "audio/webm" }), subtype: "slack_audio" }], subtype: "file_share" });
  check("5 voice said not taken yet", await answered(count, (text) => text === "음성 메시지는 아직 받지 못합니다. 글로 적어 보내 주세요."));

  // 6. 대화·프로젝트 바꾸기, 새 대화: one menu message edited in place.
  count = texts().length;
  fake.message("메뉴");
  check("6 menu", await answered(count, (text) => text.startsWith("메뉴 · 지금:")));
  let posts = fake.of("chat.postMessage").length;
  const menuId = press("대화 바꾸기");
  await wait(() => shown(menuId).endsWith("의 최근 대화"));
  const value = buttonOn(menuId, firstSession.purpose);
  fake.press(value!, { messageTs: menuId });
  check("6 picked a conversation, in place", await wait(() => shown(menuId).startsWith("이제 「")) && fake.of("chat.postMessage").length === posts, shown(menuId));
  press("← 메뉴");
  await wait(() => shown(menuId).startsWith("메뉴 · 지금:"));
  press("새 대화");
  check("6 new conversation", await wait(() => shown(menuId).startsWith("새 대화를 만들었습니다")));

  // 7. 엔진·모델: another engine is a new conversation.
  press("← 메뉴");
  await wait(() => shown(menuId).startsWith("메뉴 · 지금:"));
  press("엔진·모델");
  await wait(() => shown(menuId).includes("지금: Claude"));
  press("Codex");
  check("7 Codex conversation", await wait(() => shown(menuId).startsWith("이 대화를 Codex로 바꿀 수 없어 Codex로 새 대화를 만들었습니다")), shown(menuId));
  count = texts().length;
  fake.message("코덱스로 한 줄 요약해 줘");
  check("7 the line went to Codex", await answered(count, (text) => !text.startsWith("작업 중") && text.length > 0, 60_000) && (await snapshot()).sessions.some((session) => session.provider === "codex" && session.status !== "error"));

  // 8. 문서의 AI에게 묻기 / 프로젝트 노트에 결정 남기기.
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu2 = press("최근 파일");
  await wait(() => shown(menu2).includes("최근 파일"));
  const doc = buttonOn(menu2, "슬라이드-구성.md");
  check("8 recent files list the made document", Boolean(doc), fake.labels(menu2).join(", "));
  if (doc) {
    fake.press(doc, { messageTs: menu2 });
    await wait(() => shown(menu2).startsWith("「슬라이드-구성.md」"));
    files = fake.shared.length;
    press("받기");
    check("8 받기 sends the file", await wait(() => fake.shared.length > files));
    press("이 문서의 AI에게");
    check("8 to the document's AI", await wait(() => shown(menu2).startsWith("이제 「슬라이드-구성」의 AI에게 보냅니다")), shown(menu2));
    count = texts().length;
    fake.message("2번 항목을 더 공손하게 고쳐 줘");
    check("8 the document's AI answers", await answered(count, (text) => !text.startsWith("작업 중") && !text.startsWith("이제"), 60_000));
    const pointer = (await state()).bots[0]!.bindings[0]!.pointerSessionId;
    check("8 the chat points at the document's AI", Boolean((await snapshot()).sessions.find((session) => session.id === pointer)?.documentAgent));
  }
  count = texts().length;
  fake.message("결정으로 적어 줘: 2차 심사는 12월 첫 주로");
  check("8 decision written to the note", await answered(count, (text) => /노트 '결정'에 추가했습니다\.$/.test(text)), textsSince(count).join(" | "));

  // 9. 찾기.
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu3 = press("찾기");
  await wait(() => shown(menu3) === "무엇을 찾을까요? (한 줄로 적어 주세요)");
  count = texts().length;
  fake.message("심사");
  const found = await answered(count, (text) => /^\d+건 · “심사”$/.test(text) || text.startsWith("찾은 것이 없습니다") || text.startsWith("찾지 못했습니다"));
  const unavailable = textsSince(count).some((text) => text.startsWith("찾지 못했습니다: Rust 검색 실행기가 없습니다"));
  if (unavailable) console.log("NOTE 9 search not available here (no search worker): the chat said so; not counted");
  else check("9 search answered", found, textsSince(count).join(" | "));

  // 10. 예약.
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu4 = press("예약");
  await wait(() => shown(menu4).startsWith("언제 할까요?"));
  press("매일 09:00");
  await wait(() => shown(menu4) === "무엇을 할까요? (매일 09:00 예약)");
  count = texts().length;
  fake.message("메일함 정리하고 오늘 일정 요약 보내 줘");
  check("10 scheduled", await answered(count, (text) => text.startsWith("예약했습니다: 매일 09:00")));
  const schedules = (await api<{ schedules: Schedule[] }>("GET", "/api/schedules")).schedules;
  check("10 the schedule carries the chat", schedules.some((schedule) => schedule.origin?.channel === "slack"));

  // Plan first.
  count = texts().length;
  fake.message("새 대화");
  await answered(count, (text) => text.startsWith("새 대화를 만들었습니다"));
  count = texts().length;
  fake.message("계획 먼저: 발표 자료 정리해 줘");
  const asked = await wait(() => has("진행"), 60_000);
  check("plan first offers 진행", asked, textsSince(count).join(" | "));
  if (asked) {
    press("진행");
    check("plan goes ahead", await answered(count, (text) => text.includes("계획대로 진행합니다") || text.includes("답이 길어"), 60_000), textsSince(count).slice(-2).join(" | "));
  }

  // Gates: a button of the chat pressed by someone else, a stranger, a channel.
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu5 = fake.button("새 대화");
  const ephemeral = fake.ephemeral.length;
  fake.press(menu5.value, { user: "U0KIM", channel: "D0HONG", messageTs: menu5.ts });
  check("someone else's press does nothing", await wait(() => fake.ephemeral.length > ephemeral) && fake.ephemeral.at(-1)!.text === "쓸 수 없는 버튼입니다" && !shown(menu5.ts).startsWith("새 대화를"));
  fake.message("내 일 해 줘", { user: "U0KIM" });
  check("a stranger is told the app is private, nothing runs", await wait(() => fake.texts("D0KIM").includes("이 앱은 개인용입니다.")));
  fake.message("채널에서 시킴", { channel: "C0ROOM", channelType: "channel" });
  await new Promise((done) => setTimeout(done, 500));
  check("a channel gets nothing", fake.texts("C0ROOM").length === 0);

  // A socket dropped in the middle of an event: the envelope comes again on the new socket, and runs once.
  count = texts().length;
  const opened = fake.of("apps.connections.open").length;
  const dropped = fake.message("끊긴 소켓 중에 보낸 요청");
  fake.dropAfter(dropped.envelopeId!);
  check("dropped socket: reconnected", await wait(() => fake.of("apps.connections.open").length > opened && fake.open() === 1));
  check("dropped socket: the request answered", await answered(count, (text) => !text.startsWith("작업 중") && !text.startsWith("대기열") && !text.startsWith("PC가"), 60_000));
  // Slack asks for a new connection: replaced at once.
  fake.refresh();
  check("refresh: a new socket", await wait(async () => fake.of("apps.connections.open").length > opened + 1 && (await state()).bots[0]!.status.state === "connected"));
  // A line sent while the socket was cut (never delivered on it): read from the history after the reconnect, run once.
  {
    const before = fake.of("apps.connections.open").length;
    fake.cut();
    fake.message("소켓이 끊긴 동안 보낸 요청", { deliver: false });
    await wait(() => fake.of("apps.connections.open").length > before && fake.open() === 1);
    let ran = 0;
    await wait(async () => {
      ran = 0;
      for (const session of (await snapshot()).sessions) ran += (await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${session.id}/items`)).items.filter((item) => item.kind === "user" && item.text === "소켓이 끊긴 동안 보낸 요청").length;
      return ran > 0;
    }, 60_000);
    await new Promise((done) => setTimeout(done, 1_500));
    check("a line sent while the socket was down ran once after the reconnect", ran === 1, String(ran));
  }

  // An upload whose sharing may have happened (the connection cut after it): the answer once, the file named.
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const engine = press("엔진·모델");
  await wait(() => shown(engine).includes("지금:"));
  if (!shown(engine).includes("지금: Claude")) {
    press("Claude");
    await wait(() => shown(engine).startsWith("이 대화를 Claude로"));
  }
  count = texts().length;
  fake.failAt("files.completeUploadExternal", 1, { kind: "cut-after" });
  fake.message("논문 세 편 길게 요약해 줘");
  const named = await answered(count, (text) => text.includes("전달되지 않았을 수 있습니다. PC에서 확인해 주세요."), 60_000);
  await new Promise((done) => setTimeout(done, 3_000));
  const answers = textsSince(count).filter((text) => !text.startsWith("작업 중") && !text.includes("전달되지 않았을 수 있습니다") && !text.startsWith("대기열"));
  fake.faults.clear();
  check("upload cut mid-answer: the answer once, the file named", named && answers.length === 1, textsSince(count).map((text) => text.slice(-60)).join(" | "));

  // The gateway off: what was written meanwhile is read from the DM's history after it starts, once.
  await stop(gateway);
  fake.redeliverUnacked = false;
  fake.message("꺼져 있던 동안의 요청", { deliver: false });
  count = texts().length;
  gateway = await launch();
  check("written while off: run after start", await answered(count, (text) => !text.startsWith("작업 중") && !text.startsWith("대기열") && !text.startsWith("앞의 답이") && !text.startsWith("PC가"), 60_000), textsSince(count).join(" | "));
  const sessions = (await snapshot()).sessions;
  let ran = 0;
  for (const session of sessions) ran += (await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${session.id}/items`)).items.filter((item) => item.kind === "user" && item.text === "꺼져 있던 동안의 요청").length;
  check("written while off: once", ran === 1, String(ran));

  // What waited more than a day is not run: one line says how many and since when, and the record has it.
  await stop(gateway);
  const old = Math.floor(Date.now() / 1000) - 2 * 86_400;
  {
    const db = new DatabaseSync(join(dataDir, "state.sqlite"));
    const key = `channel.offset:slack:${fake.botId}`;
    const marks = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string }).value) as Record<string, string>;
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ ...marks, D0HONG: `${old - 60}.000001` }), key);
    db.close();
  }
  fake.message("이틀 전에 보낸 요청", { deliver: false, ts: `${old}.000001` });
  fake.message("방금 보낸 요청", { deliver: false });
  count = texts().length;
  gateway = await launch();
  check("the cap line: what was not run is said once", await answered(count, (text) => /^PC가 꺼져 있던 동안 온 요청 중 1개는 실행하지 않았습니다 \(/.test(text)) && textsSince(count).filter((text) => text.includes("실행하지 않았습니다")).length === 1, textsSince(count).join(" | ").slice(0, 300));
  check("the cap line: the recent one runs", await answered(count, (text) => text.startsWith("PC가 꺼져 있거나 잠들어 있던 동안 온 요청 1개를 지금 실행합니다") || (!text.startsWith("작업 중") && !text.startsWith("PC가") && !text.startsWith("앞의 답")), 60_000));
  let oldRan = 0;
  for (const session of (await snapshot()).sessions) oldRan += (await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${session.id}/items`)).items.filter((item) => item.kind === "user" && item.text === "이틀 전에 보낸 요청").length;
  check("the cap line: the old one did not run", oldRan === 0, String(oldRan));

  // Pause and lock, Slack's chat as Telegram's.
  const bindingId = (await state()).bots[0]!.bindings[0]!.id;
  await api("PATCH", `/api/channels/bindings/${bindingId}`, { paused: true });
  count = texts().length;
  fake.message("멈춘 동안의 요청");
  check("paused: only the short reply", await answered(count, (text) => text === "지금은 PC에서 채널을 멈춰 두었습니다."));
  await api("PATCH", `/api/channels/bindings/${bindingId}`, { paused: false });
  count = texts().length;
  fake.message("잠금");
  check("locked from the chat", await answered(count, (text) => text.includes("푸는 것은 PC에서만 할 수 있습니다.")));
  check("the PC shows it locked", Boolean((await state()).bots[0]!.bindings[0]!.lockedAt));

  // The gates hold: neither token in any file of the data folder, the record holds no message text.
  const all = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const leaked = all.filter((entry) => { const text = readFileSync(join(entry.parentPath, entry.name), "latin1"); return text.includes(FAKE_BOT_TOKEN) || text.includes(FAKE_APP_TOKEN); }).map((entry) => entry.name);
  check("tokens in no file of the data folder", leaked.length === 0, leaked.join(", "));
  const pairingValue = link.say!.split(" ")[1]!; // the window's value: the bare 연결 used it
  check("the pairing value in no file of the data folder", !all.some((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1").includes(pairingValue)));
  const audit = await api<{ rows: { action: string; target: string | null; result: string | null; kind: string }[] }>("GET", "/api/channels/audit?limit=500");
  check("record has no message text", !JSON.stringify(audit.rows).includes("메일함 정리") && !JSON.stringify(audit.rows).includes("2차 심사"));
  check("record names files and menu actions, as Slack", ["file.sent", "file.received", "pointer", "engine", "schedule", "note.entry", "paired", "history.skipped"].every((action) => audit.rows.some((row) => row.action === action && row.kind === "slack")), [...new Set(audit.rows.map((row) => row.action))].join(" "));
  check("one socket at a time throughout", fake.maxOpen === 1, String(fake.maxOpen));
} catch (error) {
  check("smoke ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  await stop(gateway);
  await fake.stop();
  if (process.env.CHANNEL_SMOKE_KEEP !== "1") rmSync(dataDir, { recursive: true, force: true });
  if (gateway.stderr().includes("Messenger channel could not start")) check("channel started", false, "Messenger channel could not start");
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} of ${results.length} checks pass`);
process.exit(failed ? 1 : 0);
