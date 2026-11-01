// One installed native app, two original document AI panels and a separate real main CLI.
// Opt-in only: uses the caller's existing subscription in a disposable document workspace.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

if (process.env.WORKBENCH_REAL_PROVIDER_ACCEPTANCE !== "1") throw new Error("Real provider acceptance must be explicitly enabled");
const binary = resolve(process.argv[2]!), output = resolve(process.argv[3]!);
mkdirSync(output, { recursive: true });
const report = new Report(output), stage = await openStage(output, { nativeX11: true });
let ctx: Ctx | null = null, monitor: Promise<void> | undefined, monitoring = true;
const states: { at: number; sessions: { id: string; status: string }[] }[] = [];
const S = "실제 문서 AI 병렬";
try {
  ctx = { stage, app: await stage.launch({ binary, engines: "real", name: "document-agents-real", window: { width: 1800, height: 1100 } }), report };
  const { api, wd } = ctx.app, snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  await wd.click(await wd.waitFor(".onboarding-actions button", 30_000));
  if (!await until(async () => !(await wd.find(".onboarding-backdrop")) && (await snapshot()).prefs.onboarding === "done", 10_000)) throw new Error("Initial onboarding did not finish");
  if (!await until(async () => { const s = await snapshot(); return ["codex", "claude"].every(name => s.providers.find(row => row.provider === name)?.loggedIn); }, 45_000)) throw new Error("Real provider login unavailable");
  const providers = (await snapshot()).providers;
  if (providers.some(row => /fake/.test(row.version ?? ""))) throw new Error("A stand-in provider was found");
  const work = await api<Work>("POST", "/api/works", { title: "실제 병렬 문서 인수", cwd: null });
  const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "독립 메인 채팅" });
  const docs: Artifact[] = [];
  for (const name of ["독립 문서 A", "독립 문서 B"]) docs.push(await api<Artifact>("POST", `/api/works/${work.id}/office-documents`, { format: "docx", name, sessionId: main.id }));
  const config = await api<{ settings: any; revision: string }>("GET", "/api/office-ai/settings");
  config.settings.provider = "codex";
  config.settings.subscriptionNoticeSeen = true;
  config.settings.providers.codex.cliPath = providers.find(row => row.provider === "codex")!.binary;
  await api("PUT", "/api/office-ai/settings", { settings: config.settings, expectedRevision: config.revision });
  const tab = (id: string, artifact?: Artifact) => ({ id, workId: work.id, sessionId: main.id, view: artifact ? { kind: "document", artifactId: artifact.id, proposalId: null } : { kind: "work" } });
  const tabs = [tab("parallel-main"), tab("parallel-a", docs[0]), tab("parallel-b", docs[1])];
  await seedLayout(ctx, { ...(await snapshot()).prefs, onboarding: "done", sidebar: true, paneLayout: { version: 2, focus: "parallel-pane", panes: [{ ...tabs[1]!, id: "parallel-pane", tabs, activeTabId: "parallel-a", recentTabIds: ["parallel-a"] }] } });
  await wd.refresh(); await installProbe(wd);
  const activate = async (id: string, editor = true) => {
    await wd.frame(null);
    await wd.click(await wd.waitFor(`.pane[data-pane-active="true"] .group-tab[data-tab-id="${id}"] [role="tab"]`, 30_000));
    await wd.waitFor(`.pane[data-pane-active="true"][data-tab="${id}"]`, 30_000);
    if (editor) { await wd.frame(await wd.waitFor(`.pane[data-pane-active="true"][data-tab="${id}"] iframe.office-frame`, 30_000)); await installProbe(wd); await wd.waitFor('.tiptap[contenteditable="true"]', 60_000); await wd.waitFor(".ai-panel textarea", 30_000); }
  };
  await activate("parallel-a"); await activate("parallel-b");
  const children = docs.map(doc => (snapshot().then(s => s.sessions.find(row => row.documentAgent?.artifactId === doc.id))));
  const agents = await Promise.all(children);
  if (agents.some(agent => !agent)) throw new Error("Document sessions were not created");
  const [a, b] = agents as [Session, Session];
  report.check(S, "두 문서와 메인 채팅은 서로 다른 세션", new Set([main.id, a.id, b.id]).size === 3 && agents.every(agent => agent?.documentAgent?.parentSessionId === main.id));
  const subscription = await api<Record<string, { state: string }>>("GET", "/api/office-ai/statuses?refresh=1");
  writeFileSync(report.path("provider-status.json"), JSON.stringify({ versions: providers.map(row => ({ provider: row.provider, version: row.version })), subscription: Object.fromEntries(Object.entries(subscription).map(([id, status]) => [id, { state: status.state }])) }, null, 2));
  if (subscription.codex?.state !== "ready") throw new Error(`Document Codex status: ${subscription.codex?.state}`);
  const ids = [main.id, a.id, b.id], marker = `PARALLEL_A_${randomUUID()}`;
  monitor = (async () => {
    while (monitoring) { const s = await snapshot(); states.push({ at: Date.now(), sessions: ids.map(id => ({ id, status: s.sessions.find(row => row.id === id)?.status ?? "missing" })) }); await new Promise(resolve => setTimeout(resolve, 100)); }
  })();
  const compose = async (id: string, instruction: string) => {
    await activate(id); const input = await wd.waitFor(".ai-panel textarea"); await wd.click(input);
    await wd.execute('window.__inputFocus=[];document.addEventListener("focusin",e=>window.__inputFocus.push({at:Date.now(),tag:e.target.tagName,className:e.target.className}));');
    await wd.sendKeys(input, instruction);
    const state = await wd.execute<{ value: string; focused: boolean }>('return {value:arguments[0].value,focused:document.activeElement===arguments[0],events:window.__inputFocus};', input);
    writeFileSync(report.path(`${id}-input.json`), JSON.stringify(state, null, 2));
    if (state.value !== instruction || !state.focused) throw new Error(`Composer did not retain full input in ${id}`);
  };
  await compose("parallel-a", `문서 첫머리에 ${marker}를 한 문단으로 삽입하고, 아래에 문서 정리 방법을 설명하는 짧은 한국어 문단 12개를 삽입해. 실제 편집 도구로 실행하고 완료 후 한 문장으로 알려줘.`);
  await compose("parallel-b", "문서 정리 방법을 한국어 문단 60개로 자세히 작성하여 문서에 삽입해. 실제 편집 도구를 사용해.");
  await api("POST", `/api/sessions/${main.id}/messages`, { requestId: randomUUID(), text: "이 프로젝트에서 현재 열린 두 문서와 문서 AI의 작업 현황을 확인하고, 별도 문서 AI와 메인 채팅이 어떤 역할을 하는지 5문장으로 설명해. 파일 수정이나 새 계획은 필요 없어.", refs: [], create: null, mode: "auto", plan: true });
  for (const id of ["parallel-a", "parallel-b"]) { await activate(id); await wd.click(await wd.waitFor(".ai-panel .ai-send-btn:not(.ai-stop-btn)")); }
  const triple = await until(async () => states.some(row => row.sessions.every(session => ["starting", "running", "awaitingApproval"].includes(session.status))), 15_000);
  report.check(S, "실제 두 문서 AI와 메인 CLI 요청이 동시에 진행", triple, undefined, await shot(ctx, "parallel-before-stop.png"));
  await wd.click(await wd.waitFor(".ai-panel .ai-stop-btn", 20_000));
  report.check(S, "B 편집기의 중지 버튼은 B만 중단", await until(async () => (await items(b.id)).some(item => item.kind === "turnEnd" && item.status === "interrupted"), 20_000));
  await activate("parallel-main", false);
  report.check(S, "메인 탭으로 복귀하면 사이드바와 메인 입력 복원", await until(() => wd.execute<boolean>('return !!document.querySelector(".sidebar") && !!document.querySelector(".pane[data-pane-active=true] .composer-area");')), undefined, await shot(ctx, "parallel-main.png"));
  await until(async () => (await items(a.id)).some(item => item.kind === "turnEnd") && (await items(main.id)).some(item => item.kind === "turnEnd"), 180_000, 500);
  const ai = await items(a.id), mi = await items(main.id), bi = await items(b.id);
  const xml = await (await JSZip.loadAsync(readFileSync(docs[0]!.path))).file("word/document.xml")!.async("string");
  report.check(S, "B 중지 후 A의 실제 문서 편집·저장과 메인 응답 완료", ai.some(item => item.kind === "turnEnd" && item.status === "completed") && mi.some(item => item.kind === "turnEnd" && item.status === "completed") && xml.includes(marker) && !mi.some(item => item.kind === "turnEnd" && item.status === "interrupted"));
  report.check(S, "A 완료 결과는 메인에 전달하고 요청·도구 이력은 분리", mi.some(item => item.kind === "notice" && item.text.includes(docs[0]!.name)) && !mi.some(item => item.kind === "user" && item.text.includes(marker)) && !bi.some(item => item.kind === "user" && item.text.includes(marker)));
  for (const [id, rows] of [["main", mi], ["a", ai], ["b", bi]] as const) writeFileSync(report.path(`${id}-items.json`), JSON.stringify(rows, null, 2));
  writeFileSync(report.path("document.xml"), xml);
  await activate("parallel-a");
  report.check(S, "메인 작업 후 문서 A의 저장된 본문과 대화 유지", await wd.execute<boolean>('return document.querySelector(".tiptap")?.textContent.includes(arguments[0]) === true && document.querySelector(".ai-panel")?.textContent.includes(arguments[0]) === true;', marker), undefined, await shot(ctx, "parallel-completed-a.png"));
  report.check(S, "문서 AI 작업 중 페이지 예외 없음", (await pageErrors(wd)).length === 0);
} catch (error) {
  report.check(S, "실제 설치 앱 시나리오", false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null, page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML}').catch(() => null), snapshot: await ctx.app.api("GET", "/api/snapshot").catch(() => null) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  monitoring = false; await monitor?.catch(() => {}); writeFileSync(report.path("parallel-states.json"), JSON.stringify(states, null, 2));
  await stage.close(); report.write({ binary, providers: "real subscriptions", source: "installed native app with original Office AI panels" }); console.log(report.summary()); if (report.steps.some(row => !row.ok)) process.exitCode = 1;
}
