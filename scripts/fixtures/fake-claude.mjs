#!/usr/bin/env node
// A stand-in for the `claude` CLI as the Claude Agent SDK drives it (stream-json over stdio), for
// browser checks: answers `initialize`, streams a Markdown answer, asks `can_use_tool` before a
// command unless the permission mode lets it through, runs a request sent with priority "next"
// as the turn right after the current one (`queued_turn_count`), stops on `interrupt`, and reports
// rate limits, token use and compaction like Claude Code. No model is involved.
//
// What a request says decides what the fake does:
//   "길게"  a long answer (about 8 s)      "명령"  runs `ls -la` (asks first in "default" mode)
//   "압축" or "/compact"  compacts         anything else: a short answer
// Image and PDF blocks in a request are reported at the start of the answer ("받은 그림 1장 · 1234바이트").
// "스크린샷": like a browsing step, Bash saves a screenshot (Playwright CLI's output names it), then
// Read opens a second picture, which comes back as an image block.
// "/정리 …" runs the stand-in's one user skill (it says so); /compact compacts.
// In plan mode ("계획 먼저") it writes a plan and ends with ExitPlanMode, which asks first; approved
// (with the mode it is set to) it goes ahead in the same turn, declined it waits.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pagePng } from "./png.mjs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.999 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "fake@example.com", subscriptionType: "max" }));
  process.exit(0);
}

const option = (name) => {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return args[index + 1];
    if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
  }
  return undefined;
};

const MODEL = "claude-fake-1";
const CONTEXT_WINDOW = 200_000;
const sessionId = option("--resume") ?? randomUUID();
let permissionMode = option("--permission-mode") ?? "default";
let initialized = false;
let used = 14_000;
let rateUsed = 0.31;
let turn = null; // { interrupted }
const queue = []; // { text, uuid } user messages waiting to run
const waiting = new Map(); // control request id -> resolve

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const base = () => ({ session_id: sessionId, uuid: randomUUID() });
const event = (payload) => send({ type: "stream_event", event: payload, parent_tool_use_id: null, ...base() });

function ask(request) {
  const id = randomUUID().slice(0, 12);
  send({ type: "control_request", request_id: id, request });
  return new Promise((done) => waiting.set(id, done));
}

function systemInit() {
  if (initialized) return;
  initialized = true;
  send({
    type: "system", subtype: "init", cwd: process.cwd(), tools: ["Bash", "Read", "Edit", "Write"], mcp_servers: [], model: MODEL,
    permissionMode, slash_commands: ["compact"], apiKeySource: "none", claude_code_version: "2.1.999", output_style: "default",
    agents: [], skills: [], plugins: [], ...base(),
  });
}

async function streamText(text, chunks) {
  const id = `msg_${randomUUID().slice(0, 8)}`;
  event({ type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: used } } });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  let full = "";
  for (const chunk of chunks) {
    if (turn?.interrupted) break;
    full += chunk.text;
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk.text } });
    await sleep(chunk.wait);
  }
  event({ type: "content_block_stop", index: 0 });
  event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: full.length } });
  event({ type: "message_stop" });
  send({ type: "assistant", message: { id, type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: full || text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: full.length, cache_creation_input_tokens: 0, cache_read_input_tokens: used } }, parent_tool_use_id: null, ...base() });
  return full;
}

async function compact(trigger) {
  send({ type: "system", subtype: "status", status: "compacting", ...base() });
  await sleep(300);
  const before = used;
  used = Math.round(used * 0.2);
  send({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger, pre_tokens: before, post_tokens: used, duration_ms: 300 }, ...base() });
  send({ type: "system", subtype: "status", status: null, compact_result: "success", ...base() });
}

async function runTurn(text) {
  const started = Date.now();
  turn = { interrupted: false };
  systemInit();
  send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600, rateLimitType: "five_hour", utilization: rateUsed }, ...base() });
  let answer = "";
  if (text.trim() === "/compact" || text.includes("압축")) {
    await compact(text.trim() === "/compact" ? "manual" : "auto");
  }
  if (text.includes("명령")) {
    const toolId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { command: "ls -la", description: "폴더 내용 확인" };
    send({ type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "tool_use", id: toolId, name: "Bash", input }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: used } }, parent_tool_use_id: null, ...base() });
    let allowed = permissionMode === "bypassPermissions" || permissionMode === "dontAsk";
    if (!allowed) {
      const answerToTool = await ask({ subtype: "can_use_tool", tool_name: "Bash", input, tool_use_id: toolId, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls -la" }], behavior: "allow", destination: "localSettings" }], decision_reason: "명령 실행은 확인이 필요합니다" });
      allowed = answerToTool?.behavior === "allow";
    }
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: allowed ? "total 0" : "The user declined this action.", is_error: !allowed }] }, parent_tool_use_id: null, ...base() });
  }
  if (permissionMode === "plan" && text.trim() !== "/compact") {
    const plan = "## 계획\n\n1. 지금 상태 살펴보기\n2. 고칠 곳 고치기\n3. 결과 확인하기";
    await streamText("", [{ text: "살펴보고 계획을 세웠습니다.\n\n", wait: 30 }]);
    const toolId = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { plan };
    send({ type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "tool_use", id: toolId, name: "ExitPlanMode", input }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: used } }, parent_tool_use_id: null, ...base() });
    const decided = await ask({ subtype: "can_use_tool", tool_name: "ExitPlanMode", input, tool_use_id: toolId, decision_reason: "계획 확인" });
    const approved = decided?.behavior === "allow";
    const setMode = (decided?.updatedPermissions ?? []).find((update) => update.type === "setMode");
    if (approved) permissionMode = setMode?.mode ?? "default";
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: approved ? "User has approved your plan." : decided?.message ?? "declined", is_error: !approved }] }, parent_tool_use_id: null, ...base() });
    const reply = approved ? `계획대로 진행합니다 (권한: ${permissionMode}).\n\n` : "계획을 더 다듬겠습니다. 바꿀 점을 알려 주세요.\n\n";
    answer = await streamText("", [{ text: reply, wait: 30 }]);
    used += 3_000;
    const usage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: used, output_tokens: 40, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard" };
    const interrupted = turn.interrupted;
    turn = null;
    send({ type: "result", subtype: interrupted ? "error_during_execution" : "success", is_error: interrupted, ...(interrupted ? { errors: ["Request interrupted by user"] } : { result: answer }), stop_reason: interrupted ? null : "end_turn", duration_ms: Date.now() - started, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0.01, usage, modelUsage: {}, permission_denials: [], queued_turn_count: queue.length, ...base() });
    return;
  }
  if (text.includes("스크린샷")) {
    const step = (name, input, content) => {
      const toolId = `toolu_${randomUUID().slice(0, 8)}`;
      send({ type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "tool_use", id: toolId, name, input }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: used } }, parent_tool_use_id: null, ...base() });
      send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content }] }, parent_tool_use_id: null, ...base() });
    };
    const folder = join(process.cwd(), ".playwright-cli");
    mkdirSync(folder, { recursive: true });
    const stamp = Date.now();
    writeFileSync(join(folder, `page-${stamp}.png`), pagePng());
    step("Bash", { command: "playwright-cli screenshot", description: "화면 찍기" }, `### Result\n- [Screenshot of viewport](.playwright-cli/page-${stamp}.png)\n`);
    await sleep(60);
    const full = pagePng(300, 260, [31, 158, 117]);
    writeFileSync(join(folder, `full-${stamp}.png`), full);
    step("Read", { file_path: join(folder, `full-${stamp}.png`) }, [{ type: "image", source: { type: "base64", media_type: "image/png", data: full.toString("base64") } }]);
  }
  if (!(text.trim() === "/compact")) {
    const steer = text.startsWith("[steer]") ? `이어서 받은 요청을 반영합니다: ${text.slice(7)}\n\n` : "";
    const skill = text.match(/^\/정리(?:\s+(.*))?$/s);
    const seen = !steer && text.match(/ \((받은 [^)]*)\)$/);
    const long = text.includes("길게");
    const lines = long ? 160 : 6;
    const chunks = [];
    if (steer) chunks.push({ text: steer, wait: 30 });
    if (skill) chunks.push({ text: `스킬 /정리를 실행했습니다: ${skill[1] ?? ""}\n\n`, wait: 30 });
    if (seen) chunks.push({ text: `요청을 받았습니다 (${seen[1]}).\n\n`, wait: 30 });
    if (text.includes("도식")) {
      // A Mermaid mind map, sent in pieces like any reply.
      for (const piece of "여기 마인드맵입니다.\n\n```mermaid\nmindmap\n  root((Achmage))\n    대화\n      끼어들기\n      끝나면 보내기\n    문서\n      워드\n      한글\n    도식\n      Pele\n```\n".match(/[^\n]*\n/g)) chunks.push({ text: piece, wait: 30 });
    } else {
      for (let index = 0; index < lines; index += 1) {
        chunks.push({ text: index % 20 === 0 ? `\n## ${index / 20 + 1}. 단락\n\n` : `${index}번째 줄입니다. 응답이 계속 이어지는 동안 위로 올려 읽을 수 있어야 합니다.\n\n`, wait: long ? 50 : 30 });
      }
    }
    answer = await streamText("", chunks);
  }
  used += 6_000 + answer.length;
  rateUsed = Math.min(1, rateUsed + 0.02);
  const interrupted = turn.interrupted;
  turn = null;
  const usage = { input_tokens: 12, cache_creation_input_tokens: 500, cache_read_input_tokens: used, output_tokens: answer.length, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard" };
  const modelUsage = { [MODEL]: { inputTokens: 12, outputTokens: answer.length, cacheReadInputTokens: used, cacheCreationInputTokens: 500, webSearchRequests: 0, costUSD: 0.01, contextWindow: CONTEXT_WINDOW, maxOutputTokens: 32_000 } };
  const common = { duration_ms: Date.now() - started, duration_api_ms: Date.now() - started, num_turns: 1, total_cost_usd: 0.01, usage, modelUsage, permission_denials: [], queued_turn_count: queue.length, ...base() };
  if (interrupted) {
    send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request interrupted by user"], stop_reason: null, ...common });
  } else {
    send({ type: "result", subtype: "success", is_error: false, result: answer, stop_reason: "end_turn", ...common });
  }
}

let running = false;
async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const next = queue.shift();
    await runTurn(next.text);
  }
  running = false;
}

function textOf(message) {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n") + received(content ?? []);
}

/** What the fake saw of the pictures and PDFs it was given (decoded, so a bad block shows). */
function received(content) {
  const seen = [];
  const images = content.filter((part) => part.type === "image");
  const pdfs = content.filter((part) => part.type === "document");
  if (images.length) seen.push(`받은 그림 ${images.length}장 · ${images.map((part) => `${Buffer.from(part.source.data, "base64").length}바이트`).join(", ")}`);
  if (pdfs.length) seen.push(`받은 PDF ${pdfs.length}개 · ${pdfs.map((part) => `${Buffer.from(part.source.data, "base64").length}바이트`).join(", ")}`);
  const named = namedFiles(content.map((part) => part.text ?? "").join("\n"));
  if (named.length) seen.push(`받은 파일 경로 ${named.length}개 · ${named.map((path) => (existsSync(path) ? `${statSync(path).size}바이트` : "없는 파일")).join(", ")}`);
  return seen.length ? ` (${seen.join(" / ")})` : "";
}

/** Paths listed under "첨부한 파일:" (files the engine is to open itself). */
function namedFiles(text) {
  const at = text.indexOf("첨부한 파일:\n");
  if (at < 0) return [];
  return text.slice(at).split("\n").slice(1).map((line) => line.match(/^- .+?: (\/.+)$/)?.[1]).filter(Boolean);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "control_response") {
    waiting.get(message.response.request_id)?.(message.response.response);
    waiting.delete(message.response.request_id);
    return;
  }
  if (message.type === "control_request") {
    const { request_id: id, request } = message;
    const reply = (response) => send({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    switch (request.subtype) {
      case "initialize":
        return reply({ commands: [{ name: "compact", description: "대화 압축", argumentHint: "", builtin: true }, { name: "정리", description: "글을 짧게 정리하는 스킬(가짜)", argumentHint: "[주제]" }], models: [{ value: "default", displayName: "Fake (기본)", description: "가짜 모델", supportedEffortLevels: ["low", "medium", "high"] }], account: { email: "fake@example.com", subscriptionType: "max" }, output_style: "default", available_output_styles: ["default"] });
      case "interrupt": {
        if (turn) turn.interrupted = true;
        // Like Claude Code: queued requests survive a plain interrupt (still_queued) and are
        // dropped with cancel_queued.
        const uuids = queue.map((entry) => entry.uuid).filter(Boolean);
        if (request.cancel_queued) {
          queue.length = 0;
          return reply({ still_queued: [], cancelled: uuids });
        }
        return reply({ still_queued: uuids });
      }
      case "cancel_async_message": {
        const index = queue.findIndex((entry) => entry.uuid === request.message_uuid);
        if (index >= 0) queue.splice(index, 1);
        return reply({ cancelled: index >= 0 });
      }
      case "set_permission_mode":
        permissionMode = request.mode;
        return reply({});
      case "get_usage": {
        const iso = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();
        return reply({
          session: { total_cost_usd: 0.01, total_api_duration_ms: 1, total_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: Math.round(rateUsed * 100), resets_at: iso(3) }, seven_day: { utilization: 12, resets_at: iso(90) } },
        });
      }
      case "get_context_usage":
        return reply({ categories: [{ name: "Messages", tokens: used, color: "blue", kind: "used" }], totalTokens: used, maxTokens: CONTEXT_WINDOW, rawMaxTokens: CONTEXT_WINDOW, percentage: Math.round((used / CONTEXT_WINDOW) * 1000) / 10, gridRows: [], model: MODEL, memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: Math.round(CONTEXT_WINDOW * 0.92) });
      default:
        return reply({});
    }
  }
  if (message.type === "user") {
    // A request sent while a turn runs waits for the next turn, as Claude Code does when the turn
    // has no further tool step to fold it into.
    queue.push({ text: running && message.priority ? `[steer]${textOf(message)}` : textOf(message), uuid: message.uuid ?? null });
    void drain();
  }
});
