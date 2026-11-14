// The phone's ten common conversations (design m02 §5.7) driven end to end against the bundled
// gateway: a stand-in Bot API on 127.0.0.1 plays the phone, the repository's stand-in engines play
// Claude and Codex (no model), a stand-in keyring seals the token. Nothing here contacts Telegram.
//
// Usage (from the repository, through ux/run-isolated.sh, after `npm run build -w @workbench/host`):
//   node scripts/channel-smoke.ts
// Prints one PASS/FAIL line per check and exits 1 when any failed. The gateway is stopped by its PID.

import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelsState, Schedule, Snapshot } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";

const dataDir = mkdtempSync(join(tmpdir(), "workbench-channel-smoke-"));
const fake = new FakeTelegram();
await fake.start();

type Gateway = { child: ChildProcess; ready: { url: string; token: string }; stderr: () => string };
/** The bundled gateway on the smoke's data folder (started again on the same folder for the boot check). */
async function launch(): Promise<Gateway> {
  const child = spawn(process.execPath, [process.env.CHANNEL_SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_HOST_LABEL: "노트북",
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
      WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      WORKBENCH_TELEGRAM_API: fake.url,
      WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
      FAKE_SECRET_OFF: join(dataDir, "keyring-off"),
      // Schedules looked at every second (the boot and pause checks below wait for them).
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
/** Stop a gateway by its own PID and wait for it. */
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
const texts = () => fake.texts();
const textsSince = (count: number) => texts().slice(count);
const press = (label: string) => { const button = fake.button(label); fake.press(button.data, { messageId: button.messageId }); return button.messageId; };
const shown = (id: number) => fake.shown(id) ?? "";
const answered = (count: number, match: (text: string) => boolean, ms = 30_000) => wait(() => textsSince(count).some(match), ms);
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");

try {
  // Registration and pairing, as the PC screen does them.
  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  const link = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${fake.botId}/pairing`, {});
  fake.message(`/start ${new URL(link.link).searchParams.get("start")}`);
  await wait(async () => Boolean((await api<ChannelsState>("GET", "/api/channels")).bots[0]?.pairing.request));
  const request = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.pairing.request!;
  await api("POST", `/api/channels/telegram/bots/${fake.botId}/pairing/${request.id}`, { approve: true });
  check("pairing", await answered(0, (text) => text.startsWith("연결되었습니다")));
  await api("POST", "/api/works", { title: "연구계획서" });

  // 1. 그냥 시키기: a status line edited in place, then the answer (the stand-in answers long to the
  // phone preamble, so it comes with the whole answer as a .md file).
  let count = texts().length;
  fake.message("어제 받은 학생 명단 엑셀에서 3학년만 뽑아서 따로 저장해 줘");
  check("1 status line", await answered(count, (text) => text === "작업 중 · 0:00"));
  check("1 answer", await answered(count, (text) => text.includes("답이 길어 앞부분만 보냈습니다"), 60_000));
  check("1 status edited to 끝남", fake.of("editMessageText").some((call) => /^끝남 · \d+:\d{2}$/.test(String(call.params.text))));
  check("1 whole answer as .md", fake.of("sendDocument").some((call) => call.file?.name.endsWith(" 답.md") === true));

  // 2. 문서 만들기: the file the turn wrote comes as an attachment.
  count = texts().length;
  let documents = fake.of("sendDocument").length;
  fake.message("견본 문서 만들어 줘");
  check("2 answer", await answered(count, (text) => !text.startsWith("작업 중") && !text.startsWith("대기열"), 60_000));
  await wait(() => fake.of("sendDocument").length > documents, 10_000);
  const names = fake.of("sendDocument").slice(documents).map((call) => call.file?.name);
  check("2 the made document attached", names.includes("슬라이드-구성.md"), names.join(", "));

  // 3. 사진을 보내며 시키기: the picture reaches the engine with the request.
  count = texts().length;
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000031b0ec3a", "hex");
  fake.file("ph-1", "photos/file_1.jpg", png);
  fake.message("이거 표로 정리해 줘", { extra: { photo: [{ file_id: "ph-1", file_size: png.length, width: 1, height: 1 }] } });
  check("3 picture reached the engine", await answered(count, (text) => text.includes("받은 그림 1장"), 60_000));

  // 4. 일하는 중 덧붙이기, 그리고 멈추기.
  count = texts().length;
  fake.message("논문 초록 세 편 요약해 줘");
  await answered(count, (text) => text === "작업 중 · 0:00");
  fake.message("아 그리고 각 요약 끝에 연구 방법도 한 줄씩");
  check("4 added while working", await answered(count, (text) => text === "(덧붙인 말을 지금 일에 넣었습니다)" || text.startsWith("대기열에 넣었습니다")), textsSince(count).join(" | "));
  fake.message("멈춰");
  check("4 stopped", await answered(count, (text) => text.startsWith("멈췄습니다")));
  check("4 stop offers 이어서 하기", await wait(() => { try { fake.button("이어서 하기"); return true; } catch { return false; } }, 5_000));

  // 5. 음성: not built (unit 11); said, not dropped.
  count = texts().length;
  fake.message("", { extra: { voice: { file_id: "v-1", file_size: 3000, mime_type: "audio/ogg", duration: 14 } } });
  check("5 voice said not taken yet", await answered(count, (text) => text === "음성 메시지는 아직 받지 못합니다. 글로 적어 보내 주세요."));

  // 6. 대화·프로젝트 바꾸기, 새 대화: one menu message edited in place.
  count = texts().length;
  fake.message("메뉴");
  check("6 menu", await answered(count, (text) => text.startsWith("메뉴 · 지금:")));
  let sends = fake.of("sendMessage").length;
  const menuId = press("대화 바꾸기");
  await wait(() => shown(menuId).endsWith("의 최근 대화"));
  const first = (await snapshot()).sessions.find((session) => session.purpose.startsWith("휴대폰"));
  const label = [...fake.of("editMessageText")].reverse().find((call) => Number(call.params.message_id) === menuId)?.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  const row = label.inline_keyboard.flat().find((button) => button.text.includes(first!.purpose));
  fake.press(row!.callback_data, { messageId: menuId });
  check("6 picked a conversation, in place", await wait(() => shown(menuId).startsWith("이제 「")) && fake.of("sendMessage").length === sends, shown(menuId));
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
  sends = fake.of("sendMessage").length;
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu2 = fake.button("최근 파일").messageId;
  press("최근 파일");
  await wait(() => shown(menu2).includes("최근 파일"));
  const files = ([...fake.of("editMessageText")].reverse().find((call) => Number(call.params.message_id) === menu2)?.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
  const doc = files.find((button) => button.text === "슬라이드-구성.md");
  check("8 recent files list the made document", Boolean(doc), files.map((button) => button.text).join(", "));
  if (doc) {
    fake.press(doc.callback_data, { messageId: menu2 });
    await wait(() => shown(menu2).startsWith("「슬라이드-구성.md」"));
    const documentsBefore = fake.of("sendDocument").length;
    press("받기");
    check("8 받기 sends the file", await wait(() => fake.of("sendDocument").length > documentsBefore));
    press("이 문서의 AI에게");
    check("8 to the document's AI", await wait(() => shown(menu2).startsWith("이제 「슬라이드-구성」의 AI에게 보냅니다")), shown(menu2));
    count = texts().length;
    fake.message("2번 항목을 더 공손하게 고쳐 줘");
    check("8 the document's AI answers", await answered(count, (text) => !text.startsWith("작업 중") && !text.startsWith("이제"), 60_000));
    const pointer = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.bindings[0]!.pointerSessionId;
    check("8 the chat points at the document's AI", Boolean((await snapshot()).sessions.find((session) => session.id === pointer)?.documentAgent));
  }
  count = texts().length;
  fake.message("결정으로 적어 줘: 2차 심사는 12월 첫 주로");
  check("8 decision written to the note", await answered(count, (text) => /노트 '결정'에 추가했습니다\.$/.test(text)), textsSince(count).join(" | "));

  // 9. 찾기: a one-line input, then what was found (or why the search could not run here).
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu3 = press("찾기");
  await wait(() => shown(menu3) === "무엇을 찾을까요? (한 줄로 적어 주세요)");
  count = texts().length;
  fake.message("심사");
  const found = await answered(count, (text) => /^\d+건 · “심사”$/.test(text) || text.startsWith("찾은 것이 없습니다") || text.startsWith("찾지 못했습니다"));
  // The search worker of the desktop app is not in this checkout: then the chat says why, which is not a pass.
  const unavailable = textsSince(count).some((text) => text.startsWith("찾지 못했습니다: Rust 검색 실행기가 없습니다"));
  if (unavailable) console.log("NOTE 9 search not available here (no search worker): the chat said so; not counted");
  else check("9 search answered", found, textsSince(count).join(" | "));

  // 10. 예약: a time button, the text, and a schedule marked with the chat.
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
  check("10 the schedule carries the chat", schedules.some((schedule) => schedule.origin?.channel === "telegram"));

  // Plan first: Claude's plan mode asks with one 진행, and going ahead runs in the same turn.
  count = texts().length;
  fake.message("새 대화");
  await answered(count, (text) => text.startsWith("새 대화를 만들었습니다"));
  count = texts().length;
  fake.message("계획 먼저: 발표 자료 정리해 줘");
  const asked = await wait(() => { try { fake.button("진행"); return true; } catch { return false; } }, 60_000);
  check("plan first offers 진행", asked, textsSince(count).join(" | "));
  if (asked) {
    press("진행");
    check("plan goes ahead", await answered(count, (text) => text.includes("계획대로 진행합니다") || text.includes("답이 길어"), 60_000), textsSince(count).slice(-2).join(" | "));
  }

  // Unit 14: answers formatted, the plain fallback, what 상태 says, retry, rename, the footer on and off.
  {
    type Entity = { type: string; offset: number; length: number };
    const covered = (call: { params: Record<string, unknown> }) => ((call.params.entities as Entity[] | undefined) ?? []).map((entity) => `${entity.type}:${String(call.params.text).slice(entity.offset, entity.offset + entity.length)}`);
    // The chat's conversation is the Codex one of check 7 here (the stand-ins name their models
    // "fake-model" and "claude-fake-1").
    // The first answer (a heading "## 1. 단락" in the stand-in's markdown) went as entities.
    const first = fake.of("sendMessage").find((call) => String(call.params.text).includes("답이 길어 앞부분만 보냈습니다"));
    check("14 a markdown answer delivered formatted", Boolean(first) && !String(first!.params.text).includes("## ") && covered(first!).includes("bold:1. 단락"), first ? covered(first).slice(0, 3).join(" ") : "no answer");
    count = texts().length;
    fake.message("새 대화");
    await answered(count, (text) => text.startsWith("새 대화를 만들었습니다"));
    const maps = () => fake.of("sendMessage").filter((call) => String(call.params.text).startsWith("여기 마인드맵입니다"));
    count = texts().length;
    fake.refuseFormatted = 1;
    fake.message("도식 그려 줘");
    await answered(count, (text) => text.startsWith("여기 마인드맵입니다"), 60_000);
    await new Promise((done) => setTimeout(done, 1_500));
    const map = maps()[0];
    check("14 a refused formatted message delivered plain once", maps().length === 1 && map?.params.entities === undefined && fake.refuseFormatted === 0, `${maps().length} sent`);
    check("14 the footer under a finished answer", /\n(Claude|Codex) · [^\n]+ · \d+:\d{2}( · 맥락 \d+%)?$/.test(String(map?.params.text ?? "")), String(map?.params.text ?? "").split("\n").at(-1));
    check("14 the footer never on the progress line", fake.of("editMessageText").every((call) => !/^(작업 중|끝남).*(Claude|Codex) ·/.test(String(call.params.text))));
    count = texts().length;
    fake.message("/status");
    const statusSaid = await answered(count, (text) => text.startsWith("지금: "));
    const status = textsSince(count).find((text) => text.startsWith("지금: ")) ?? "";
    check("14 /status names the engine and the model", statusSaid && /^엔진: (Claude · 모델 claude-fake-1|Codex · 모델 fake-model)/m.test(status), status.split("\n").slice(1, 4).join(" / "));
    count = texts().length;
    fake.message("다시 시도");
    const again = await answered(count, (text) => text === "다시 보냅니다: “도식 그려 줘”") && await wait(() => maps().length === 2, 60_000);
    const pointer = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.bindings[0]!.pointerSessionId!;
    const asked = (await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${pointer}/items`)).items.filter((item) => item.kind === "user" && item.text === "도식 그려 줘").length;
    check("14 다시 시도 sends the last request again", again && asked === 2, `${asked} requests`);
    count = texts().length;
    fake.message("대화 이름 바꾸기");
    await answered(count, (text) => text.includes("의 새 이름을 적어 보내 주세요"));
    count = texts().length;
    fake.message("스모크 이름");
    const renamed = await answered(count, (text) => text === "대화 이름을 「스모크 이름」(으)로 바꿨습니다.");
    check("14 대화 이름 바꾸기 through the desktop's rename", renamed && (await snapshot()).sessions.find((session) => session.id === pointer)?.purpose === "스모크 이름");
    count = texts().length;
    fake.message("꼬리말 끄기");
    await answered(count, (text) => text.startsWith("끝난 답 아래 꼬리말을 붙이지 않습니다"));
    fake.message("도식 그려 줘");
    await wait(() => maps().length === 3, 60_000);
    check("14 the footer off", maps().length === 3 && !/\n(Claude|Codex) · /.test(String(maps()[2]!.params.text)), String(maps()[2]?.params.text ?? "").split("\n").at(-1));
    count = texts().length;
    fake.message("/nope");
    check("14 an unknown slash command points to /help", await answered(count, (text) => text === "모르는 명령입니다. /help 를 보내면 쓸 수 있는 말이 나옵니다."));
    const commands = fake.of("setMyCommands").at(-1)?.params.commands as { command: string }[] | undefined;
    check("14 the command button lists the nine", commands?.map((entry) => entry.command).join(" ") === "menu new chats model status usage retry stop help");
    const record = await api<{ rows: { action: string; target: string | null; result: string | null }[] }>("GET", "/api/channels/audit?limit=500");
    check("14 retry, rename and footer recorded without content", ["retry", "rename", "footer"].every((action) => record.rows.some((row) => row.action === action)) && !JSON.stringify(record.rows).includes("스모크 이름") && !JSON.stringify(record.rows).includes("도식"));
  }

  // The gates hold: nothing secret in the data folder, the record holds no message text.
  const all = readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const leaked = all.filter((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1").includes(FAKE_TOKEN)).map((entry) => entry.name);
  check("token in no file of the data folder", leaked.length === 0, leaked.join(", "));
  const audit = await api<{ rows: { action: string; target: string | null; result: string | null }[] }>("GET", "/api/channels/audit?limit=500");
  check("record has no message text", !JSON.stringify(audit.rows).includes("메일함 정리") && !JSON.stringify(audit.rows).includes("2차 심사"));
  check("record names files and menu actions", ["file.sent", "file.received", "pointer", "engine", "schedule", "note.entry"].every((action) => audit.rows.some((row) => row.action === action)), [...new Set(audit.rows.map((row) => row.action))].join(" "));

  // An upload failing after the answer's text went: the answer goes once, the file is named. A
  // Claude conversation (the stand-in answers the phone long, so its answer comes with a .md file).
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu5 = press("엔진·모델");
  await wait(() => shown(menu5).includes("지금:"));
  if (!shown(menu5).includes("지금: Claude")) {
    press("Claude");
    await wait(() => shown(menu5).startsWith("이 대화를 Claude로"));
  }
  count = texts().length;
  // The text goes first; the first upload after it answers 502.
  fake.nextUpload = ["busy"];
  fake.message("논문 세 편 길게 요약해 줘");
  const named = await answered(count, (text) => text.includes("전달되지 않았을 수 있습니다. PC에서 확인해 주세요."), 60_000);
  await new Promise((done) => setTimeout(done, 4_500));
  const answers = textsSince(count).filter((text) => !text.startsWith("작업 중") && !text.includes("전달되지 않았을 수 있습니다") && !text.startsWith("대기열"));
  fake.nextUpload = [];
  check("upload failing mid-answer: the answer once, the file named", named && answers.length === 1, textsSince(count).map((text) => text.slice(-60)).join(" | "));

  // An open chat's schedule that came due while the PC was off runs once after the channel starts
  // (not lost); one that comes due during a pause is named at resume with [지금 실행].
  {
    const open = (await api<{ schedules: Schedule[] }>("GET", "/api/schedules")).schedules.find((schedule) => schedule.origin)!;
    await stop(gateway);
    const db = new DatabaseSync(join(dataDir, "state.sqlite"));
    const value = (db.prepare("SELECT value FROM meta WHERE key = 'schedules'").get() as { value: string }).value;
    const past = Date.now() - 60_000, later = Date.now() + 40_000;
    const list = (JSON.parse(value) as Schedule[]).map((schedule) => (schedule.id === open.id ? { ...schedule, text: "밀린 예약 요약", when: { kind: "once" as const, at: past }, nextAt: past } : schedule));
    list.push({ ...open, id: "smoke-paused", text: "멈춘 동안의 예약", when: { kind: "once", at: later }, nextAt: later, enabled: true });
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schedules'").run(JSON.stringify(list));
    db.close();
    count = texts().length;
    gateway = await launch();
    const ranAtBoot = await wait(async () => (await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${open.sessionId}/items`)).items.some((item) => item.kind === "user" && item.text === "밀린 예약 요약"), 30_000);
    check("boot: an open chat's overdue schedule ran once the channel started", ranAtBoot);
    const pausedBinding = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.bindings[0]!.id;
    await api("PATCH", `/api/channels/bindings/${pausedBinding}`, { paused: true });
    await new Promise((done) => setTimeout(done, Math.max(0, later - Date.now()) + 3_000));
    const items = await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${open.sessionId}/items`);
    check("pause: a schedule due meanwhile did not run", !items.items.some((item) => item.kind === "user" && item.text === "멈춘 동안의 예약"));
    count = texts().length;
    await api("PATCH", `/api/channels/bindings/${pausedBinding}`, { paused: false });
    check("resume: what was skipped is named", await answered(count, (text) => text.startsWith("멈춰 둔 동안 예약 1개가 실행되지 않았습니다.")));
    press("1 지금 실행");
    check("[지금 실행] runs it", await wait(async () => (await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${open.sessionId}/items`)).items.some((item) => item.kind === "user" && item.text === "멈춘 동안의 예약"), 30_000));
  }

  // A daily schedule from the chat again, for the lock check below.
  count = texts().length;
  fake.message("메뉴");
  await answered(count, (text) => text.startsWith("메뉴 · 지금:"));
  const menu6 = press("예약");
  await wait(() => shown(menu6).startsWith("언제 할까요?"));
  press("매일 09:00");
  await wait(() => shown(menu6).startsWith("무엇을 할까요?"));
  count = texts().length;
  fake.message("잠금 전 예약");
  await answered(count, (text) => text.startsWith("예약했습니다"));

  // A chat's overdue schedule at boot, after the chat was locked: stored off, and refused even when forced back on.
  const bindingId = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.bindings[0]!.id;
  await api("PATCH", `/api/channels/bindings/${bindingId}`, { locked: true });
  const planted = (await api<{ schedules: Schedule[] }>("GET", "/api/schedules")).schedules.find((schedule) => schedule.origin && schedule.text === "잠금 전 예약")!;
  check("lock stores the chat's schedule off", planted.enabled === false);
  await stop(gateway);
  const db = new DatabaseSync(join(dataDir, "state.sqlite"));
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'schedules'").get() as { value: string };
  const list = (JSON.parse(stored.value) as Schedule[]).map((schedule) => (schedule.id === planted.id ? { ...schedule, enabled: true, nextAt: Date.now() - 60_000 } : schedule));
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schedules'").run(JSON.stringify(list));
  db.close();
  gateway = await launch();
  await new Promise((done) => setTimeout(done, 5_000));
  const items = await api<{ items: { kind: string; text?: string }[] }>("GET", `/api/sessions/${planted.sessionId}/items`);
  check("boot: a locked chat's overdue schedule did not run", !items.items.some((item) => item.kind === "user" && item.text === planted.text));
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
