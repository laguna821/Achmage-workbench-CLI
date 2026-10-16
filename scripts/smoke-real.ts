// Real-engine acceptance run for PRD stage A (no mocks):
// per provider: reply, approve, decline, interrupt, then restart the host and resume.
// Usage: node scripts/smoke-real.ts [claude|codex|all]

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const which = (process.argv[2] ?? "all") as Provider | "all";
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-"));
let host: { child: ChildProcess; url: string; token: string } | null = null;
const results: { name: string; ok: boolean; detail: string }[] = [];

function startHost(): Promise<NonNullable<typeof host>> {
  const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir,
      // Ask before every non-trivial Codex command so approvals can be exercised.
      WORKBENCH_CODEX_APPROVAL: "untrusted",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host did not start")), 20_000);
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (line.startsWith("WORKBENCH_READY ")) {
        clearTimeout(timer);
        const ready = JSON.parse(line.slice("WORKBENCH_READY ".length)) as { url: string; token: string };
        resolve({ child, url: ready.url, token: ready.token });
      }
    });
  });
}

async function stopHost() {
  if (!host) return;
  const child = host.child;
  host = null;
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${host!.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host!.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${json.message}`);
  return json;
}

const items = async (sessionId: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items;

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`timeout: ${label}`);
}

async function send(sessionId: string, text: string) {
  const requestId = randomUUID();
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId, text });
  return requestId;
}

async function turnEnd(sessionId: string, requestId: string, timeoutMs?: number) {
  return waitFor(`turn end ${requestId}`, async () => {
    const list = await items(sessionId);
    const start = list.findIndex((item) => item.id === `user:${requestId}`);
    return list.slice(start).find((item) => item.kind === "turnEnd") as (TranscriptItem & { kind: "turnEnd" }) | undefined;
  }, timeoutMs);
}

function textAfter(list: TranscriptItem[], requestId: string) {
  const start = list.findIndex((item) => item.id === `user:${requestId}`);
  return list
    .slice(start)
    .filter((item): item is TranscriptItem & { kind: "assistant" } => item.kind === "assistant")
    .map((item) => item.text)
    .join("\n");
}

async function pendingApproval(sessionId: string, requestId: string) {
  return waitFor("approval request", async () => {
    const list = await items(sessionId);
    const start = list.findIndex((item) => item.id === `user:${requestId}`);
    return list.slice(start).find((item) => item.kind === "approval" && item.decision === null);
  });
}

async function step(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name} — ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`FAIL ${name} — ${detail}`);
  }
}

async function runProvider(provider: Provider) {
  const work = await api<Work>("POST", "/api/works", { title: `smoke ${provider}` });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "검증" });
  const sid = session.id;
  const fileName = `approval-${provider}.txt`;
  const declinedName = `declined-${provider}.txt`;

  await step(`${provider}: reply`, async () => {
    const id = await send(sid, "Reply with exactly the single word: pong");
    const end = await turnEnd(sid, id);
    const text = textAfter(await items(sid), id);
    if (end.status !== "completed" || !/pong/i.test(text)) throw new Error(`status=${end.status} text=${text.slice(0, 120)}`);
    return `"${text.trim().slice(0, 40)}"`;
  });

  await step(`${provider}: approve`, async () => {
    const id = await send(sid, `Use a shell command to run exactly: touch ${fileName}  — then reply "done".`);
    const approval = await pendingApproval(sid, id);
    await api("POST", `/api/sessions/${sid}/approvals/${encodeURIComponent(approval.id)}`, { decision: "accept" });
    const end = await turnEnd(sid, id);
    const created = existsSync(join(work.cwd, fileName));
    if (!created) throw new Error(`file not created (turn ${end.status})`);
    return `${approval.kind === "approval" ? approval.title : ""} → 파일 생성됨`;
  });

  await step(`${provider}: decline`, async () => {
    const id = await send(sid, `Use a shell command to run exactly: touch ${declinedName}  — if it is not allowed, just say "skipped".`);
    const approval = await pendingApproval(sid, id);
    await api("POST", `/api/sessions/${sid}/approvals/${encodeURIComponent(approval.id)}`, { decision: "decline" });
    const end = await turnEnd(sid, id);
    if (existsSync(join(work.cwd, declinedName))) throw new Error("declined command still ran");
    return `거절 후 파일 없음 (turn ${end.status})`;
  });

  await step(`${provider}: interrupt`, async () => {
    const id = await send(sid, "Write a very long essay (at least 3000 words) about the history of rivers. Do not use any tools.");
    await waitFor("streaming text", async () => textAfter(await items(sid), id).length > 40);
    await api("POST", `/api/sessions/${sid}/interrupt`);
    const end = await turnEnd(sid, id, 60_000);
    if (end.status !== "interrupted") throw new Error(`status=${end.status}`);
    return "중단됨으로 종료";
  });

  return { workId: work.id, sessionId: sid };
}

async function resumeProvider(provider: Provider, sessionId: string) {
  await step(`${provider}: resume after restart`, async () => {
    const snapshot = await api<Snapshot>("GET", "/api/snapshot");
    const session = snapshot.sessions.find((entry) => entry.id === sessionId)!;
    if (session.status !== "idle" || !session.nativeSessionId) throw new Error(`status=${session.status} native=${session.nativeSessionId}`);
    const id = await send(sessionId, "Earlier in this conversation I asked you to reply with a single word. What was that word? Reply with that one word only.");
    const end = await turnEnd(sessionId, id);
    const text = textAfter(await items(sessionId), id);
    if (end.status !== "completed" || !/pong/i.test(text)) throw new Error(`status=${end.status} text=${text.slice(0, 120)}`);
    return `재시작 뒤 같은 세션 기억: "${text.trim().slice(0, 30)}"`;
  });
}

async function main() {
  const providers: Provider[] = which === "all" ? ["claude", "codex"] : [which];
  host = await startHost();
  await waitFor("provider status", async () => {
    const snapshot = await api<Snapshot>("GET", "/api/snapshot");
    return snapshot.providers.length === 2 && snapshot.providers.every((status) => status.loggedIn !== null || status.error);
  }, 60_000);
  const snapshot = await api<Snapshot>("GET", "/api/snapshot");
  for (const status of snapshot.providers) {
    console.log(`provider ${status.provider}: ${status.binary} ${status.version} loggedIn=${status.loggedIn} account=${status.account} plan=${status.plan} usage=${JSON.stringify(status.usage)}`);
  }
  const created: { provider: Provider; sessionId: string }[] = [];
  for (const provider of providers) {
    const { sessionId } = await runProvider(provider);
    created.push({ provider, sessionId });
  }
  await stopHost();
  host = await startHost();
  for (const { provider, sessionId } of created) {
    await resumeProvider(provider, sessionId);
  }
  await stopHost();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed · data: ${dataDir}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await stopHost();
  process.exit(1);
});
