// Real-engine run (no mocks) of "계획 먼저", per engine, in a temp folder: a small task sent to plan
// first comes back as a plan waiting for the go-ahead and changes nothing; going ahead then does
// the task with the session's access ("자동"). Claude plans in its plan mode (ExitPlanMode asks);
// Codex plans in a read-only turn and the gateway asks.
// Usage: node scripts/smoke-plan.ts [claude|codex|all] [auto|full]  (the session's access; default auto)

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const which = (process.argv[2] ?? "all") as Provider | "all";
const access = process.argv[3] === "full" ? "full" : "auto";
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-plan-"));
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

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`timeout: ${label}`);
}

const TASK = "이 폴더에 hello.txt를 만들고 안에 hi 한 줄만 써 줘. 아주 작은 일이니 계획은 한두 줄이면 돼.";

async function run(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const cwd = mkdtempSync(join(tmpdir(), `wb-plan-${provider}-`));
  const work = await api<Work>("POST", "/api/works", { title: `${label} 계획 먼저`, cwd });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "계획", access });
  const file = join(cwd, "hello.txt");
  try {
    await api("POST", `/api/sessions/${session.id}/messages`, { requestId: randomUUID(), text: TASK, plan: true });
    const card = await waitFor("plan card", async () => {
      const waiting = (await items(session.id)).find((item) => item.kind === "approval" && item.plan && item.decision === null);
      const status = (await sessionOf(session.id)).status;
      return waiting && (status === "idle" || status === "awaitingApproval") ? waiting : null;
    });
    const how = card.id.startsWith("plan:") ? "턴이 끝난 뒤 게이트웨이가 물음" : "엔진이 계획 모드 끝에 물음(ExitPlanMode)";
    record(`[${label}] 계획만 세우고 아무것도 바꾸지 않은 채 진행 여부를 물음`, !existsSync(file), how);

    await api("POST", `/api/sessions/${session.id}/approvals/${encodeURIComponent(card.id)}`, { decision: "accept" });
    await waitFor("file", async () => existsSync(file) && (await sessionOf(session.id)).status === "idle");
    const text = readFileSync(file, "utf8").trim();
    const lastError = (await sessionOf(session.id)).lastError;
    record(`[${label}] '계획대로 진행' 뒤에 일을 함(세션 권한 ${access === "full" ? "'전체 접근'" : "'자동'"})`, text === "hi", lastError ? `오류: ${lastError}` : `hello.txt: ${JSON.stringify(text)}`);
  } catch (error) {
    record(`[${label}] 계획 먼저`, false, error instanceof Error ? error.message : String(error));
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
