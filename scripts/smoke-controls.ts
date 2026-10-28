// Real-engine run (no mocks) of the controls added for working without babysitting, per engine:
// a session on "묻기" asks before a shell command; switching it to "전체 접근" answers the waiting
// approval and the next command runs without asking; a request steered into a running turn is
// answered; a steer followed at once by a stop is either taken or kept as undelivered, and nothing
// runs after the stop; the context figure arrives; "지금 압축" compacts; plan limits are read.
// Small prompts, a few short turns per engine. Usage: node scripts/smoke-controls.ts [claude|codex|all]

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const which = (process.argv[2] ?? "all") as Provider | "all";
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-controls-"));
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
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${json.message}`);
  return json;
}
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const sessionOf = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const send = (id: string, text: string) => api<{ delivery: string }>("POST", `/api/sessions/${id}/messages`, { requestId: randomUUID(), text });

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timeout: ${label}`);
}
const idle = (id: string) => waitFor("idle", async () => ((await sessionOf(id)).status === "idle" ? true : null));

const SLEEPS = "Run these three shell commands one at a time, each as a separate command: `sleep 4`, then `sleep 4`, then `sleep 4`. After each one, write one short line with its number. Nothing else.";

async function run(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const cwd = mkdtempSync(join(tmpdir(), `wb-controls-${provider}-`));
  const work = await api<Work>("POST", "/api/works", { title: `${label} 권한 확인`, cwd });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "권한", access: "ask" });
  const step = async (name: string, body: () => Promise<[boolean, string?]>) => {
    try {
      const [ok, detail] = await body();
      record(`[${label}] ${name}`, ok, detail ?? "");
    } catch (error) {
      record(`[${label}] ${name}`, false, error instanceof Error ? error.message : String(error));
      await api("POST", `/api/sessions/${session.id}/interrupt`).catch(() => undefined);
      await idle(session.id).catch(() => undefined);
    }
  };

  await step("묻기: 셸 명령 전에 승인을 요청", async () => {
    await send(session.id, "Using one shell command, create a file named hello.txt containing the word hi in the current folder. Do nothing else.");
    const pending = await waitFor("approval", async () => (await items(session.id)).find((item) => item.kind === "approval" && item.decision === null));
    return [Boolean(pending), pending && "title" in pending ? pending.title : ""];
  });

  await step("전체 접근으로 바꾸면 기다리던 승인이 허용되고 이어서 끝남", async () => {
    await api("PATCH", `/api/sessions/${session.id}`, { access: "full" });
    await idle(session.id);
    const approvals = (await items(session.id)).filter((item) => item.kind === "approval");
    const file = join(cwd, "hello.txt");
    return [approvals.every((item) => item.kind === "approval" && item.decision === "accept") && existsSync(file), `approvals=${approvals.length} file=${existsSync(file)}`];
  });

  await step("전체 접근: 다음 명령은 묻지 않음", async () => {
    const before = (await items(session.id)).filter((item) => item.kind === "approval").length;
    await send(session.id, "Using one shell command, append a new line with the word there to hello.txt. Do nothing else.");
    await waitFor("busy", async () => ((await sessionOf(session.id)).status !== "idle" ? true : null), 20_000).catch(() => true);
    await idle(session.id);
    const after = (await items(session.id)).filter((item) => item.kind === "approval").length;
    const text = existsSync(join(cwd, "hello.txt")) ? readFileSync(join(cwd, "hello.txt"), "utf8") : "";
    return [after === before && text.includes("there"), `approvals ${before}→${after}, file=${JSON.stringify(text)}`];
  });

  await step("컨텍스트 수치가 들어옴", async () => {
    const context = await waitFor("context", async () => (await sessionOf(session.id)).context, 20_000);
    return [context.used > 0, `${context.used} / ${context.window ?? "?"} (자동 압축 ${context.compactAt ?? "?"})`];
  });

  await step("작업 중 끼어들기: 하던 턴에 전해지고 답이 이어짐", async () => {
    await send(session.id, SLEEPS);
    await waitFor("first command", async () => (await items(session.id)).some((item) => item.kind === "tool" && item.tool === "command" && item.title.includes("sleep")), 120_000);
    const steered = await send(session.id, "Change of plan: skip the remaining commands and reply only with the word 멈춤.");
    await idle(session.id);
    const list = await items(session.id);
    const at = list.findIndex((item) => item.kind === "user" && item.steered);
    const answered = list.slice(at + 1).some((item) => item.kind === "assistant" && item.text.includes("멈춤"));
    return [steered.delivery === "steered" && at >= 0 && answered, `delivery=${steered.delivery} answered=${answered}`];
  });

  await step("끼어든 직후 멈추면: 전해졌거나 '전해지지 않음'으로 남고, 멈춘 뒤 혼자 이어 가지 않음", async () => {
    await send(session.id, SLEEPS);
    await waitFor("first command", async () => (await items(session.id)).filter((item) => item.kind === "tool" && item.tool === "command" && item.title.includes("sleep")).length >= 4, 120_000);
    const marker = `멈춤 확인 ${Date.now() % 1000}`;
    const steered = await send(session.id, `Reply only with: ${marker}`);
    await api("POST", `/api/sessions/${session.id}/interrupt`);
    await idle(session.id);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const after = await sessionOf(session.id);
    const list = await items(session.id);
    const user = list.find((item) => item.kind === "user" && item.text === `Reply only with: ${marker}`);
    const undelivered = Boolean(user && user.kind === "user" && user.undelivered);
    const kept = after.queued.some((entry) => entry.text === `Reply only with: ${marker}`);
    const ranAfter = list.some((item) => item.kind === "assistant" && item.text.includes(marker));
    const state = undelivered ? "전해지지 않음(다시 보낼 목록)" : "엔진이 받음";
    // Cleared for the next steps.
    for (const entry of after.queued) await api("DELETE", `/api/sessions/${session.id}/queue/${encodeURIComponent(entry.id)}`);
    return [steered.delivery === "steered" && after.status === "idle" && !ranAfter && (!undelivered || kept), `${state}, 멈춘 뒤 답=${ranAfter}`];
  });

  await step("지금 압축: 안내가 남고 컨텍스트가 줄어듦", async () => {
    const before = (await sessionOf(session.id)).context?.used ?? 0;
    await api("POST", `/api/sessions/${session.id}/compact`);
    await waitFor("compacting", async () => ((await sessionOf(session.id)).status !== "idle" ? true : null), 15_000).catch(() => true);
    await idle(session.id);
    const notice = await waitFor("notice", async () => (await items(session.id)).find((item) => item.kind === "notice" && item.text.includes("압축")), 30_000);
    const after = (await sessionOf(session.id)).context?.used ?? 0;
    return [Boolean(notice) && after < before, `${before} → ${after} · ${notice && notice.kind === "notice" ? notice.text : ""}`];
  });

  await step("사용 한도(5시간·주간)를 읽음", async () => {
    await api("POST", "/api/providers/refresh");
    const status = await waitFor("usage", async () => {
      const found = (await snapshot()).providers.find((entry) => entry.provider === provider);
      return found?.usage.length ? found : null;
    }, 30_000);
    return [true, status.usage.map((window) => `${window.label} ${window.usedPercent}%`).join(", ")];
  });
}

try {
  for (const provider of which === "all" ? (["claude", "codex"] as Provider[]) : [which]) await run(provider);
} finally {
  child.kill("SIGTERM");
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
