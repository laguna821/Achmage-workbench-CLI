#!/usr/bin/env node
// A stand-in for `codex app-server` for browser checks: speaks the same newline-delimited
// JSON-RPC, streams a Markdown answer line by line, takes `turn/steer` and `turn/interrupt`,
// asks for command approval unless the thread runs with approvalPolicy "never", and reports token
// use, rate limits and compaction. No model is involved.
//
// What a request says decides what the fake does:
//   "길게"  a long answer (about 8 s)      "명령"  runs `ls -la` (approval first unless "never")
//   "압축"  compacts the conversation      "느리게" steered requests wait until line 100
//   a drawing turn (Workbench's "그림" instructions): the image tool draws a small PNG — landscape,
//     portrait or square as the prompt asks — saved under a temp folder like Codex's own home, and
//     sent as base64 too; "한도" in the prompt fails with the image usage limit, "천천히" takes 2.5 s
//   "[세션 잇기 k/m"  a linked-session hand-over: a reply of its own each time; with "합의:N" in the
//                     goal its last line is [[합의]] from message N on, with "되풀이" it repeats itself,
//                     "천천히" takes about 2 s and "길게" about 8 s
//   "브라우저" says whether the thread was told about the agent browser (developer instructions at
//          the start or a developer item injected later) and, when told, runs `playwright-cli open
//          <address>` from its PATH like a model would (found by CODEX_THREAD_ID, no -s), asking first
//          only under "untrusted" as Codex does
//   "고쳐"  appends a paragraph to the working copy the request names (a proposal)
//   anything else: a short answer
// Local images in the input are reported at the start of the answer ("받은 그림 1장 · 1234바이트").
// "스크린샷": like a browsing step, a command saves a screenshot (Playwright CLI's output names it),
// then Codex looks at a second picture with its image viewer (an imageView item).
// `skills/list` offers one skill ("review-notes"); a turn given it as a skill input says so.
// `thread/list` also offers a thread made in a terminal ("thr_cli_1", in $FAKE_CODEX_IMPORT_CWD or the
// temp folder) whose turns `thread/read` returns; resumed, it goes on like any other.
// A turn in the read-only sandbox ("계획 먼저") answers with a plan; "계획대로 진행" says which
// sandbox the going-ahead turn runs in.
// Vault notes attached to a request are named back ("받은 노트 사본: …").
// Login (setup checks): with FAKE_ENGINE_AUTH_DIR set, Codex is logged in only once <dir>/codex
// exists. `account/login/start` serves a callback on this computer like Codex does; opening its
// address (a browser, or the stand-in opener) logs in and sends `account/login/completed`.
// FAKE_CODEX_VERSION changes what `--version` says.
//   "맥락"  answers with the developer instructions the thread started with and its sandbox
//   "볼트에 써: <path>"  writes only where the sandbox would let Codex (work folder, temporary
//          folders unless excluded, anything with full access) and only inside the temporary folder.

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { crc32, deflateSync } from "node:zlib";
import { pagePng } from "./png.mjs";

if (process.argv.includes("--version")) {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.0.0-fake"}`);
  process.exit(0);
}

const authFile = process.env.FAKE_ENGINE_AUTH_DIR ? join(process.env.FAKE_ENGINE_AUTH_DIR, "codex") : null;
const signedIn = () => !authFile || existsSync(authFile);
let loginServer = null;

const CONTEXT_WINDOW = 258_400;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const now = () => Math.floor(Date.now() / 1000);

const threads = new Map(); // id -> { approvalPolicy, sandbox, cwd, used, turn, browser, roots }
const BROWSER_MARK = "[Achmage Workbench · 브라우저]";

/** What a developer text says about the browser: on (with the session's name), off, or nothing. */
function browserNote(text) {
  if (!text || !text.includes(BROWSER_MARK)) return null;
  if (text.includes("껐습니다")) return { on: false, name: null };
  return { on: true, name: /-s=(wb-[a-z0-9]+)/.exec(text)?.[1] ?? null };
}

/** Run a command line as Codex would: its own environment plus the thread id. */
function runCommand(line, cwd, threadId) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", line], { cwd, env: { ...process.env, CODEX_THREAD_ID: threadId } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (error) => resolve({ code: 127, output: String(error) }));
  });
}
const waiting = new Map(); // server request id -> resolve
let counter = 0;
let serverRequestId = 1000;
let rateUsed = 23;

const rateLimits = () => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: rateUsed, windowDurationMins: 300, resetsAt: now() + 2 * 3600 },
  secondary: { usedPercent: Math.round(rateUsed / 3), windowDurationMins: 10080, resetsAt: now() + 4 * 86400 },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: "pro",
  rateLimitReachedType: null,
});

const usage = (thread, last) => ({
  total: { totalTokens: thread.used, inputTokens: thread.used - last, cachedInputTokens: Math.round(thread.used * 0.6), cacheWriteInputTokens: 0, outputTokens: last, reasoningOutputTokens: 0 },
  last: { totalTokens: thread.used, inputTokens: thread.used - last, cachedInputTokens: Math.round(thread.used * 0.6), cacheWriteInputTokens: 0, outputTokens: last, reasoningOutputTokens: 0 },
  modelContextWindow: CONTEXT_WINDOW,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A real PNG: a filled circle of `rgb` on white. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const radius = Math.min(width, height) * 0.35;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < radius ** 2;
      row[1 + x * 3] = inside ? r : 255;
      row[2 + x * 3] = inside ? g : 255;
      row[3 + x * 3] = inside ? b : 255;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** Codex's image tool: draws once, saves the file under its own folder, and reports the item. */
async function draw(threadId, thread, turnId, text) {
  const prompt = text.split("프롬프트:\n")[1] ?? text;
  const [width, height] = /Landscape/.test(prompt) ? [120, 80] : /Portrait/.test(prompt) ? [80, 120] : [96, 96];
  const item = { type: "imageGeneration", id: `ig_${++counter}`, status: "in_progress", revisedPrompt: null, result: "", failure: null };
  notify("item/started", { threadId, turnId, item });
  await sleep(prompt.includes("천천히") ? 2500 : 400);
  if (thread.turn?.interrupted) return null;
  if (prompt.includes("한도")) {
    notify("item/completed", { threadId, turnId, item: { ...item, status: "failed", failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: now() + 3600 } } });
    return "이미지 생성 한도를 다 써서 그리지 못했습니다.";
  }
  const data = png(width, height, [47, 111, 235]);
  const folder = join(tmpdir(), "fake-codex-images", threadId);
  mkdirSync(folder, { recursive: true });
  const savedPath = join(folder, `${item.id}.png`);
  writeFileSync(savedPath, data);
  notify("item/completed", { threadId, turnId, item: { ...item, status: "completed", revisedPrompt: `A simple picture. ${prompt.split("\n")[0].slice(0, 160)}`, result: data.toString("base64"), savedPath } });
  return "흰 바탕에 파란 원 하나를 그렸습니다.";
}

/** A thread made in a terminal before Workbench: one turn with a command and an answer. */
function terminalThread() {
  const cwd = process.env.FAKE_CODEX_IMPORT_CWD ?? tmpdir();
  const at = now() - 3600;
  return {
    ...threadResponse("thr_cli_1", { cwd }).thread,
    preview: "터미널에서 시작한 Codex 대화",
    source: "cli",
    createdAt: at,
    updatedAt: at + 30,
    turns: [
      {
        id: "turn_cli_1", itemsView: "full", status: "completed", error: null, startedAt: at, completedAt: at + 30, durationMs: 30_000,
        items: [
          { type: "userMessage", id: "um_cli_1", clientId: null, content: [{ type: "text", text: "터미널에서 시작한 Codex 대화", text_elements: [] }] },
          { type: "commandExecution", id: "cmd_cli_1", command: "ls", cwd, processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "notes.md\n", exitCode: 0, durationMs: 12 },
          { type: "agentMessage", id: "am_cli_1", text: "터미널에서 받은 Codex 답입니다.", phase: null, memoryCitation: null },
        ],
      },
    ],
  };
}

/** Lines of a reply to a linked-session hand-over (null for any other request). */
function linkReply(text, engine) {
  const hop = /\[세션 잇기 (\d+)\/(\d+)/.exec(text);
  if (!hop) return null;
  if (text.includes("되풀이")) return ["같은 말을 되풀이합니다. 더 보탤 것이 없습니다."];
  const k = Number(hop[1]);
  const lines = [`${engine}의 ${k}번째 의견입니다 (${k}/${hop[2]}).`, "", `- 받은 글 ${text.length}자를 읽었습니다.`, `- 제안 ${k}: ${["2주차와 3주차를 합칩니다", "3주차는 실습으로 바꿉니다", "평가 기준을 4주차로 옮깁니다", "사전 설문을 넣습니다", "토론 시간을 늘립니다", "마지막 주에 발표를 둡니다"][(k - 1) % 6]}.`];
  const agree = /합의:(\d+)/.exec(text);
  if (agree && k >= Number(agree[1])) lines.push("", "[[합의]]");
  return lines;
}

function ask(method, params) {
  const id = serverRequestId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function threadResponse(id, thread) {
  return {
    thread: { id, preview: "", modelProvider: "openai", createdAt: now(), updatedAt: now(), status: { type: "idle" }, path: null, cwd: thread.cwd, cliVersion: "0.0.0-fake", source: "appServer", gitInfo: null, name: null, turns: [] },
    model: "fake-model",
    modelProvider: "openai",
    serviceTier: null,
    cwd: thread.cwd,
    approvalPolicy: thread.approvalPolicy,
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    reasoningEffort: "medium",
  };
}

async function compact(threadId, thread, turnId) {
  const id = `cc_${++counter}`;
  notify("item/started", { threadId, turnId, item: { type: "contextCompaction", id } });
  await sleep(300);
  notify("item/completed", { threadId, turnId, item: { type: "contextCompaction", id } });
  thread.used = Math.round(thread.used * 0.18);
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage(thread, 0) });
}

/** What the fake saw of the pictures it was given (they must exist where the input says). */
function received(input) {
  const seen = [];
  const images = input.filter((part) => part.type === "localImage");
  if (images.length) seen.push(`받은 그림 ${images.length}장 · ${images.map((part) => (existsSync(part.path) ? `${statSync(part.path).size}바이트` : "없는 파일")).join(", ")}`);
  const named = namedFiles(input.map((part) => part.text ?? "").join("\n"));
  if (named.length) seen.push(`받은 파일 경로 ${named.length}개 · ${named.map((path) => (existsSync(path) ? `${statSync(path).size}바이트` : "없는 파일")).join(", ")}`);
  return seen.length ? ` (${seen.join(" / ")})` : "";
}

/** Paths listed under "첨부한 파일:" (files the engine is to open itself). */
function namedFiles(text) {
  const at = text.indexOf("첨부한 파일:\n");
  if (at < 0) return [];
  return text.slice(at).split("\n").slice(1).map((line) => line.match(/^- .+?: (\/.+)$/)?.[1]).filter(Boolean);
}

async function runTurn(threadId, thread, turnId, text, images = "") {
  const started = Date.now();
  notify("turn/started", { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null } });
  let status = "completed";
  const request = { type: "userMessage", id: `user_${++counter}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
  notify("item/started", { threadId, turnId, item: request });
  notify("item/completed", { threadId, turnId, item: request });
  if (text.includes("압축")) {
    await compact(threadId, thread, turnId);
  }
  if (text.startsWith("[Achmage Workbench · 그림]")) {
    // A drawing: the picture, then one sentence about it.
    const said = await draw(threadId, thread, turnId, text);
    const id = `msg_${++counter}`;
    if (said) {
      notify("item/started", { threadId, turnId, item: { type: "agentMessage", id, text: "", phase: null, memoryCitation: null } });
      notify("item/agentMessage/delta", { threadId, turnId, itemId: id, delta: said });
      notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id, text: said, phase: null, memoryCitation: null } });
    }
    const interrupted = Boolean(thread.turn?.interrupted);
    thread.used += 3_000;
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage(thread, 60) });
    thread.turn = null;
    notify("turn/completed", { threadId, turn: { id: turnId, items: [], itemsView: "full", status: interrupted ? "interrupted" : "completed", error: null, startedAt: null, completedAt: now(), durationMs: Date.now() - started } });
    return;
  }
  // A document edit: the gateway names the working copy to change; the file itself stays as it is.
  const working = text.match(/작업 사본만 수정하세요: (.+)/);
  if (text.includes("고쳐") && working) {
    const path = resolve(thread.cwd, working[1].trim());
    appendFileSync(path, "\n\n고친 문단입니다. 도입부를 질문 하나로 시작하게 바꿨습니다.\n");
  }
  if (text.includes("MCP")) {
    // An MCP tool that needs approval: Codex asks through an elicitation it marks as such.
    const answer = await ask("mcpServer/elicitation/request", {
      threadId, turnId, serverName: "achmage", mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" },
      message: "search 도구로 볼트를 찾습니다", requestedSchema: { type: "object", properties: {} },
    });
    const ok = answer?.action === "accept";
    const id = `mcp_${++counter}`;
    notify("item/completed", { threadId, turnId, item: { type: "mcpToolCall", id, server: "achmage", tool: "search", status: ok ? "completed" : "failed", arguments: { query: "근거" }, result: null, error: null, durationMs: 5 } });
  }
  let browserLine = null;
  if (text.includes("브라우저")) {
    if (!thread.browser?.on) {
      browserLine = "브라우저 지침: 없음";
    } else {
      const address = /https?:\/\/\S+/.exec(text)?.[0] ?? "https://example.com";
      const line = `playwright-cli open ${address}`;
      const itemId = `cmd_${++counter}`;
      let decision = "accept";
      if (thread.approvalPolicy === "untrusted") {
        const answer = await ask("item/commandExecution/requestApproval", { kind: "command", threadId, turnId, itemId, startedAtMs: Date.now(), environmentId: null, reason: null, command: line, cwd: thread.cwd });
        decision = answer?.decision ?? "decline";
      }
      const command = { type: "commandExecution", id: itemId, command: line, cwd: thread.cwd, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
      notify("item/started", { threadId, turnId, item: command });
      const result = decision === "accept" ? await runCommand(line, thread.cwd, threadId) : { code: null, output: null };
      notify("item/completed", { threadId, turnId, item: { ...command, status: decision !== "accept" ? "declined" : result.code === 0 ? "completed" : "failed", aggregatedOutput: result.output, exitCode: result.code } });
      const title = /Page Title: (.*)/.exec(result.output ?? "")?.[1]?.trim();
      const refusal = (result.output ?? "").split("\n").find((entry) => entry.startsWith("playwright-cli: "));
      browserLine = `브라우저 지침: 받음 (${thread.browser.name ?? "이름 없음"}) · 쓰기 폴더 ${thread.roots.length}개 · ${title ? `제목: ${title}` : `실패: ${refusal ?? result.output ?? decision}`}`;
    }
  }
  if (text.includes("명령")) {
    const itemId = `cmd_${++counter}`;
    let decision = "accept";
    if (thread.approvalPolicy !== "never") {
      const answer = await ask("item/commandExecution/requestApproval", {
        kind: "command", threadId, turnId, itemId, startedAtMs: Date.now(), environmentId: null,
        reason: "폴더 내용을 확인합니다", command: "ls -la", cwd: thread.cwd,
      });
      decision = answer?.decision ?? "decline";
    }
    const command = { type: "commandExecution", id: itemId, command: "ls -la", cwd: thread.cwd, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    notify("item/started", { threadId, turnId, item: command });
    await sleep(150);
    notify("item/completed", { threadId, turnId, item: { ...command, status: decision === "accept" ? "completed" : "declined", aggregatedOutput: decision === "accept" ? "total 0\n" : null, exitCode: decision === "accept" ? 0 : null } });
  }
  if (text.includes("스크린샷")) {
    const folder = join(thread.cwd, ".playwright-cli");
    mkdirSync(folder, { recursive: true });
    const stamp = Date.now();
    writeFileSync(join(folder, `page-${stamp}.png`), pagePng());
    const command = { type: "commandExecution", id: `cmd_${++counter}`, command: "playwright-cli screenshot", cwd: thread.cwd, processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    notify("item/started", { threadId, turnId, item: command });
    await sleep(80);
    notify("item/completed", { threadId, turnId, item: { ...command, status: "completed", aggregatedOutput: `### Result\n- [Screenshot of viewport](.playwright-cli/page-${stamp}.png)\n`, exitCode: 0, durationMs: 80 } });
    const full = join(folder, `full-${stamp}.png`);
    writeFileSync(full, pagePng(300, 260, [31, 158, 117]));
    const view = { type: "imageView", id: `img_${++counter}`, path: full };
    notify("item/started", { threadId, turnId, item: view });
    notify("item/completed", { threadId, turnId, item: view });
  }
  let itemId = `msg_${++counter}`;
  notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "", phase: null, memoryCitation: null } });
  // A forked thread says so in its first answer (how many turns it brought along).
  let forkSaid = "";
  if (thread.forkedFrom && !thread.forkTold) {
    thread.forkTold = true;
    forkSaid = `갈래 스레드: 이전 턴 ${(thread.turns?.length ?? 1) - 1}개 (원래 ${thread.forkedFrom})\n\n`;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: forkSaid });
  }
  const planning = thread.sandbox === "readOnly";
  const linked = planning ? null : linkReply(text, "Codex");
  const lines = planning ? 0 : linked ? linked.length + (text.includes("길게") ? 150 : text.includes("천천히") ? 30 : 0) : text.includes("길게") ? 160 : text.includes("도식") ? 14 : 6;
  let full = `${forkSaid}${browserLine ? `${browserLine}\n\n` : ""}`;
  if (browserLine) {
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: `${browserLine}\n\n` });
  }
  const skill = text.match(/\[스킬 ([^ ]+) · ([^\]]+)\]/);
  if (skill) {
    const said = `스킬 ${skill[1]}를 받았습니다 (${text.split("\n")[0]}).\n\n`;
    full += said;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: said });
  }
  if (planning || text.includes("계획대로 진행")) {
    const said = planning ? "살펴보고 계획을 세웠습니다.\n\n## 계획\n\n1. 지금 상태 살펴보기\n2. 고칠 곳 고치기\n3. 결과 확인하기\n" : `계획대로 진행합니다 (샌드박스: ${thread.sandbox}).\n\n`;
    full += said;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: said });
  }
  if (text.includes("작업 폴더")) {
    const said = `작업 폴더: ${thread.cwd}\n\n`;
    full += said;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: said });
  }
  if (images) {
    const said = `요청을 받았습니다${images}.\n\n`;
    full += said;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: said });
  }
  // Vault notes attached as read-only references: name the copies, as an engine reading them would.
  const notes = [...text.matchAll(/읽기 전용 사본: ([^\n]+)/g)].map((match) => match[1].trim());
  const told = (said) => {
    full += said;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: said });
  };
  if (notes.length) told(`받은 노트 사본: ${notes.join(" | ")}\n\n`);
  if (text.includes("맥락")) told(`맥락 카드:\n${thread.instructions ?? "(없음)"}\n샌드박스: ${thread.mode} ${JSON.stringify(thread.policy ?? null)}\n\n`);
  const target = /볼트에 써: ([^\n]+)/.exec(text)?.[1]?.trim();
  if (target) {
    // The sandbox decides, as Codex's would: full access writes anywhere, read-only nowhere,
    // workspace-write in the work folder and the temporary folders unless they are excluded.
    const policy = thread.policy ?? { type: thread.mode === "danger-full-access" ? "dangerFullAccess" : thread.mode === "read-only" ? "readOnly" : "workspaceWrite", excludeSlashTmp: false, excludeTmpdirEnvVar: false };
    const allowed =
      policy.type === "dangerFullAccess" ||
      (policy.type === "workspaceWrite" && (target.startsWith(`${thread.cwd}/`) || (!policy.excludeSlashTmp && target.startsWith("/tmp/")) || (!policy.excludeTmpdirEnvVar && target.startsWith(`${tmpdir()}/`))));
    if (allowed && target.startsWith(`${tmpdir()}/`)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "테스트");
    }
    told(allowed ? `썼습니다: ${target}\n\n` : `쓰기 거부(샌드박스 ${policy.type}): ${target}\n\n`);
  }
  for (let index = 0; index < lines && thread.turn?.id === turnId && !thread.turn.interrupted; index += 1) {
    // Like Codex, a steered request is taken at the next step (here every 10 lines): it is
    // recorded as a user message, this message ends and a new one starts.
    // "느리게": the turn is in one long step (a slow tool), so steered requests wait until line 100.
    const step = text.includes("느리게") ? index === 100 : index % 10 === 0;
    for (const steer of step ? thread.turn.steers.splice(0) : []) {
      const user = { type: "userMessage", id: `user_${++counter}`, clientId: steer.clientId, content: [{ type: "text", text: steer.text, text_elements: [] }] };
      notify("item/started", { threadId, turnId, item: user });
      notify("item/completed", { threadId, turnId, item: user });
      notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: full, phase: null, memoryCitation: null } });
      itemId = `msg_${++counter}`;
      full = `이어서 받은 요청을 반영합니다: ${steer.text}\n\n`;
      notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "", phase: null, memoryCitation: null } });
      notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: full });
    }
    // "도식": a Mermaid mind map, sent in pieces like any reply.
    const diagram = text.includes("도식") ? "여기 마인드맵입니다.\n\n```mermaid\nmindmap\n  root((Achmage))\n    대화\n      끼어들기\n      끝나면 보내기\n    문서\n      워드\n      한글\n    도식\n      Pele\n```\n".match(/[^\n]*\n/g) : null;
    const line = linked
      ? index < linked.length
        ? `${linked[index]}\n`
        : `\n덧붙임 ${index - linked.length + 1}.`
      : diagram
        ? (diagram[index] ?? "")
        : index % 20 === 0
          ? `\n## ${index / 20 + 1}. 단락\n\n`
          : `${index}번째 줄입니다. 응답이 계속 이어지는 동안 위로 올려 읽을 수 있어야 합니다.\n\n`;
    full += line;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: line });
    await sleep(text.includes("길게") || (linked && text.includes("천천히")) ? 50 : 30);
    if (index === Math.floor(lines / 2)) {
      thread.used += 4_000;
      notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage(thread, 400) });
    }
  }
  if (thread.turn?.interrupted) status = "interrupted";
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: full, phase: null, memoryCitation: null } });
  thread.used += 9_000 + full.length;
  notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage(thread, full.length) });
  rateUsed = Math.min(100, rateUsed + 2);
  notify("account/rateLimits/updated", { rateLimits: rateLimits() });
  thread.turn = null;
  notify("turn/completed", { threadId, turn: { id: turnId, items: [], itemsView: "full", status, error: null, startedAt: null, completedAt: now(), durationMs: Date.now() - started } });
}

async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => send({ id, result });
  const fail = (text) => send({ id, error: { code: -32000, message: text } });
  switch (method) {
    case "initialize":
      return reply({ userAgent: "fake-codex/0.0.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" });
    case "account/read":
      return reply(signedIn() ? { account: { type: "chatgpt", email: "fake@example.com", planType: "pro" }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true });
    case "account/login/start": {
      loginServer?.close();
      const loginId = `login_${++counter}`;
      loginServer = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<p>로그인했습니다. 이 창을 닫아도 됩니다.</p>");
        if (!request.url?.startsWith("/auth/callback")) return;
        mkdirSync(dirname(authFile ?? join(tmpdir(), "x")), { recursive: true });
        if (authFile) writeFileSync(authFile, "signed in");
        loginServer?.close();
        loginServer = null;
        notify("account/login/completed", { loginId, success: true, error: null, onboardingEntrypoint: null });
        notify("account/updated", { authMode: "chatgpt" });
      });
      loginServer.listen(0, "127.0.0.1", () => reply({ type: "chatgpt", loginId, authUrl: `http://127.0.0.1:${loginServer.address().port}/auth/callback?state=${loginId}` }));
      return;
    }
    case "account/login/cancel":
      loginServer?.close();
      loginServer = null;
      reply({ status: "canceled" });
      // Codex reports the cancelled login as completed without success.
      notify("account/login/completed", { loginId: params.loginId, success: false, error: "Login was not completed", onboardingEntrypoint: null });
      return;
    case "account/rateLimits/read":
      return reply({ rateLimits: rateLimits(), rateLimitsByLimitId: null });
    case "skills/list":
      return reply({ data: (params.cwds ?? ["/tmp"]).map((cwd) => ({ cwd, skills: [{ name: "review-notes", description: "노트를 검토하는 스킬(가짜)", path: "/fake/skills/review-notes/SKILL.md", scope: "user", enabled: true, pluginId: null }], errors: [] })) });
    case "model/list":
      return reply({ data: [{ id: "fake-model", model: "fake-model", displayName: "Fake", description: "가짜 모델", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }], defaultReasoningEffort: "medium", isDefault: true }], nextCursor: null });
    case "modelProvider/capabilities/read":
      return reply({ namespaceTools: true, imageGeneration: true, webSearch: true });
    case "config/read":
      return reply({ config: { model: null, model_reasoning_effort: null, approval_policy: "on-request", sandbox_mode: "workspace-write", model_auto_compact_token_limit: 232_000 }, origins: {} });
    case "thread/start": {
      const threadId = `thr_${++counter}`;
      const thread = { approvalPolicy: params.approvalPolicy ?? "on-request", sandbox: params.sandbox ?? "workspace-write", mode: params.sandbox ?? "workspace-write", instructions: params.developerInstructions ?? null, policy: null, cwd: params.cwd ?? "/tmp", used: 11_000, turn: null, browser: browserNote(params.developerInstructions), roots: [] };
      threads.set(threadId, thread);
      return reply(threadResponse(threadId, thread));
    }
    case "thread/inject_items": {
      const thread = threads.get(params.threadId);
      if (!thread) return fail("no such thread");
      for (const item of params.items ?? []) {
        const note = item.role === "developer" ? browserNote((item.content ?? []).map((part) => part.text ?? "").join("\n")) : null;
        if (note) thread.browser = note;
      }
      return reply({});
    }
    case "thread/resume": {
      // Like Codex: developer instructions on resume are not added to the thread.
      const thread = threads.get(params.threadId) ?? { cwd: params.cwd ?? "/tmp", used: 11_000, turn: null, browser: null, roots: [] };
      thread.approvalPolicy = params.approvalPolicy ?? thread.approvalPolicy ?? "on-request";
      thread.sandbox = params.sandbox ?? thread.sandbox ?? "workspace-write";
      thread.mode = params.sandbox ?? thread.mode ?? "workspace-write";
      threads.set(params.threadId, thread);
      return reply(threadResponse(params.threadId, thread));
    }
    case "thread/list": {
      const terminal = terminalThread();
      const wanted = !params.searchTerm || terminal.preview.includes(params.searchTerm);
      return reply({ data: wanted ? [{ ...terminal, turns: [] }] : [], nextCursor: null, backwardsCursor: null });
    }
    case "thread/fork": {
      // Like Codex: a new thread with the turns through lastTurnId (inclusive), the source untouched.
      const source = threads.get(params.threadId);
      if (!source) return fail("no such thread");
      const through = (source.turns ?? []).findIndex((entry) => entry.id === params.lastTurnId);
      if (params.lastTurnId && through < 0) return fail("no such turn");
      const threadId = `thr_${++counter}`;
      const thread = { ...source, turns: params.lastTurnId ? source.turns.slice(0, through + 1) : [...(source.turns ?? [])], forkedFrom: params.threadId, turn: null, used: 11_000 };
      threads.set(threadId, thread);
      return reply(threadResponse(threadId, thread));
    }
    case "thread/read": {
      if (params.threadId === "thr_cli_1" && !threads.has(params.threadId)) return reply({ thread: params.includeTurns ? terminalThread() : { ...terminalThread(), turns: [] } });
      const thread = threads.get(params.threadId);
      if (!thread) return fail("no such thread");
      if (params.includeTurns) return reply({ thread: { ...threadResponse(params.threadId, thread).thread, model: "fake-model", reasoningEffort: "medium", turns: thread.turns ?? [] } });
      return reply({ thread: { ...threadResponse(params.threadId, thread).thread, model: "fake-model", reasoningEffort: "medium" } });
    }
    case "turn/start": {
      const thread = threads.get(params.threadId);
      if (!thread) return fail("no such thread");
      if (params.approvalPolicy) thread.approvalPolicy = params.approvalPolicy;
      if (params.sandboxPolicy) {
        thread.sandbox = params.sandboxPolicy.type;
        thread.roots = params.sandboxPolicy.writableRoots ?? [];
        thread.policy = params.sandboxPolicy;
      }
      const turnId = `turn_${++counter}`;
      thread.turn = { id: turnId, steers: [], interrupted: false };
      // Kept for thread/read and thread/fork: the turn and the request that started it.
      thread.turns = [...(thread.turns ?? []), { id: turnId, itemsView: "full", status: "completed", error: null, startedAt: now(), completedAt: now(), durationMs: 0, items: [{ type: "userMessage", id: `um_${turnId}`, clientId: null, content: params.input.filter((input) => input.type === "text") }] }];
      reply({ turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null } });
      const skill = params.input.find((input) => input.type === "skill");
      const text = params.input.map((input) => input.text ?? "").join("\n") + (skill ? `\n[스킬 ${skill.name} · ${skill.path}]` : "");
      void runTurn(params.threadId, thread, turnId, text, received(params.input));
      return;
    }
    case "turn/steer": {
      const thread = threads.get(params.threadId);
      if (!thread?.turn || thread.turn.id !== params.expectedTurnId) return fail("expected turn is not active");
      thread.turn.steers.push({ text: `${params.input.map((input) => input.text ?? "").join("\n")}${received(params.input)}`, clientId: params.clientUserMessageId ?? null });
      return reply({ turnId: thread.turn.id });
    }
    case "turn/interrupt": {
      const thread = threads.get(params.threadId);
      if (thread?.turn) thread.turn.interrupted = true;
      return reply({});
    }
    case "thread/compact/start": {
      const thread = threads.get(params.threadId);
      if (!thread) return fail("no such thread");
      reply({});
      const turnId = `turn_${++counter}`;
      thread.turn = { id: turnId, steers: [], interrupted: false };
      notify("turn/started", { threadId: params.threadId, turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null } });
      await compact(params.threadId, thread, turnId);
      thread.turn = null;
      notify("turn/completed", { threadId: params.threadId, turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: now(), durationMs: 300 } });
      return;
    }
    default:
      if (id !== undefined) fail(`fake codex does not know ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    // An answer to one of our requests (approval).
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  if (message.method) void handle(message);
});
