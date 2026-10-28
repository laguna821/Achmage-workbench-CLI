#!/usr/bin/env node
// A stand-in for `codex app-server` for browser checks: speaks the same newline-delimited
// JSON-RPC, streams a Markdown answer line by line, takes `turn/steer` and `turn/interrupt`,
// asks for command approval unless the thread runs with approvalPolicy "never", and reports token
// use, rate limits and compaction. No model is involved.
//
// What a request says decides what the fake does:
//   "길게"  a long answer (about 8 s)      "명령"  runs `ls -la` (approval first unless "never")
//   "압축"  compacts the conversation      "느리게" steered requests wait until line 100
//   anything else: a short answer

import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.0.0-fake");
  process.exit(0);
}

const CONTEXT_WINDOW = 258_400;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const now = () => Math.floor(Date.now() / 1000);

const threads = new Map(); // id -> { approvalPolicy, sandbox, cwd, used, turn }
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

async function runTurn(threadId, thread, turnId, text) {
  const started = Date.now();
  notify("turn/started", { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null } });
  let status = "completed";
  const request = { type: "userMessage", id: `user_${++counter}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
  notify("item/started", { threadId, turnId, item: request });
  notify("item/completed", { threadId, turnId, item: request });
  if (text.includes("압축")) {
    await compact(threadId, thread, turnId);
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
  let itemId = `msg_${++counter}`;
  notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "", phase: null, memoryCitation: null } });
  const lines = text.includes("길게") ? 160 : text.includes("도식") ? 14 : 6;
  let full = "";
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
    const line = diagram ? (diagram[index] ?? "") : index % 20 === 0 ? `\n## ${index / 20 + 1}. 단락\n\n` : `${index}번째 줄입니다. 응답이 계속 이어지는 동안 위로 올려 읽을 수 있어야 합니다.\n\n`;
    full += line;
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: line });
    await sleep(text.includes("길게") ? 50 : 30);
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
      return reply({ account: { type: "chatgpt", email: "fake@example.com", planType: "pro" }, requiresOpenaiAuth: true });
    case "account/rateLimits/read":
      return reply({ rateLimits: rateLimits(), rateLimitsByLimitId: null });
    case "model/list":
      return reply({ data: [{ id: "fake-model", model: "fake-model", displayName: "Fake", description: "가짜 모델", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }], defaultReasoningEffort: "medium", isDefault: true }], nextCursor: null });
    case "config/read":
      return reply({ config: { model: null, model_reasoning_effort: null, approval_policy: "on-request", sandbox_mode: "workspace-write", model_auto_compact_token_limit: 232_000 }, origins: {} });
    case "thread/start": {
      const threadId = `thr_${++counter}`;
      const thread = { approvalPolicy: params.approvalPolicy ?? "on-request", sandbox: params.sandbox ?? "workspace-write", cwd: params.cwd ?? "/tmp", used: 11_000, turn: null };
      threads.set(threadId, thread);
      return reply(threadResponse(threadId, thread));
    }
    case "thread/resume": {
      const thread = threads.get(params.threadId) ?? { cwd: params.cwd ?? "/tmp", used: 11_000, turn: null };
      thread.approvalPolicy = params.approvalPolicy ?? thread.approvalPolicy ?? "on-request";
      thread.sandbox = params.sandbox ?? thread.sandbox ?? "workspace-write";
      threads.set(params.threadId, thread);
      return reply(threadResponse(params.threadId, thread));
    }
    case "thread/read": {
      const thread = threads.get(params.threadId);
      if (!thread) return fail("no such thread");
      return reply({ thread: { ...threadResponse(params.threadId, thread).thread, model: "fake-model", reasoningEffort: "medium" } });
    }
    case "turn/start": {
      const thread = threads.get(params.threadId);
      if (!thread) return fail("no such thread");
      if (params.approvalPolicy) thread.approvalPolicy = params.approvalPolicy;
      if (params.sandboxPolicy) thread.sandbox = params.sandboxPolicy.type;
      const turnId = `turn_${++counter}`;
      thread.turn = { id: turnId, steers: [], interrupted: false };
      reply({ turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null } });
      const text = params.input.map((input) => input.text ?? "").join("\n");
      void runTurn(params.threadId, thread, turnId, text);
      return;
    }
    case "turn/steer": {
      const thread = threads.get(params.threadId);
      if (!thread?.turn || thread.turn.id !== params.expectedTurnId) return fail("expected turn is not active");
      thread.turn.steers.push({ text: params.input.map((input) => input.text ?? "").join("\n"), clientId: params.clientUserMessageId ?? null });
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
