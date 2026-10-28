// Real-engine run (no mocks) of what only the engines themselves can show for the vault layer:
// a new session reads its context card (Claude: systemPrompt.append; Codex: developerInstructions),
// and an attempt to write into the vault is stopped (Claude: the SDK PreToolUse hook; Codex: the
// sandbox keeps the vault out of its writable roots). One short turn per engine, on "자동" access,
// against a fixture vault in a temporary folder (never the user's vault). Nothing is published.
// Usage: node scripts/smoke-pkm.ts [claude|codex|all]

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { makePkmVault } from "./fixtures/pkm-vault.ts";

const which = (process.argv[2] ?? "all") as Provider | "all";
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-pkm-"));
const vault = makePkmVault(mkdtempSync(join(tmpdir(), "workbench-smoke-vault-")));
const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const child: ChildProcess = spawn(process.execPath, [process.env.HOST_ENTRY ?? "apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_VAULT_SUGGEST: vault },
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
  const response = await fetch(`${host.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${json.message}`);
  return json;
}
const sessionOf = async (id: string) => (await api<Snapshot>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timeout: ${label}`);
}

await api("PUT", "/api/pkm/vault", { path: vault });
const inboxBefore = readdirSync(join(vault, "01. Inbox")).sort().join("|");

async function run(provider: Provider) {
  const label = provider === "claude" ? "Claude" : "Codex";
  const work = await api<Work>("POST", "/api/works", { title: `볼트 점검 ${label}`, cwd: mkdtempSync(join(tmpdir(), `workbench-smoke-pkm-${provider}-`)) });
  await api("PUT", "/api/pkm/pins", { workId: work.id, path: "20. Information (I)/용어 정리.md", pinned: true });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "점검", access: "auto" });
  const target = join(vault, "01. Inbox", `${provider}-real.md`);
  await api("POST", `/api/sessions/${session.id}/messages`, {
    requestId: randomUUID(),
    text: `두 가지만 짧게 해 주세요. (1) 시스템 맥락 카드에 적힌 "작업:" 줄과 "고정한 노트" 경로를 그대로 한 줄씩 옮겨 적기. (2) 파일 도구(또는 셸)로 ${target} 에 "x" 한 글자를 쓰기 시도하고, 성공했는지 막혔는지 한 줄로 알리기. 다른 일은 하지 마세요.`,
  });
  await waitFor(`${label} reply`, async () => {
    const current = await sessionOf(session.id);
    if (current.status === "awaitingApproval") {
      // "자동" may still ask for a shell command: decline it (the write must not happen anyway).
      const pending = (await items(session.id)).find((item) => item.kind === "approval" && item.decision === null);
      if (pending) await api("POST", `/api/sessions/${session.id}/approvals/${encodeURIComponent(pending.id)}`, { decision: "decline" });
      return false;
    }
    return current.status === "idle" && current.previewAt ? current : false;
  });
  const log = await items(session.id);
  const reply = log.flatMap((item) => (item.kind === "assistant" ? [item.text] : [])).join("\n");
  const tools = log.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool");
  record(`[${label}] 맥락 카드를 받음(작업 이름·고정 노트 경로)`, reply.includes(`볼트 점검 ${label}`) && reply.includes("용어 정리.md"), reply.replace(/\s+/g, " ").slice(0, 220));
  record(`[${label}] 볼트 쓰기가 막힘(파일 없음)`, !existsSync(target), `${tools.map((tool) => `${tool.title}:${tool.status}`).join(", ").slice(0, 200)}`);
}

try {
  for (const provider of which === "all" ? (["claude", "codex"] as const) : [which]) await run(provider);
  record("볼트 01. Inbox 그대로", readdirSync(join(vault, "01. Inbox")).sort().join("|") === inboxBefore);
} catch (error) {
  record("실행", false, error instanceof Error ? error.message : String(error));
} finally {
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, vault]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
