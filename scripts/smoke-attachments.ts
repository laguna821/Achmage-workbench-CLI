// Real-engine run (no mocks) of pictures in requests, one short turn per engine: a picture with a
// red bar on top is uploaded like a paste and sent with a question only the picture answers; the
// answer must name the colour (so the engine really saw it: Codex as a local image, Claude as an
// image block). Usage: node scripts/smoke-attachments.ts [claude|codex|all]

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Attachment, Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { pagePng } from "./fixtures/png.mjs";

const which = (process.argv[2] ?? "all") as Provider | "all";
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-attach-"));
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
const sessionOf = async (id: string) => (await api<Snapshot>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timeout: ${label}`);
}

// The picture is uploaded the way the UI uploads a paste (raw bytes, the file name in a header).
const upload = await fetch(`${host.url}/api/attachments`, {
  method: "POST",
  headers: { authorization: `Bearer ${host.token}`, "content-type": "image/png", "x-file-name": encodeURIComponent("붙여넣은 그림.png") },
  body: new Uint8Array(pagePng(360, 220, [214, 36, 36])),
});
const picture = (await upload.json()) as Attachment;
record("그림 올리기", upload.status === 201 && picture.mime === "image/png", `${picture.size}바이트`);

async function run(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const cwd = mkdtempSync(join(tmpdir(), `wb-attach-${provider}-`));
  const work = await api<Work>("POST", "/api/works", { title: `${label} 그림 확인`, cwd });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "그림", access: "auto" });
  try {
    await api("POST", `/api/sessions/${session.id}/messages`, {
      requestId: randomUUID(),
      text: "첨부한 그림 맨 위 가로 띠는 무슨 색이야? 도구는 쓰지 말고, 색 이름 한 단어로만 답해.",
      attachments: [picture],
    });
    await waitFor("idle", async () => ((await sessionOf(session.id)).status === "idle" ? true : null));
    const answer = (await items(session.id))
      .filter((item) => item.kind === "assistant")
      .map((item) => (item.kind === "assistant" ? item.text : ""))
      .join(" ")
      .trim();
    const failed = (await sessionOf(session.id)).lastError;
    record(`[${label}] 그림을 실제로 보고 답함`, /빨간|빨강|붉은|레드|red/i.test(answer), failed ? `오류: ${failed}` : answer.slice(0, 60));
  } catch (error) {
    record(`[${label}] 그림을 실제로 보고 답함`, false, error instanceof Error ? error.message : String(error));
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
