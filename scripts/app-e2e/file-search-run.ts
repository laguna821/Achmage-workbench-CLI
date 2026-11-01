import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Artifact, SearchPage, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!); mkdirSync(outDir, { recursive: true });
process.env.XDG_CURRENT_DESKTOP = "GNOME";
const report = new Report(outDir), S = "파일 검색 재정렬", key = "synthetic-file-search-key";
let preferred = "B.md", fail = false;
const calls: { query: string; titles: string[]; authorization: boolean; hidden: boolean; failed: boolean }[] = [];
const server = createServer(async (req, res) => {
  let text = ""; for await (const chunk of req) text += chunk;
  const request = JSON.parse(text), docs = request.state.documents;
  calls.push({ query: request.state.query, titles: docs.map((doc: any) => doc.title), authorization: req.headers.authorization === `Bearer ${key}`, hidden: text.includes("HIDDEN_RERANK_SECRET"), failed: fail });
  writeFileSync(join(outDir, "requests.json"), JSON.stringify(calls, null, 2));
  res.writeHead(fail ? 403 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify(fail ? { error: key } : { answers: Object.fromEntries(docs.map((doc: any, i: number) => {
    const score = doc.title === preferred ? 2 : 0;
    return [`d${i}`, { type: "score", score, confidence: 1, probabilities: { 0: score ? 0 : 1, 1: 0, 2: score ? 1 : 0 } }];
  })) }));
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`;
const stage = await openStage(outDir, { privateKeyring: true, nativeX11: true });
let ctx: Ctx | null = null, phase = "start";
try {
  const launch = { binary, engines: "stand-in" as const, profile: "file-search" };
  ctx = { stage, app: await stage.launch({ ...launch, name: "file-search" }), report }; await startScenario(ctx);
  let wd = ctx.app.wd; await wd.setWindowRect({ width: 1500, height: 1000 });
  const api = <T>(method: string, path: string, body?: unknown) => ctx!.app.api<T>(method, path, body);
  const control = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  const click = async (text: string, selector = "button,[role=option]") => {
    if (!await until(async () => { for (const element of await wd.findAll(selector)) if (await wd.displayed(element) && await wd.execute<boolean>('return arguments[0].textContent.trim()===arguments[1]', element, text)) { await wd.click(element); return true; } return false; }, 10000)) throw new Error(`Missing control: ${text}`);
  };
  const fill = async (selector: string, value: string) => { const input = await wd.waitFor(selector); await wd.click(input); await control("a"); await wd.sendKeys(input, value); };
  const settingsFile = join(ctx.app.dataDir, "office/file-search-settings.json"), saved = () => JSON.parse(readFileSync(settingsFile, "utf8"));
  const openSettings = async () => {
    await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await click("문서 AI 설정…");
    await wd.frame(await wd.waitFor('iframe[title="문서 AI 설정 화면"]')); await installProbe(wd);
    await wd.click(await wd.waitFor(".set-adv-toggle")); await click("AI 미디어 및 검색", '.set-adv-tabs [role="tab"]');
    await wd.waitFor('[role="switch"][aria-label="Jev 검색 재정렬"]');
  };
  const closeSettings = async () => { await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="문서 AI 설정 닫기"]')); };
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), originals = new Map<string, string>();
  for (const name of ["A.md", "B.md"]) {
    const path = join(work.cwd, name), raw = `# ${name}\r\n\r\n교육 연구 자료입니다. <span class="redact-span" data-redaction="" data-label="가림">HIDDEN_RERANK_SECRET</span>\r\n`;
    writeFileSync(path, raw); originals.set(path, raw); await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
  }
  const query = "교육 연구", local = await api<SearchPage>("GET", `/api/search?q=${encodeURIComponent(query)}&scope=document&per=20&legacy=0`);
  preferred = basename(local.groups[0]!.hits.at(-1)!.path!);
  phase = "original settings"; await openSettings();
  report.check(S, "원본 파일 검색 설정 표시·기본 꺼짐·조회 무변경", await wd.attribute(await wd.waitFor('[role="switch"][aria-label="Jev 검색 재정렬"]'), "aria-checked") === "false" && !existsSync(settingsFile) && calls.length === 0);
  await wd.click(await wd.waitFor('[role="switch"][aria-label="Jev 검색 재정렬"]'));
  await wd.click(await wd.waitFor('[aria-label="Jev 엔드포인트"]')); await wd.click(await wd.waitFor('[role="option"][data-value="custom"]'));
  await fill("#set-search-jev-url", endpoint); await fill("#set-search-jev-model", "fixture-decision"); await fill("#set-search-jev-key", key);
  await click("연결 테스트", ".set-pane-actions button");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(\'[aria-label="Jev 검색 재정렬"]\').closest("section").textContent.includes("연결 성공")'), 10000)) throw new Error("Original rerank probe did not succeed");
  report.check(S, "미저장 초안의 원본 연결 검사·실제 인증 헤더", calls.some(call => call.query === "connection test" && call.authorization) && !existsSync(settingsFile));
  await click("저장", ".set-pane-actions button");
  if (!await until(async () => existsSync(settingsFile) && saved().rerank, 10000)) throw new Error("Original settings save did not finish");
  report.check(S, "원본 저장 버튼·실제 OS 키 봉인", saved().keys.custom.startsWith("sealed:v1:workbench:") && !readFileSync(settingsFile, "utf8").includes(key), undefined, await shot(ctx, "settings-saved.png"));
  await closeSettings();
  phase = "actual search"; await control("k"); await fill('input[aria-label="찾을 말"]', query);
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".search-summary")?.textContent.includes("문서 결과 AI 재정렬")'), 15000)) throw new Error("Ctrl+K reranking did not finish");
  report.check(S, "Ctrl+K 실제 파일 결과 순서 변경·가림 처리", await wd.execute<boolean>('return document.querySelector(".palette-entry .palette-title")?.textContent.includes(arguments[0])', preferred.replace(/\.md$/, "")) && calls.some(call => call.query === query && call.authorization) && calls.every(call => !call.hidden), undefined, await shot(ctx, "ranked-search.png"));
  await wd.sendKeys(await wd.waitFor('input[aria-label="찾을 말"]'), KEY.escape);
  await api("POST", "/api/office-knowledge", { action: "add", input: { paths: [...originals.keys()] } });
  const library = await api<{ name: string }[]>("POST", "/api/office-knowledge", { action: "search", input: { query } });
  report.check(S, "별표 파일 검색도 같은 원본 재정렬 사용", library[0]?.name === preferred);
  fail = true; const failureQuery = "교육";
  const before = await api<SearchPage>("GET", `/api/search?q=${encodeURIComponent(failureQuery)}&scope=document&per=20&legacy=0`), failureResult = await api<SearchPage>("GET", `/api/search?q=${encodeURIComponent(failureQuery)}&scope=document&per=20&legacy=0&rerank=1`);
  writeFileSync(report.path("fallback-responses.json"), JSON.stringify({ before, failureResult }, null, 2));
  const order = (page: SearchPage) => JSON.stringify({ total: page.total, groups: page.groups.map(group => ({ key: group.key, total: group.total, hits: group.hits.map(hit => hit.key) })) });
  report.check(S, "서비스 실패는 로컬 검색 순서 유지", !failureResult.reranked && order(failureResult) === order(before) && calls.at(-1)?.failed === true);
  report.check(S, "검색·검사는 문서 원문을 변경하지 않음", [...originals].every(([path, text]) => readFileSync(path, "utf8") === text)); fail = false;
  phase = "selective import";
  await api("POST", "/api/office-preferences", { channel: "home:set-author-name", args: ["유지할 작성자"] });
  const prefsPath = join(ctx.app.dataDir, "office/app-settings.json"), prefsBefore = readFileSync(prefsPath, "utf8");
  const source = join(outDir, "original-ieum"); mkdirSync(source);
  const original = JSON.stringify({ authorName: "원본 작성자", fileSearch: { rerank: true, jevEndpoint: "custom", jevKeys: { custom: key }, customBaseUrl: endpoint, customModel: "imported-decision" }, unknown: [null, "keep"] }, null, 3);
  writeFileSync(join(source, "app-settings.json"), original);
  await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await click("이음오피스 설정 가져오기…");
  await fill('.office-import-dialog input:not([type="checkbox"])', source); await click("가져올 항목 확인"); await wd.waitFor(".office-import-preview");
  report.check(S, "검색 설정·검색 키를 별도 선택하며 기본 미선택", await wd.execute<boolean>('return [...document.querySelectorAll(".office-import-choice")].filter(x=>x.textContent.includes("검색")).length===2 && [...document.querySelectorAll(".office-import-choice input")].every(x=>!x.checked)'));
  for (const label of ["파일 검색 재정렬 설정", "검색 API 키 포함"]) {
    const checkbox = await wd.execute<any>('return [...document.querySelectorAll(".office-import-choice")].find(x=>x.textContent.includes(arguments[0])).querySelector("input")', label); await wd.click(checkbox);
  }
  await click("선택한 항목 가져오기");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".office-import-dialog").textContent.includes("파일 검색 재정렬 설정 가져옴")'), 15000)) throw new Error("File search import did not finish");
  report.check(S, "구형 필드 이행·키 봉인·백업·원본/다른 설정 보존", saved().customModel === "imported-decision" && saved().keys.custom.startsWith("sealed:v1:workbench:") && readFileSync(prefsPath, "utf8") === prefsBefore && readFileSync(join(source, "app-settings.json"), "utf8") === original && readdirSync(join(ctx.app.dataDir, "office")).some(name => name.startsWith("file-search-settings.") && name.endsWith(".sealed-backup.json")));
  await click("완료"); report.check(S, "부모 화면 예외 없음", (await pageErrors(wd)).length === 0);
  phase = "restart"; await ctx.app.close(); ctx.app = await stage.launch({ ...launch, name: "file-search-restarted" }); wd = ctx.app.wd;
  await openSettings();
  report.check(S, "재시작 후 원본 화면에 가져온 모델·봉인 키 유지", await wd.attribute(await wd.waitFor("#set-search-jev-model"), "value") === "imported-decision" && (await wd.attribute(await wd.waitFor("#set-search-jev-key"), "value"))?.startsWith("__wb_file_search_key_") === true);
  await click("연결 테스트", ".set-pane-actions button");
  report.check(S, "재시작 후 보관 키로 실제 연결 검사", await until(() => wd.execute<boolean>('return document.querySelector(\'[aria-label="Jev 검색 재정렬"]\').closest("section").textContent.includes("연결 성공")'), 10000) && calls.at(-1)?.authorization === true);
  report.check(S, "설정 화면 예외 없음", (await pageErrors(wd)).length === 0);
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await stage.close(); report.write({ binary, modelCalls: 0, decisionServer: "local protocol fixture", keys: "synthetic inputs / actual OS vault" }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1;
}
