#!/usr/bin/env node
// A STAND-IN for Google's Antigravity CLI (`agy`) for tests and checks. It is not agy, contains none of
// its code, never contacts any Google service and signs nobody in. It speaks the Agent Client Protocol
// (agentclientprotocol.com, v1: newline-delimited JSON-RPC 2.0 over stdio) the way the public ACP docs
// and agy's public CHANGELOG describe `agy acp`, so Workbench's ACP client can be developed and checked
// on a machine where the real CLI must never run.
//
//   fake-agy --version                 prints "agy <FAKE_AGY_VERSION or 1.5.13>"
//   fake-agy acp --login               a terminal sign-in stand-in: asks for a code on stdin, then marks
//                                      <FAKE_ENGINE_AUTH_DIR>/agy as signed in (no address, no network)
//   fake-agy acp [--disable-telemetry] the ACP server
//
// Signed in: FAKE_ENGINE_AUTH_DIR unset, or <dir>/agy exists (after the terminal sign-in). It still lists the
// sign-in methods agy offers (Workbench uses only agy's own terminal sign-in). Otherwise session/new, session/load and session/list
// fail with -32000 "Authentication required", as Google's ACP guide says.
// FAKE_AGY_LOG: every start (argv, which Google/Gemini variables it got — names only) and every request
// (method and params; prompt text and image sizes) is appended there as JSON lines.
// FAKE_AGY_STATE: a folder where sessions are kept (for session/load across processes).
//
// What a prompt says decides what the stand-in does:
//   "파일" / "고쳐"   edits <cwd>/<name> (the name after "파일:" or notes.md): a tool_call of kind edit, a
//                     permission request unless the mode is accept-edits, then a diff on completion
//   "명령"            a tool_call of kind execute (`ls`), always asking first ("항상만": offering only allow_always)
//   "읽어"            a tool_call of kind read with a location
//   "계획"            a plan update (three entries)
//   "길게"            a long answer (about 10 s of chunks) — for 멈춤 (session/cancel)
//   "실패해"          the prompt fails with a quota error
//   "견본"            reasoning, a plan, a read, an edit (asks unless accept-edits) and a formatted answer
//   "코덱스에서 한 작업 보고 이어서" (or 클로드 / 제미나이): starts the "workbench-peers" MCP server the client passed
//                     in session/new (stdio), calls list_conversations, then read_conversation on the newest
//                     conversation of that engine, and names what it read (a tool_call of kind other shows it)
// Images in the prompt are named back first ("받은 그림 N장 · B바이트"). A second session/prompt while
// one runs is taken into the running turn (agy 1.5.0 "steering"): "끼어든 요청을 받았습니다: …".
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// FAKE_AGY_VERSION_FILE (checks): the version is read from there on each start, so a check can make agy "old" and "new" again.
const versionFile = (() => { try { return process.env.FAKE_AGY_VERSION_FILE ? readFileSync(process.env.FAKE_AGY_VERSION_FILE, "utf8").trim() : ""; } catch { return ""; } })();
const VERSION = versionFile || process.env.FAKE_AGY_VERSION || "1.5.13";
const args = process.argv.slice(2);
const log = (entry) => { if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`); };
const authDir = process.env.FAKE_ENGINE_AUTH_DIR || null;
const stateDir = process.env.FAKE_AGY_STATE || join(tmpdir(), "fake-agy-state");
const googleVars = Object.keys(process.env).filter((name) => /^(GEMINI_|GOOGLE_|CLOUDSDK_|AGY_|VERTEX)/i.test(name)).sort();

if (args[0] === "--version" || args[0] === "-v") {
  process.stdout.write(`agy ${VERSION}\n`);
  process.exit(0);
}
log({ event: "start", argv: args, googleVars, cwd: process.cwd() });
if (args[0] !== "acp") {
  process.stderr.write("fake-agy: only `--version` and `acp` are supported (stand-in)\n");
  process.exit(2);
}
if (args.includes("--login")) {
  process.stdout.write("Antigravity sign-in (Workbench stand-in — not Google's CLI)\n");
  process.stdout.write("Paste the code from your browser: ");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (authDir) { mkdirSync(authDir, { recursive: true }); writeFileSync(join(authDir, "agy"), "signed-in\n"); }
    process.stdout.write("\nSigned in. You can close this terminal.\n");
    log({ event: "login" });
    rl.close();
    setTimeout(() => process.exit(0), 50);
  });
  process.stdin.on("end", () => process.exit(1));
} else {
  server();
}

function server() {
  const signedIn = () => !authDir || existsSync(join(authDir, "agy"));
  // FAKE_AGY_SUSPENDED_FILE: while it exists the account is "blocked for a Terms of Service violation" (agy's
  // wording in its CHANGELOG), with an appeal address — a fixture string, never opened.
  const suspended = () => Boolean(process.env.FAKE_AGY_SUSPENDED_FILE && existsSync(process.env.FAKE_AGY_SUSPENDED_FILE));
  const SUSPENDED = "This account has been disabled for violation of Terms of Service. To appeal, visit https://antigravity.google/appeal-standin";
  const sessions = new Map();
  let nextRequest = 1000;
  const waiting = new Map();
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });
  const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
  const ask = (method, params) => new Promise((resolveAnswer) => { const id = nextRequest++; waiting.set(id, resolveAnswer); send({ id, method, params }); });
  const file = (id) => join(stateDir, `${id.replace(/[^\w-]/g, "_")}.json`);
  const save = (session) => { mkdirSync(stateDir, { recursive: true }); writeFileSync(file(session.id), JSON.stringify({ id: session.id, cwd: session.cwd, history: session.history, mode: session.mode, model: session.model, thought: session.thought, title: session.title, updatedAt: Date.now() })); };
  const load = (id) => { try { return JSON.parse(readFileSync(file(id), "utf8")); } catch { return null; } };
  const config = (session) => [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: session.mode, options: [
      { value: "default", name: "Default", description: "Ask before edits and commands" },
      { value: "accept-edits", name: "Accept edits", description: "Edit files in the workspace without asking" },
      { value: "plan", name: "Plan", description: "Read and plan only" },
    ] },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: [
      { value: "standin-pro", name: "Stand-in Pro", description: "The stand-in's larger model (fixture)" },
      { value: "standin-flash", name: "Stand-in Flash", description: "The stand-in's fast model (fixture)" },
    ] },
    { id: "thinking", name: "Thinking level", category: "thought_level", type: "select", currentValue: session.thought, options: [
      { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" },
    ] },
  ];
  const usage = (session) => update(session.id, { sessionUpdate: "usage_update", used: 1200 + session.history.length * 800, size: 1_000_000 });
  const opened = (session) => {
    sessions.set(session.id, session);
    setTimeout(() => {
      update(session.id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the conversation" }, { name: "usage", description: "Show your quota (stand-in)" }] });
      usage(session);
    }, 10);
  };
  const fresh = (id, cwd, saved) => ({ id, cwd, history: saved?.history ?? [], mode: saved?.mode ?? "default", model: saved?.model ?? "standin-pro", thought: saved?.thought ?? "medium", title: saved?.title ?? null, running: null, steers: [], cancelled: false, mcp: [] });
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  async function chunks(session, text, pace = 15) {
    for (const piece of text.match(/[\s\S]{1,24}/g) ?? []) {
      if (session.cancelled) return false;
      update(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
      await sleep(pace);
    }
    return !session.cancelled;
  }

  async function permission(session, toolCall, kinds = ["allow_once", "allow_always", "reject_once"]) {
    const names = { allow_once: "Allow once", allow_always: "Always allow", reject_once: "Reject", reject_always: "Always reject" };
    const answer = await ask("session/request_permission", { sessionId: session.id, toolCall, options: kinds.map((kind) => ({ optionId: kind.replace("_", "-"), name: names[kind], kind })) });
    log({ event: "permission-answer", answer });
    return answer?.outcome?.outcome === "selected" && /^allow/.test(answer.outcome.optionId) ? "allow" : answer?.outcome?.outcome === "cancelled" ? "cancelled" : "reject";
  }

  async function edit(session, text) {
    const name = /파일:\s*([\w.\-가-힣/]+)/.exec(text)?.[1] ?? "notes.md";
    const path = resolve(session.cwd, name);
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const after = `${before}${before && !before.endsWith("\n") ? "\n" : ""}Gemini 대역이 고친 줄입니다.\n`;
    const toolCallId = `edit-${Date.now()}`;
    update(session.id, { sessionUpdate: "tool_call", toolCallId, title: `Edit ${name}`, kind: "edit", status: "pending", locations: [{ path }], rawInput: { Path: path } });
    if (session.mode !== "accept-edits") {
      const decision = await permission(session, { toolCallId, title: `Edit ${name}`, kind: "edit", locations: [{ path }] });
      if (decision !== "allow") {
        update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: decision === "cancelled" ? "cancelled" : "The user rejected this edit." } }] });
        return decision;
      }
    }
    update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    writeFileSync(path, after);
    update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", locations: [{ path }], content: [{ type: "diff", path, oldText: before || null, newText: after }] });
    return "allow";
  }

  /** One MCP server the client handed over (stdio), asked a few tools/call requests in order. */
  function mcpCalls(server, calls) {
    return new Promise((done) => {
      const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])) };
      const child = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "pipe"] });
      const answers = [];
      let next = 1, buffer = "";
      const send = (method, params, id) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params })}\n`);
      const ask = () => {
        const call = calls[answers.length];
        if (!call) { child.stdin.end(); child.kill(); return done(answers); }
        send("tools/call", { name: call.name, arguments: typeof call.arguments === "function" ? call.arguments(answers) : call.arguments }, ++next);
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) { send("notifications/initialized", {}); ask(); continue; }
          answers.push((message.result?.content ?? []).map((part) => part.text ?? "").join("") || message.error?.message || "");
          ask();
        }
      });
      child.on("error", (error) => done([...answers, `시작하지 못함: ${error.message}`]));
      send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: VERSION } }, 1);
      setTimeout(() => { child.kill(); done(answers); }, 30_000).unref();
    });
  }

  async function prompt(id, params) {
    const session = sessions.get(params.sessionId);
    if (!session) return fail(id, -32602, "Session not found");
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const images = blocks.filter((block) => block.type === "image");
    log({ event: "prompt", sessionId: session.id, text, images: images.map((image) => ({ mimeType: image.mimeType, bytes: Buffer.from(image.data ?? "", "base64").length })), resources: blocks.filter((block) => block.type === "resource_link" || block.type === "resource").map((block) => block.uri ?? block.resource?.uri) });
    // Steering: a prompt while one runs joins it (agy 1.5.0); it is answered when the turn ends.
    if (session.running) {
      session.steers.push({ id, text });
      session.history.push({ role: "user", text });
      return;
    }
    session.running = { id };
    session.cancelled = false;
    session.history.push({ role: "user", text });
    if (!session.title) session.title = text.slice(0, 40);
    let answer = "";
    const finish = (stopReason) => {
      if (answer) session.history.push({ role: "agent", text: answer });
      save(session);
      usage(session);
      const steers = session.steers.splice(0);
      session.running = null;
      reply(id, { stopReason });
      for (const steer of steers) reply(steer.id, { stopReason });
    };
    const say = async (part, pace) => { answer += part; return chunks(session, part, pace); };
    if (suspended()) {
      session.running = null;
      return fail(id, -32000, SUSPENDED);
    }
    if (/실패해/.test(text)) {
      session.running = null;
      return fail(id, -32603, "RESOURCE_EXHAUSTED: quota exceeded for this account (stand-in)");
    }
    update(session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "요청을 살펴보는 중입니다." } });
    await sleep(30);
    if (images.length) await say(`받은 그림 ${images.length}장 · ${images.reduce((sum, image) => sum + Buffer.from(image.data ?? "", "base64").length, 0)}바이트\n\n`);
    const asked = /(코덱스|클로드|제미나이|다른 대화)에서 한 작업 보고 이어서/.exec(text);
    if (asked) {
      const engine = { 코덱스: "Codex", 클로드: "Claude", 제미나이: "Gemini" }[asked[1]] ?? null;
      const server = session.mcp.find((entry) => entry.name === "workbench-peers");
      const toolCallId = `peers-${Date.now()}`;
      update(session.id, { sessionUpdate: "tool_call", toolCallId, title: "workbench-peers · read_conversation", kind: "other", status: "in_progress" });
      if (!server) {
        update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
        await say("다른 대화를 읽는 도구(workbench-peers)를 받지 못했습니다.\n");
      } else {
        let pick = null;
        const [list, read] = await mcpCalls(server, [
          { name: "list_conversations", arguments: {} },
          { name: "read_conversation", arguments: (answers) => {
            const rows = [...String(answers[0] ?? "").matchAll(/^- id (\S+) · 「([^」]*)」 · (\S+) ·/gm)];
            pick = rows.find((row) => !engine || row[3] === engine) ?? null;
            return { id: pick?.[1] ?? "none" };
          } },
        ]);
        log({ event: "peers", list, read });
        update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: pick ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: String(read ?? list ?? "").slice(0, 2000) } }] });
        const field = (name) => String(read ?? "").match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "(없음)";
        await say(pick ? `읽은 대화: 「${pick[2]}」 (${pick[3]})\n그 대화의 요청: ${field("요청")}\n그 대화의 답: ${field("답")}\n이어서 하겠습니다.\n\n` : `읽을 ${engine ?? ""} 대화를 찾지 못했습니다.\n\n`);
      }
    }
    if (/계획|견본/.test(text)) {
      update(session.id, { sessionUpdate: "plan", entries: [
        { content: "파일을 읽습니다", priority: "high", status: "completed" },
        { content: "고칠 곳을 정합니다", priority: "medium", status: "in_progress" },
        { content: "결과를 알립니다", priority: "low", status: "pending" },
      ] });
    }
    if (/읽어|견본/.test(text)) {
      const path = resolve(session.cwd, "README.md");
      update(session.id, { sessionUpdate: "tool_call", toolCallId: `read-${Date.now()}`, title: "Read README.md", kind: "read", status: "completed", locations: [{ path, line: 1 }] });
    }
    if (/명령/.test(text)) {
      const toolCallId = `exec-${Date.now()}`;
      update(session.id, { sessionUpdate: "tool_call", toolCallId, title: "ls", kind: "execute", status: "pending", rawInput: { command: "ls" } });
      // "항상만": agy offers only "always allow" (and reject) for this command.
      const decision = await permission(session, { toolCallId, title: "ls", kind: "execute", rawInput: { command: "ls" } }, /항상만/.test(text) ? ["allow_always", "reject_once"] : undefined);
      if (decision === "allow") update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "README.md\nnotes.md\n" } }] });
      else update(session.id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      if (decision === "cancelled" || session.cancelled) return finish("cancelled");
    }
    if (/파일|고쳐|견본/.test(text)) {
      const decision = await edit(session, text);
      if (decision === "cancelled" || session.cancelled) return finish("cancelled");
      await say(decision === "allow" ? "파일을 고쳤습니다.\n\n" : "고치지 않았습니다(거절됨).\n\n");
    }
    if (/길게/.test(text)) {
      for (let line = 1; line <= 60; line++) if (!(await say(`${line}번째 줄입니다.\n`, 80))) return finish("cancelled");
    }
    if (/견본/.test(text)) {
      if (!(await say("## 정리\n\n- 읽은 파일: README.md\n- 고친 파일: notes.md\n\n| 항목 | 상태 |\n| --- | --- |\n| 읽기 | 끝 |\n| 고치기 | 끝 |\n\n```js\nconsole.log(\"stand-in\");\n```\n"))) return finish("cancelled");
    }
    await sleep(40);
    if (session.cancelled) return finish("cancelled");
    if (session.steers.length) await say(`\n끼어든 요청을 받았습니다: ${session.steers.map((steer) => steer.text).join(" / ")}\n`);
    if (!(await say(`Gemini 대역 답입니다 (${session.model} · ${session.thought} · ${session.mode}).`))) return finish("cancelled");
    finish("end_turn");
  }

  const methods = {
    initialize: (params) => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { list: {} } },
      agentInfo: { name: "antigravity-standin", title: "Antigravity ACP Server (Workbench stand-in)", version: VERSION },
      authMethods: [
        { id: "oauth-personal", name: "Google account", description: "Opens a browser sign-in for a personal Google account (stand-in: not available)" },
        { id: "oauth-business", name: "Google Workspace / Enterprise" },
        { id: "gemini-api-key", name: "Gemini API key", description: "Uses GEMINI_API_KEY" },
        { id: "agent-platform", name: "Agent Platform" },
        { id: "terminal-login", name: "Sign in from a terminal", type: "terminal", args: ["--login"] },
      ],
      // FAKE_AGY_NO_APPEND: an agy that offers no place for client instructions.
      _meta: { ...(process.env.FAKE_AGY_NO_APPEND ? {} : { antigravity: { systemPrompt: { append: true } } }), initializedWith: params?.clientInfo?.name ?? null },
    }),
    authenticate: (params) => {
      throw Object.assign(new Error("This authentication method is not available in the stand-in"), { code: -32000 });
    },
    "session/new": (params) => {
      if (suspended()) throw Object.assign(new Error(SUSPENDED), { code: -32000 });
      if (!signedIn()) throw Object.assign(new Error("Authentication required"), { code: -32000 });
      const id = `standin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const session = fresh(id, params?.cwd && isAbsolute(params.cwd) ? params.cwd : process.cwd());
      session.mcp = params?.mcpServers ?? [];
      opened(session);
      save(session);
      return { sessionId: id, configOptions: config(session) };
    },
    "session/load": async (params) => {
      if (suspended()) throw Object.assign(new Error(SUSPENDED), { code: -32000 });
      if (!signedIn()) throw Object.assign(new Error("Authentication required"), { code: -32000 });
      const saved = load(String(params?.sessionId ?? ""));
      if (!saved) throw Object.assign(new Error("Session not found"), { code: -32002 });
      const session = fresh(saved.id, params?.cwd ?? saved.cwd, saved);
      session.mcp = params?.mcpServers ?? [];
      // The whole conversation is replayed before the answer, as the ACP spec says.
      for (const entry of saved.history) update(saved.id, { sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
      opened(session);
      return { configOptions: config(session) };
    },
    "session/list": () => {
      if (suspended()) throw Object.assign(new Error(SUSPENDED), { code: -32000 });
      if (!signedIn()) throw Object.assign(new Error("Authentication required"), { code: -32000 });
      return { sessions: [] };
    },
    "session/set_config_option": (params) => {
      const session = sessions.get(params?.sessionId);
      if (!session) throw Object.assign(new Error("Session not found"), { code: -32602 });
      const key = { mode: "mode", model: "model", thinking: "thought" }[params.configId];
      const option = config(session).find((entry) => entry.id === params.configId);
      if (!key || !option?.options.some((entry) => entry.value === params.value)) throw Object.assign(new Error(`Unknown value ${params.value}`), { code: -32602 });
      session[key] = params.value;
      setTimeout(() => usage(session), 5);
      return { configOptions: config(session) };
    },
    "session/set_mode": (params) => {
      const session = sessions.get(params?.sessionId);
      if (!session) throw Object.assign(new Error("Session not found"), { code: -32602 });
      session.mode = params.modeId;
      return {};
    },
  };

  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const answer = waiting.get(message.id);
      waiting.delete(message.id);
      answer?.(message.result ?? null);
      return;
    }
    log({ event: "request", method: message.method, params: message.method === "session/prompt" ? { sessionId: message.params?.sessionId } : message.params });
    if (message.method === "session/cancel") {
      const session = sessions.get(message.params?.sessionId);
      if (session?.running) session.cancelled = true;
      return;
    }
    if (message.method === "session/prompt") return void prompt(message.id, message.params ?? {});
    const handler = methods[message.method];
    if (!handler) return message.id !== undefined ? fail(message.id, -32601, `Method not found: ${message.method}`) : undefined;
    try {
      reply(message.id, await handler(message.params ?? {}));
    } catch (error) {
      fail(message.id, error.code ?? -32603, error.message);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
