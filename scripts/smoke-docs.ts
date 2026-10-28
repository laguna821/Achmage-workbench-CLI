// Real-engine acceptance for PRD stage B (no mocks), the representative scenario:
// a HWPX draft → the user edits a paragraph → Codex reviews the current revision (handoff) →
// Codex proposes an edit → the user edits again → the old-revision proposal is NOT applied →
// a proposal on the latest revision applies. Plus Markdown: a file Claude writes is tracked,
// and a selection-scoped edit request comes back as a proposal that applies.
// Usage: HOST_ENTRY=apps/host/dist/host.mjs node scripts/smoke-docs.ts

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Artifact, DocRef, Handoff, Proposal, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const dataDir = mkdtempSync(join(tmpdir(), "workbench-docs-"));
const project = join(dataDir, "project");
mkdirSync(project, { recursive: true });
const results: { name: string; ok: boolean; detail: string }[] = [];
let host: { child: ChildProcess; url: string; token: string } | null = null;

function startHost(): Promise<NonNullable<typeof host>> {
  const child = spawn(process.execPath, [process.env.HOST_ENTRY ?? "apps/host/src/main.ts"], {
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_CODEX_IDLE_MS: "600000", WORKBENCH_CLAUDE_IDLE_MS: "600000" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host did not start")), 20_000);
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.startsWith("WORKBENCH_READY ")) return;
      clearTimeout(timer);
      const ready = JSON.parse(line.slice("WORKBENCH_READY ".length)) as { url: string; token: string };
      resolve({ child, url: ready.url, token: ready.token });
    });
  });
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${host!.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host!.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { code?: string; message?: string };
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${json.message}`), { code: json.code, status: response.status });
  return json;
}

const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const items = async (sessionId: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items;

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 300_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error(`timeout: ${label}`);
}

/** Wait for the turn of a request to end, approving whatever the engine asks along the way. */
async function finishTurn(sessionId: string, requestId: string) {
  return waitFor(`turn ${requestId}`, async () => {
    const list = await items(sessionId);
    const start = list.findIndex((item) => item.id === `user:${requestId}`);
    if (start === -1) return null;
    for (const item of list.slice(start)) {
      if (item.kind === "approval" && item.decision === null) {
        await api("POST", `/api/sessions/${sessionId}/approvals/${encodeURIComponent(item.id)}`, { decision: "accept" }).catch(() => undefined);
      }
    }
    return list.slice(start).find((item) => item.kind === "turnEnd") as (TranscriptItem & { kind: "turnEnd" }) | undefined;
  });
}

async function send(sessionId: string, text: string, refs: DocRef[] = []) {
  const requestId = randomUUID();
  await api("POST", `/api/sessions/${sessionId}/messages`, { requestId, text, refs });
  return requestId;
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

const artifactNamed = async (name: string) => (await snapshot()).artifacts.find((artifact) => artifact.name === name);
const proposalFor = async (requestId: string) =>
  waitFor(`proposal ${requestId}`, async () => (await snapshot()).proposals.find((proposal) => proposal.requestId === requestId && proposal.status !== "running"));
const textOf = async (artifactId: string) => (await api<{ text: string; revision: number }>("GET", `/api/artifacts/${artifactId}/text`));

function makeHwpx(path: string) {
  // A HWPX draft made by the same kordoc engine the app uses (stands in for "Claude drafts the lecture").
  const runner = join(homedir(), ".claude/skills/hallym-kordoc/core/scripts/run.mjs");
  const request = join(dataDir, "generate.json");
  writeFileSync(
    request,
    JSON.stringify({
      schemaVersion: 1,
      mode: "generate",
      markdown: "# 질문에서 시작하는 지식 생산\n\n우리는 자료를 읽고 질문을 만듭니다.\n\n자료의 결론보다 결론이 성립하는 조건을 살펴봅니다.\n\n좋은 질문은 탐구의 방향을 정합니다.",
      outputDir: join(dataDir, "generated"),
    }),
  );
  const result = JSON.parse(execFileSync(process.execPath, [runner, request], { encoding: "utf8" })) as { files: { path: string }[] };
  writeFileSync(path, readFileSync(result.files.find((file) => file.path.endsWith(".hwpx"))!.path));
}

async function main() {
  host = await startHost();
  await waitFor("providers", async () => {
    const current = await snapshot();
    return current.providers.length === 2 && current.providers.every((status) => status.loggedIn !== null || status.error);
  }, 60_000);
  const work = await api<Work>("POST", "/api/works", { title: "7주차 강의 자료", cwd: project });
  const claude = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "문서 편집" });
  const codex = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "자료 검토" });

  // --- Markdown: a file Claude writes becomes a tracked document; a selection edit comes back as a proposal.
  let markdown: Artifact | undefined;
  await step("markdown: engine file is tracked", async () => {
    const id = await send(claude.id, "현재 폴더에 강의.md 파일을 만들어 주세요. 내용은 제목 한 줄과 세 문단입니다. 둘째 문단은 '자료의 결론보다 조건을 살펴봅니다.' 로 써 주세요. 다른 파일은 만들지 마세요.");
    const end = await finishTurn(claude.id, id);
    markdown = await waitFor("강의.md artifact", () => artifactNamed("강의.md"), 20_000);
    const card = (await items(claude.id)).find((item) => item.kind === "artifact" && item.artifactId === markdown!.id);
    if (!card) throw new Error("no document card in the conversation");
    return `turn ${end.status}, r${markdown.revision}, 대화에 문서 카드`;
  });

  await step("markdown: selection edit → proposal → apply", async () => {
    if (!markdown) throw new Error("no markdown document");
    const current = await textOf(markdown.id);
    const line = current.text.split("\n").find((entry) => entry.includes("조건")) ?? current.text.split("\n")[2];
    const from = current.text.indexOf(line);
    const id = await send(claude.id, "선택한 문단을 더 구체적인 한 문장으로 고쳐 주세요.", [
      { artifactId: markdown.id, revision: current.revision, mode: "edit", selection: { from, to: from + line.length, text: line, label: "선택한 문단" } },
    ]);
    await finishTurn(claude.id, id);
    const proposal = await proposalFor(id);
    if (proposal.status !== "pending") throw new Error(`proposal ${proposal.status}`);
    const disk = readFileSync(markdown.path, "utf8");
    if (disk !== current.text) throw new Error("the real file changed before applying");
    const applied = await api<{ artifact: Artifact }>("POST", `/api/proposals/${proposal.id}/apply`);
    return `r${proposal.baseRevision} 기준 +${proposal.added} −${proposal.removed} → 적용 r${applied.artifact.revision}`;
  });

  // --- HWPX: the PRD representative scenario.
  const hwpxPath = join(project, "강의자료.hwpx");
  makeHwpx(hwpxPath);
  const hwpx = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: hwpxPath });

  await step("hwpx: user edits a paragraph directly", async () => {
    const view = await textOf(hwpx.id);
    const edited = view.text.replace("우리는 자료를 읽고 질문을 만듭니다.", "우리는 자료를 함께 읽고 질문을 만듭니다.");
    const saved = await api<Artifact>("PUT", `/api/artifacts/${hwpx.id}/text`, { expectedRevision: view.revision, text: edited });
    const after = await textOf(hwpx.id);
    if (!after.text.includes("자료를 함께 읽고")) throw new Error("edit not in the HWPX");
    return `r${view.revision} → r${saved.revision} (HWPX 패치)`;
  });

  await step("hwpx: Codex reviews the current revision (handoff)", async () => {
    const current = await textOf(hwpx.id);
    const requestId = randomUUID();
    await api<Handoff>("POST", "/api/handoffs", {
      requestId,
      sourceSessionId: claude.id,
      targetSessionId: codex.id,
      text: "이 문서를 읽고 첫 문단이 어떤 문장인지 그대로 인용한 뒤, 고칠 점 한 가지만 짧게 말해 주세요. 파일은 고치지 마세요.",
      refs: [{ artifactId: hwpx.id, revision: current.revision, mode: "review" }],
    });
    await finishTurn(codex.id, requestId);
    const handoff = await waitFor("handoff answer", async () => (await snapshot()).handoffs.find((entry) => entry.id === requestId && entry.status !== "sent"), 30_000);
    if (handoff.status !== "answered" || !handoff.reply) throw new Error(`handoff ${handoff.status}: ${handoff.error}`);
    const read = (await snapshot()).artifacts.find((artifact) => artifact.id === hwpx.id)!.readBy[codex.id];
    if (read !== current.revision) throw new Error(`Codex read r${read}, current r${current.revision}`);
    const quoted = handoff.reply.includes("함께 읽고");
    return `답 도착, Codex가 읽은 판 r${read}${quoted ? ", 사용자 수정 문장 인용" : ""}`;
  });

  let stale: Proposal | undefined;
  await step("hwpx: Codex proposes on the current revision", async () => {
    const current = await textOf(hwpx.id);
    const id = await send(codex.id, "마지막 문단 '좋은 질문은 탐구의 방향을 정합니다.' 의 표현만 조금 다듬어 주세요. 문단을 추가하거나 지우지 마세요.", [
      { artifactId: hwpx.id, revision: current.revision, mode: "edit", selection: null },
    ]);
    await finishTurn(codex.id, id);
    stale = await proposalFor(id);
    if (stale.status !== "pending") throw new Error(`proposal ${stale.status}`);
    return `r${stale.baseRevision} 기준 수정안 +${stale.added} −${stale.removed}`;
  });

  await step("hwpx: user edits again; the old-revision proposal is not applied", async () => {
    if (!stale) throw new Error("no proposal");
    const view = await textOf(hwpx.id);
    const edited = view.text.replace("결론이 성립하는 조건을", "결론이 성립하는 조건과 반례를");
    await api<Artifact>("PUT", `/api/artifacts/${hwpx.id}/text`, { expectedRevision: view.revision, text: edited });
    const before = readFileSync(hwpxPath);
    let refused = false;
    try {
      await api("POST", `/api/proposals/${stale.id}/apply`);
    } catch (error) {
      refused = (error as { code?: string }).code === "stale_proposal";
    }
    if (!refused) throw new Error("stale proposal was applied");
    if (!readFileSync(hwpxPath).equals(before)) throw new Error("file changed by a refused apply");
    return `r${stale.baseRevision} 기준 수정안 적용 거절, 파일 그대로`;
  });

  await step("hwpx: review continues on the latest revision", async () => {
    const current = await textOf(hwpx.id);
    const id = await send(codex.id, "최신 판 기준으로 마지막 문단 표현만 다시 다듬어 주세요. 문단을 추가하거나 지우지 마세요.", [
      { artifactId: hwpx.id, revision: current.revision, mode: "edit", selection: null },
    ]);
    await finishTurn(codex.id, id);
    const proposal = await proposalFor(id);
    if (proposal.status !== "pending") throw new Error(`proposal ${proposal.status}`);
    const applied = await api<{ artifact: Artifact }>("POST", `/api/proposals/${proposal.id}/apply`);
    const after = await textOf(hwpx.id);
    if (!after.text.includes("조건과 반례를") || !after.text.includes("함께 읽고")) throw new Error("user edits were lost");
    return `r${proposal.baseRevision} 기준 적용 → r${applied.artifact.revision}, 사용자 수정 두 곳 유지`;
  });

  host.child.kill("SIGTERM");
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed · data: ${dataDir}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  host?.child.kill("SIGTERM");
  process.exit(1);
});

