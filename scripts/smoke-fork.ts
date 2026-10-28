// Real-engine run (no mocks) of "이 요청 전으로", per engine, in a temp folder: the engine is told
// to remember 7, then 9; a fork made before the second request is asked what it remembers and
// must answer 7 without 9 (the engine's own fork — Codex thread/fork, Claude Code forkSession —
// keeps exactly the first request). Three short turns per engine.
// Usage: node scripts/smoke-fork.ts [claude|codex|all]

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ForkResult, Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const which = (process.argv[2] ?? "all") as Provider | "all";
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-fork-"));
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const child: ChildProcess = spawn(process.execPath, [process.env.HOST_ENTRY ?? "apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "inherit"],
});
const host = await new Promise<{ url: string; token: string }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("host did not start")), 20_000);
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) {
      clearTimeout(timer);
      resolve(JSON.parse(line.slice(16)));
    }
  });
});

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${json.message}`);
  return json;
}
const sessionOf = async (id: string) => (await api<Snapshot>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
async function waitIdle(id: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, 800));
  while (Date.now() < deadline) {
    if ((await sessionOf(id)).status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("timeout");
}
const ask = async (id: string, text: string) => {
  await api("POST", `/api/sessions/${id}/messages`, { requestId: randomUUID(), text });
  await waitIdle(id);
  const last = (await items(id)).filter((item) => item.kind === "assistant").at(-1);
  return last?.kind === "assistant" ? last.text.trim() : "";
};

async function run(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const cwd = mkdtempSync(join(tmpdir(), `wb-fork-${provider}-`));
  const work = await api<Work>("POST", "/api/works", { title: `${label} 갈래 확인`, cwd });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "갈래", access: "auto" });
  try {
    await ask(session.id, "숫자 하나를 기억해 줘: 7. 도구는 쓰지 말고 '기억함'이라고만 답해.");
    await ask(session.id, "숫자 하나 더 기억해 줘: 9. 도구는 쓰지 말고 '기억함'이라고만 답해.");
    const second = (await items(session.id)).filter((item) => item.kind === "user")[1]!;
    const { session: forked } = await api<ForkResult>("POST", `/api/sessions/${session.id}/fork`, { itemId: second.id });
    record(`[${label}] 두 번째 요청 앞에서 갈래를 만듦(엔진 자체 갈래)`, Boolean(forked.nativeSessionId) && forked.nativeSessionId !== (await sessionOf(session.id)).nativeSessionId, forked.nativeSessionId ?? "엔진 대화 없음");
    const answer = await ask(forked.id, "지금까지 기억하라고 한 숫자를 모두, 숫자만 쉼표로 답해. 도구는 쓰지 마.");
    record(`[${label}] 갈래는 첫 요청까지만 기억함(7만, 9는 없음)`, /7/.test(answer) && !/9/.test(answer), answer.slice(0, 40));
    const original = await sessionOf(session.id);
    record(`[${label}] 원래 세션은 그대로`, original.nativeSessionId === (await sessionOf(session.id)).nativeSessionId && (await items(session.id)).filter((item) => item.kind === "user").length === 2);
  } catch (error) {
    record(`[${label}] 갈래`, false, error instanceof Error ? error.message : String(error));
    await api("POST", `/api/sessions/${session.id}/interrupt`).catch(() => undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

try {
  for (const provider of (which === "all" ? ["codex", "claude"] : [which]) as Provider[]) await run(provider);
} finally {
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
