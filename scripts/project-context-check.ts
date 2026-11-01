// Real provider acceptance over the document saved by ieum-roundtrip-check.ts.
// Never print or copy account credentials; caller supplies their normal local config paths.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Artifact, Provider, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { client, startGateway, type Gateway } from "./setup-smoke.ts";

const app = resolve(process.argv[2]!), source = resolve(process.argv[3]!), output = resolve(process.argv[4]!);
if (process.env.WORKBENCH_REAL_PROVIDER_ACCEPTANCE !== "1") throw new Error("Requires explicitly enabled real-provider acceptance in an isolated document workspace");
mkdirSync(output, { recursive: true });
const saved = JSON.parse(readFileSync(source, "utf8")) as { work: Work; main: Session; other: Session; current: Artifact; marker: string };
const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const checks: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail?: string) => { checks.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let gateway: Gateway | null = null;
try {
  gateway = await startGateway(app, { WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_SHELL_PATH: "0", DISABLE_AUTOUPDATER: "1" }, dataDir);
  writeFileSync(join(output, "local-connection.json"), JSON.stringify({ url: gateway.url, token: gateway.token }), { mode: 0o600 });
  const { call } = client(gateway), snapshot = () => call<Snapshot>("GET", "/api/snapshot");
  const authDeadline = Date.now() + 45_000;
  let providers = (await snapshot()).providers;
  while (Date.now() < authDeadline && !["codex", "claude"].every(name => providers.find(provider => provider.provider === name)?.loggedIn)) { await delay(1000); providers = (await snapshot()).providers; }
  for (const name of ["codex", "claude"] as Provider[]) {
    const provider = providers.find(entry => entry.provider === name);
    check(`${name} 실제 CLI와 기존 계정 로그인 확인`, provider?.installed === true && provider.loggedIn === true && !/fake/.test(provider.version ?? ""), `${provider?.version ?? "unknown"}${provider?.error ? ` · ${provider.error}` : ""}`);
  }
  if (checks.some(row => !row.ok)) throw new Error("Real provider authentication is unavailable");
  const sessions = [saved.main, saved.other];
  const items = async (id: string) => (await call<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const originalIds = new Map(await Promise.all(sessions.map(async session => [session.id, new Set((await items(session.id)).map(item => item.id))] as const)));
  const requests = sessions.map(session => ({ sessionId: session.id, requestId: randomUUID(), text: '수정했어 봐봐. 이 프로젝트에서 외부 이음오피스로 저장한 "외부 앱 왕복 문서.docx"의 현재 본문을 실제 파일에서 읽고 본문 한 줄만 답해. 기존 대화나 알림으로 추측하지 마. 필요하면 ieumoffice docs read 명령을 사용해. 파일 수정, 웹 검색, 추가 조사나 작업 계획은 필요 없어.', refs: [], create: null, mode: "auto", plan: true }));
  // Same project, independent live provider processes; no content/marker is supplied in prompts.
  await Promise.all(requests.map(({ sessionId, ...body }) => call("POST", `/api/sessions/${sessionId}/messages`, body)));
  const announced = new Set<string>(), deadline = Date.now() + 240_000;
  let parallel = false;
  while (Date.now() < deadline) {
    const state = await snapshot();
    parallel ||= sessions.every(session => ["starting", "running", "awaitingApproval"].includes(state.sessions.find(entry => entry.id === session.id)?.status ?? ""));
    let done = 0;
    for (const session of sessions) {
      const current = (await items(session.id)).filter(item => !originalIds.get(session.id)!.has(item.id));
      writeFileSync(join(output, `${session.provider}-items.json`), JSON.stringify(current, null, 2));
      for (const item of current) if (item.kind === "approval" && !item.decision && !announced.has(item.id)) { announced.add(item.id); console.log(`APPROVAL ${JSON.stringify({ sessionId: session.id, provider: session.provider, item })}`); }
      if (current.some(item => item.kind === "turnEnd")) done += 1;
    }
    if (done === sessions.length) break;
    await delay(1000);
  }
  check("같은 프로젝트에서 Codex와 Claude 실제 요청 병렬 실행", parallel);
  for (const session of sessions) {
    const current = (await items(session.id)).filter(item => !originalIds.get(session.id)!.has(item.id));
    const answer = current.filter(item => item.kind === "assistant").map(item => item.text).join("\n");
    const completed = current.some(item => item.kind === "turnEnd" && item.status === "completed");
    check(`${session.provider}가 외부 저장된 최신 문장과 임의 확인값을 실제로 읽음`, completed && answer.includes(saved.marker), answer.slice(-600));
    writeFileSync(join(output, `${session.provider}-items.json`), JSON.stringify(current, null, 2));
  }
  const final = (await snapshot()).artifacts.find(row => row.id === saved.current.id);
  check("두 채팅의 읽기 후 문서 경로·판 유지", final?.path === saved.current.path && final.revision === saved.current.revision);
} catch (error) { check("실제 계정 프로젝트 맥락 검증 완료", false, String(error)); console.error(error); }
finally { await gateway?.stop(); writeFileSync(join(output, "project-context-results.json"), JSON.stringify(checks, null, 2)); process.exitCode = checks.every(row => row.ok) ? 0 : 1; }
