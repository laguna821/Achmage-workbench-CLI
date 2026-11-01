import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!);
mkdirSync(outDir, { recursive: true }); process.env.XDG_CURRENT_DESKTOP = "GNOME";
const report = new Report(outDir), S = "Markdown 이미지 호스트·테마 가져오기";
const image = readFileSync(resolve("vendor/ieumoffice/apps/shell/build/icons/64x64.png")), key = "synthetic-md-access", secret = "synthetic-md-secret";
const requests: { kind: string; method: string; image: boolean; authorization: boolean; failed: boolean }[] = [];
let failUploads = false;
const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/public/")) { res.writeHead(200, { "content-type": "image/png" }); res.end(image); return; }
  const kind = req.url?.split("/")[2] ?? "", parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
  const body = Buffer.concat(parts), authorization = String(req.headers.authorization ?? "");
  const entry = { kind, method: req.method ?? "", image: kind === "github" ? Buffer.from(JSON.parse(body.toString()).content, "base64").equals(image) : kind === "smms" ? body.includes(image) : body.equals(image), authorization: kind === "s3" ? authorization.includes(`Credential=${key}/`) : authorization === (kind === "github" ? `Bearer ${secret}` : secret), failed: failUploads };
  requests.push(entry); writeFileSync(join(outDir, "uploads.json"), JSON.stringify(requests, null, 2));
  res.writeHead(failUploads ? 403 : 200, { "content-type": "application/json" });
  res.end(JSON.stringify(failUploads ? { message: `denied ${secret}` } : kind === "smms" ? { success: true, data: { url: `${relay}/public/smms.png` } } : { content: { download_url: `${relay}/public/github.png` } }));
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const relay = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.APP_E2E_MARKDOWN_RELAY = relay;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${resolve("scripts/fixtures/markdown-host-preload.mjs")}`].filter(Boolean).join(" ");
const stage = await openStage(outDir, { privateKeyring: true, nativeX11: true });
let ctx: Ctx | null = null, phase = "start";
try {
  const launch = { binary, engines: "stand-in" as const, profile: "markdown-host" };
  ctx = { stage, app: await stage.launch({ ...launch, name: "markdown-host" }), report }; await startScenario(ctx);
  let wd = ctx.app.wd;
  const api = <T>(method: string, path: string, body?: unknown) => ctx!.app.api<T>(method, path, body);
  await wd.setWindowRect({ width: 1600, height: 1000 });
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const path = join(work.cwd, "호스트.md"), original = "# 원문 보존\r\n\r\n그림 붙여넣기 시험\r\n"; writeFileSync(path, original);
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
  const tab = { id: "markdown-host-source", workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "rich" } };
  const showDoc = async () => { const snapshot = await api<Snapshot>("GET", "/api/snapshot"); await seedLayout(ctx!, { ...snapshot.prefs, paneLayout: { version: 2, focus: "markdown-host-pane", panes: [{ ...tab, id: "markdown-host-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } }); await wd.refresh(); await enter(); };
  const enter = async () => { await wd.frame(null); await wd.frame(await wd.waitFor('.pane[data-tab-active="true"] iframe.office-frame', 30000)); await wd.waitFor('.tiptap[contenteditable="true"]', 30000); await installProbe(wd); };
  const control = (key: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: KEY.control }]);
  const click = async (text: string, selector = "button,[role=menuitem]") => {
    if (!await until(async () => { for (const button of await wd.findAll(selector)) if (await wd.displayed(button) && await wd.execute<boolean>("return arguments[0].textContent.trim()===arguments[1]", button, text)) { await wd.click(button); return true; } return false; }, 10000)) throw new Error(`Missing button: ${text}`);
  };
  const fill = async (element: any, value: string) => { await wd.click(element); await control("a"); await wd.sendKeys(element, value); };
  const settingsPath = join(ctx.app.dataDir, "office/markdown-settings.json");
  await showDoc();
  phase = "legacy theme fallback";
  await wd.execute('localStorage.setItem("workbench.office.markdown.prefs",JSON.stringify({markdownTheme:"nord"}));'); await wd.frame(null); await wd.refresh(); await enter();
  report.check(S, "기존 localStorage 테마를 설정 이행 전까지 유지", await until(() => wd.execute<boolean>('return !!document.querySelector(\'[data-markdown-theme="nord"]\')'), 10000) && !existsSync(settingsPath));
  await wd.click(await wd.waitFor('.md-theme-wrap button')); await click("Newsprint", ".md-theme-menu button");
  report.check(S, "원본 테마 메뉴에서 호스트 설정에 저장", await until(async () => existsSync(settingsPath) && JSON.parse(readFileSync(settingsPath, "utf8")).markdownTheme === "newsprint", 10000));
  const configure = async (kind: string) => {
    await wd.click(await wd.waitFor('button[aria-label="이미지 호스트 설정"]')); await wd.waitFor(".image-host-dialog select");
    await wd.click(await wd.waitFor(`.image-host-dialog option[value="${kind}"]`));
    const fields: Record<string, string> = kind === "s3" ? { Endpoint: "https://markdown-s3.example.invalid", Bucket: "pictures", "Access Key ID": key, "Secret Access Key": secret, "공개 기본 URL": `${relay}/public/s3` } : kind === "smms" ? { "API Token": secret } : { "API Token": secret, Owner: "markdown-fixture", Repo: "pictures" };
    for (const [label, value] of Object.entries(fields)) {
      const element = await wd.execute<any>('return [...document.querySelectorAll(".image-host-row")].find(x=>x.querySelector("span")?.textContent===arguments[0])?.querySelector("input")', label);
      if (!element) throw new Error(`Missing image-host field: ${label}`); await fill(element, value);
    }
    await wd.click(await wd.waitFor(".image-host-btn-primary"));
    if (!await until(async () => !await wd.find(".image-host-dialog"), 15000)) throw new Error(`${kind} settings did not save`);
  };
  const paste = async (name: string) => {
    const editor = await wd.waitFor('.tiptap[contenteditable="true"]'); await wd.click(editor); await control("\ue010");
    await wd.execute('const bytes=Uint8Array.from(atob(arguments[0]),x=>x.charCodeAt(0)), dt=new DataTransfer(); dt.items.add(new File([bytes],arguments[1]+".png",{type:"image/png"})); document.querySelector(".tiptap").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:dt}));', image.toString("base64"), name);
    if (!await until(() => wd.execute<boolean>('return [...document.querySelectorAll(".tiptap img")].some(x=>x.alt===arguments[0]&&x.naturalWidth===64)', name), 15000)) throw new Error(`${name} image did not appear`);
  };
  for (const kind of ["s3", "smms", "github"]) {
    phase = `${kind} original settings and paste`; await configure(kind); const raw = readFileSync(settingsPath, "utf8");
    report.check(S, `${kind}: 원본 설정 화면과 실제 OS 키 봉인`, raw.includes("sealed:v1:workbench:") && !raw.includes(secret) && !raw.includes(key));
    await paste(kind); const request = requests.at(-1)!;
    report.check(S, `${kind}: 원본 붙여넣기로 인증·그림 업로드와 원격 그림 표시`, request.kind === kind && request.authorization && request.image && !request.failed);
  }
  phase = "fallback"; failUploads = true; await paste("offline-fallback");
  const assets = readdirSync(join(work.cwd, "assets")).filter(name => name.endsWith(".png"));
  report.check(S, "업로드 실패 시 원본 로컬 assets 사본으로 복귀", assets.some(name => readFileSync(join(work.cwd, "assets", name)).equals(image)) && await wd.execute<boolean>('return document.body.textContent.includes("로컬") && !document.body.textContent.includes(arguments[0])', secret));
  report.check(S, "업로드·실패 복귀는 원문을 자동 저장하지 않음", readFileSync(path, "utf8") === original && (await api<Snapshot>("GET", "/api/snapshot")).artifacts.find(a => a.id === artifact.id)?.revision === 1);
  await control("s"); if (!await until(async () => readFileSync(path, "utf8").includes("offline-fallback"), 10000)) throw new Error("Explicit Markdown save did not finish");
  const saved = readFileSync(path, "utf8"); report.check(S, "명시 저장 후 원격 주소와 로컬 사본 경로 유지", saved.includes(relay) && saved.includes("assets/") && !saved.includes(secret), undefined, await shot(ctx, "host-paste.png"));
  phase = "selective import"; await wd.frame(null);
  await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await click("이음오피스 설정 가져오기…"); await wd.waitFor(".office-import-dialog");
  const source = join(outDir, "original-ieum"); mkdirSync(source); const sourceFile = join(source, "markdown-settings.json");
  const legacy = JSON.stringify({ markdownTheme: "blubook", imageHost: { kind: "smms", token: "synthetic-imported-image-token" }, future: { preserve: true } }, null, 3); writeFileSync(sourceFile, legacy);
  await fill(await wd.waitFor('.office-import-dialog input:not([type="checkbox"])'), source); await click("가져올 항목 확인"); await wd.waitFor(".office-import-preview");
  const choices = async () => wd.execute<any[]>('return [...document.querySelectorAll(".office-import-choice")].map(x=>({text:x.textContent,checked:x.querySelector("input").checked}))');
  report.check(S, "테마와 인증키 포함 호스트를 별도로 선택", (await choices()).filter(x => x.text.includes("Markdown")).length === 2 && (await choices()).every(x => !x.checked));
  const choose = async (text: string) => { const field = await wd.execute<any>('return [...document.querySelectorAll(".office-import-choice")].find(x=>x.textContent.includes(arguments[0]))?.querySelector("input")', text); await wd.click(field); };
  await choose("Markdown 테마"); await click("선택한 항목 가져오기");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".office-import-dialog").textContent.includes("Markdown 테마 가져옴")'), 15000)) throw new Error("Theme import did not finish");
  let imported = JSON.parse(readFileSync(settingsPath, "utf8")); report.check(S, "테마만 가져오면 현재 호스트와 원본 설정 보존", imported.markdownTheme === "blubook" && imported.imageHost.kind === "github" && readFileSync(sourceFile, "utf8") === legacy);
  await click("완료"); await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await click("이음오피스 설정 가져오기…");
  await fill(await wd.waitFor('.office-import-dialog input:not([type="checkbox"])'), source); await click("가져올 항목 확인"); await wd.waitFor(".office-import-preview"); await choose("Markdown 이미지 호스트"); await click("선택한 항목 가져오기");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".office-import-dialog").textContent.includes("이미지 호스트 가져옴")'), 15000)) throw new Error("Host import did not finish");
  imported = JSON.parse(readFileSync(settingsPath, "utf8"));
  report.check(S, "선택한 호스트를 봉인해 가져오고 이전 설정을 백업", imported.imageHost.kind === "smms" && imported.imageHost.token.startsWith("sealed:v1:workbench:") && !readFileSync(settingsPath, "utf8").includes("synthetic-imported-image-token") && readdirSync(join(ctx.app.dataDir, "office")).filter(name => name.endsWith(".sealed-backup.json")).length === 2 && readFileSync(sourceFile, "utf8") === legacy);
  await click("완료"); report.check(S, "부모 화면 예외 없음", (await pageErrors(wd)).length === 0);
  phase = "restart"; await ctx.app.close(); ctx.app = await stage.launch({ ...launch, name: "markdown-host-restarted" }); wd = ctx.app.wd; await enter();
  report.check(S, "재시작 후 가져온 테마·호스트와 저장한 문서 유지", await until(() => wd.execute<boolean>('return !!document.querySelector(\'[data-markdown-theme="blubook"]\')'), 15000) && (await wd.execute<any>('return window.markdownApi.getImageHost()')).kind === "smms" && readFileSync(path, "utf8") === saved);
  report.check(S, "편집기 예외 없음", (await pageErrors(wd)).length === 0);
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return {text:document.body.innerText,html:document.documentElement.outerHTML}').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await stage.close(); report.write({ binary, modelCalls: 0, uploadServices: "local protocol relay", clipboard: "synthetic File paste through original handler", keys: "synthetic inputs / actual OS vault" }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1;
}
