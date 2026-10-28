// Real-engine run (no mocks) of agentic browsing, one short turn per engine: a session with
// "브라우저" on and access "자동" is asked to open example.com and report the title. The engine
// must use playwright-cli from its PATH (Codex inside its workspace-write sandbox), the gateway
// asks before the new site (the card is allowed here), and the answer names the page title.
// Needs an installed agent browser: pass a data folder that has one (`--from <dataDir>`, e.g. one
// kept by `scripts/browse-smoke.ts --keep`); its CLI and Chromium are linked, not downloaded
// again. Headless (no window on the screen). Usage: node scripts/smoke-browse.ts --from <dir> [claude|codex|all]

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AgentBrowserStatus, Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const fromIndex = process.argv.indexOf("--from");
const from = fromIndex > 0 ? resolve(process.argv[fromIndex + 1]!) : null;
const which = (process.argv.slice(2).find((arg) => arg === "claude" || arg === "codex" || arg === "all") ?? "all") as Provider | "all";
if (!from || !existsSync(join(from, "agent-browser", "install.json"))) {
  console.error("an installed agent browser is needed: --from <dataDir with agent-browser/install.json>");
  process.exit(2);
}
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-browse-"));
mkdirSync(join(dataDir, "agent-browser"), { recursive: true });
cpSync(join(from, "agent-browser", "install.json"), join(dataDir, "agent-browser", "install.json"));
symlinkSync(join(from, "agent-browser", "cli"), join(dataDir, "agent-browser", "cli"));
symlinkSync(join(from, "agent-browser", "browsers"), join(dataDir, "agent-browser", "browsers"));

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const child: ChildProcess = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_BROWSER_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
const host = await new Promise<{ url: string; token: string }>((done, fail) => {
  const timer = setTimeout(() => fail(new Error("host did not start")), 20_000);
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) {
      clearTimeout(timer);
      done(JSON.parse(line.slice(16)));
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

const PROMPT = "브라우저로 https://example.com 을 열고, 페이지 제목만 한 줄로 알려 줘.";

async function run(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const cwd = mkdtempSync(join(tmpdir(), `wb-browse-${provider}-`));
  const work = await api<Work>("POST", "/api/works", { title: `${label} 브라우징`, cwd });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "브라우징", access: "auto", browser: true });
  const started = Date.now();
  const cards: string[] = [];
  try {
    await api("POST", `/api/sessions/${session.id}/messages`, { requestId: randomUUID(), text: PROMPT });
    // Allow what the gateway or the engine asks (the browser's new-site card under "자동").
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const current = await sessionOf(session.id);
      for (const item of await items(session.id)) {
        if (item.kind === "approval" && item.decision === null) {
          cards.push(`${item.title} ${item.detail?.split("\n")[0] ?? ""}`);
          await api("POST", `/api/sessions/${session.id}/approvals/${encodeURIComponent(item.id)}`, { decision: "accept" }).catch(() => undefined);
        }
      }
      if (current.status === "idle" && Date.now() - started > 3000) break;
      await new Promise((done) => setTimeout(done, 700));
    }
    const all = await items(session.id);
    const answer = all.filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("\n");
    const commands = all.filter((item) => item.kind === "tool" && item.title.includes("playwright-cli")).map((item) => (item.kind === "tool" ? `${item.title} [${item.status}]` : ""));
    const window = (await api<AgentBrowserStatus>("GET", "/api/agent-browser")).window;
    record(
      `[${label}] 실제 엔진이 playwright-cli로 example.com을 열고 제목을 말함`,
      /Example Domain/.test(answer) && commands.length > 0,
      `${Math.round((Date.now() - started) / 1000)}초 · 명령 ${commands.length}개: ${commands.slice(0, 3).join(" | ").slice(0, 200)} · 카드: ${cards.join(" | ").slice(0, 120) || "없음"} · 창: ${window.kind === "agent" ? window.title : window.kind} · 답: ${answer.trim().split("\n").slice(-2).join(" ").slice(0, 120)}`,
    );
  } catch (error) {
    record(`[${label}] 실행`, false, error instanceof Error ? error.message : String(error));
    await api("POST", `/api/sessions/${session.id}/interrupt`).catch(() => undefined);
  }
}

try {
  for (const provider of (which === "all" ? ["claude", "codex"] : [which]) as Provider[]) await run(provider);
} finally {
  child.kill("SIGTERM");
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · data ${dataDir}`);
  process.exitCode = failed ? 1 : 0;
}
