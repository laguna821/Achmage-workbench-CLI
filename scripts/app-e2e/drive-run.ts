import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Snapshot } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { installProbe, pageErrors, shot, startScenario, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

// Separate from default app-e2e: this run compiles a desktop-client fixture into
// a dedicated host, never into the release's dist/ or the installed app.
const sourceBinary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!);
const root = resolve("."), appDir = join(outDir, "fixture-app"), fixtureDir = join(outDir, "google");
mkdirSync(join(appDir, "host"), { recursive: true }); mkdirSync(fixtureDir, { recursive: true });
copyFileSync(sourceBinary, join(appDir, "achmage-workbench"));
for (const name of ["web", "node", "ieumoffice", "skills", "licenses"]) {
  const from = name === "web" ? join(root, "apps/web/dist") : join(dirname(sourceBinary), name), to = join(appDir, name);
  if (existsSync(from) && !existsSync(to)) symlinkSync(from, to, "dir");
}
execFileSync(process.execPath, ["scripts/build-host.mjs"], { cwd: root, env: { ...process.env,
  WORKBENCH_HOST_BUILD_DIR: join(appDir, "host"), WORKBENCH_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", WORKBENCH_GOOGLE_CLIENT_SECRET: "fixture-only",
}, stdio: "inherit" });
const base64 = (text: string) => Buffer.from(text).toString("base64");
writeFileSync(join(fixtureDir, "initial.json"), JSON.stringify([
  { id: "note", name: "Drive 노트.md", mimeType: "text/markdown", base64: base64("# Drive 노트\n\nDRIVEORIGINAL\n") },
  { id: "reference", name: "참고 문서.md", mimeType: "text/markdown", base64: base64("DRIVEREFERENCE 본문") },
  { id: "google", name: "Google 문서", mimeType: "application/vnd.google-apps.document", base64: readFileSync(join(root, "vendor/ieumoffice/packages/docx-engine/tests/fixtures/truths/tnr-multiple-spacing/probe.docx")).toString("base64") },
]));
process.env.APP_E2E_DRIVE_FIXTURE = fixtureDir;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${join(root, "scripts/fixtures/google-drive-preload.mjs")}`].filter(Boolean).join(" ");
process.env.WORKBENCH_OPEN_URL = join(root, "scripts/fixtures/google-drive-open.mjs");
const report = new Report(outDir), stage = await openStage(outDir, { privateKeyring: true, nativeX11: true });
const S = "원본 Google Drive", requests: any[] = [];
let ctx: Ctx | null = null, phase = "start";
const remote = () => JSON.parse(readFileSync(join(fixtureDir, "remote.json"), "utf8"));
const provider = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += String(chunk);
  const body = JSON.parse(raw); requests.push(body);
  const tools = [{ name: "drive_search", input: { query: "참고", limit: 5 } }, { name: "drive_read", input: { file_id: "reference", offset: 0 } }, { name: "web_search", input: { query: "DRIVEREFERENCE" } }];
  const call = tools[requests.length - 1];
  const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `drive-${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { role: "assistant", content: "DRIVEAICOMPLETE" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`); res.end("data: [DONE]\n\n");
});
await new Promise<void>(done => provider.listen(0, "127.0.0.1", done));
try {
  const app = await stage.launch({ name: "drive", binary: join(appDir, "achmage-workbench"), engines: "stand-in", profile: "drive" });
  ctx = { stage, app, report }; await startScenario(ctx);
  const { wd } = app, api = <T>(method: string, path: string, body?: unknown) => app.api<T>(method, path, body);
  const invoke = (channel: string, args: unknown[] = []) => api<any>("POST", "/api/office-drive/invoke", { channel, args });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const key = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  const frame = async () => { await wd.frame(null); await wd.frame(await wd.waitFor('.pane[data-tab-active="true"] iframe.office-frame', 30000)); await installProbe(wd); };
  const openDrive = async () => {
    await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]'));
    await wd.click(await wd.execute('return [...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Google Drive…");'));
    await wd.frame(await wd.waitFor('iframe[title="Google Drive 화면"]')); await wd.waitFor(".set-drive", 30000); await installProbe(wd);
  };
  phase = "OAuth and original connection UI";
  await openDrive(); await wd.click(await wd.waitFor(".set-drive .set-btn-primary"));
  if (!await until(async () => (await invoke("drive:state")).state === "connected", 15000)) throw new Error("Drive OAuth did not connect");
  await wd.waitFor(".set-drive-account", 15000); await wd.waitFor(".drive-row", 15000);
  const token = readFileSync(join(app.dataDir, "office/drive/google-drive.json"), "utf8");
  report.check(S, "원본 계정 연결 화면·실제 loopback·OS 암호화", token.includes("sealed:v1:workbench:") && !token.includes("fixture-refresh"), undefined, await shot(ctx, "drive-connected.png"));
  report.check(S, "내 파일·공유·최근·검색 원본 탐색", await wd.execute<boolean>('return !!document.querySelector(".drive-search input") && document.querySelectorAll(".drive-toolbar [role=tab]").length===3;'));
  phase = "download and original editor";
  await wd.click(await wd.execute('return [...document.querySelectorAll(".drive-row")].find(b=>b.textContent.includes("Drive 노트.md"));'));
  await frame(); const editor = await wd.waitFor('.tiptap[contenteditable="true"]', 30000);
  const doc = (await snapshot()).artifacts.find(a => a.name === "Drive 노트.md"); if (!doc) throw new Error("Drive document was not registered");
  report.check(S, "내려받은 문서를 같은 Workbench 탭으로 열기", readFileSync(doc.path, "utf8").includes("DRIVEORIGINAL") && await wd.execute<boolean>('return document.body.innerText.includes("DRIVEORIGINAL");'), undefined, await shot(ctx, "drive-document.png"));
  await wd.click(editor); await wd.sendKeys(editor, "DRIVEEDIT"); await key("s");
  report.check(S, "실제 편집·저장 뒤 Drive 동일 파일 업로드", await until(async () => remote().uploads.some((item: any) => item.id === "note" && Buffer.from(item.base64, "base64").toString().includes("DRIVEEDIT")), 15000));
  phase = "remote conflict";
  writeFileSync(join(fixtureDir, "change.json"), JSON.stringify([{ id: "note", base64: base64("DRIVEREMOTECHANGE") }]));
  await wd.click(editor); await wd.sendKeys(editor, "DRIVELOCALCHANGE"); await key("s");
  await wd.frame(null); await wd.waitFor(".office-drive-question", 15000);
  report.check(S, "원격 변경을 감지하고 덮어쓰기·사본·PC 보존 선택", await wd.execute<boolean>('return document.querySelectorAll(".office-drive-choices button").length===3;'), undefined, await shot(ctx, "drive-conflict.png"));
  await wd.click(await wd.execute('return [...document.querySelectorAll(".office-drive-choices button")].find(b=>b.textContent.includes("사본"));'));
  if (!await until(async () => remote().uploads.some((item: any) => item.created && Buffer.from(item.base64, "base64").toString().includes("DRIVELOCALCHANGE")), 15000)) throw new Error("Drive conflict copy did not upload");
  report.check(S, "사본 저장 후 원격 원문 보존", Buffer.from(remote().files.find((file: any) => file.id === "note").base64, "base64").toString() === "DRIVEREMOTECHANGE");
  await wd.waitFor(".office-drive-question", 15000); await wd.click(await wd.waitFor(".office-drive-choices button"));
  phase = "independent document AI and Drive guard";
  const port = (provider.address() as { port: number }).port;
  const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
  settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "drive-fixture";
  settings.customEndpoints = [{ id: "drive-fixture", name: "Drive fixture model", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "", model: "drive-model", kind: "local", modelProfiles: { "drive-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
  writeFileSync(join(app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
  await frame(); await wd.execute('return window.workbenchOfficeAi.refresh();');
  if (!await until(() => wd.execute<boolean>('return window.aiOfficeDriveAi.driveAiEnabled();'), 15000)) throw new Error("Original Drive AI bridge did not become enabled");
  const input = await wd.waitFor('.ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)', 30000); await wd.click(input); await wd.sendKeys(input, "Drive 참고 문서를 찾아 읽어 줘.");
  await wd.click(await wd.waitFor(".ai-send-btn:not(:disabled)"));
  if (!await until(async () => requests.length >= 4 && await wd.execute<boolean>('return document.body.innerText.includes("DRIVEAICOMPLETE");'), 45000)) throw new Error("Original Drive AI loop did not finish");
  const messages = JSON.stringify(requests.at(-1).messages);
  report.check(S, "원본 독립 문서 AI의 Drive 검색·본문 읽기", messages.includes("DRIVEREFERENCE") && requests[0].tools.some((tool: any) => tool.function.name === "drive_read"));
  report.check(S, "Drive 본문을 읽은 대화의 외부 전송 차단", messages.includes("Refused: this conversation contains content read from Google Drive"), undefined, await shot(ctx, "drive-ai.png"));
  phase = "manual attachment while AI access is off";
  await invoke("drive:set-ai-access", [false]);
  await openDrive(); await wd.click(await wd.execute('return [...document.querySelectorAll(".drive-row")].find(b=>b.querySelector(".drive-name").textContent==="Google 문서");'));
  await frame(); await wd.waitFor(".tiptap[contenteditable=true]", 30000);
  const google = (await snapshot()).artifacts.find(a => a.name === "Google 문서.docx"); if (!google) throw new Error("Google document did not open as Word");
  report.check(S, "Google 문서를 원본 Word 편집기로 열기", readFileSync(google.path).subarray(0, 2).toString() === "PK", undefined, await shot(ctx, "drive-google-word.png"));
  await wd.click(await wd.waitFor(".ai-drive-attach-btn")); await wd.frame(null);
  await wd.frame(await wd.waitFor('iframe[title="Google Drive 화면"]')); await wd.waitFor('.drive-check input[aria-label="참고 문서.md"]', 15000);
  await wd.click(await wd.waitFor('.drive-check input[aria-label="참고 문서.md"]')); await wd.click(await wd.waitFor('.dp-foot .drive-primary:not(:disabled)'));
  await frame();
  report.check(S, "AI 접근을 꺼도 직접 선택 첨부·원래 파일명 유지", await until(() => wd.execute<boolean>('return [...document.querySelectorAll(".ai-panel,.copilot")].some(e=>e.innerText.includes("참고 문서.md"));'), 15000), undefined, await shot(ctx, "drive-attachment.png"));
  report.check(S, "미허용 Drive AI는 꺼짐", await wd.execute<boolean>('return window.aiOfficeDriveAi.driveAiEnabled().then(value=>value===false);'));
  await invoke("drive:disconnect");
  report.check(S, "연결 해제·토큰 폐기·PC 파일 보존", !existsSync(join(app.dataDir, "office/drive/google-drive.json")) && existsSync(doc.path) && remote().revoked);
  const errors = await pageErrors(wd); report.check(S, "화면 예외 없음", errors.length === 0, JSON.stringify(errors));
  writeFileSync(report.path("ai-requests.json"), JSON.stringify(requests, null, 2));
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return document.body.innerText').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []), requests }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
  await stage.close();
  const hashes = Object.fromEntries(readdirSync(join(appDir, "host")).map(name => [name, createHash("sha256").update(readFileSync(join(appDir, "host", name))).digest("hex")]));
  report.write({ sourceBinary, fixtureBinary: join(appDir, "achmage-workbench"), hostHashes: hashes, google: "injected fetch; real OAuth loopback, OS vault and original UI", ai: "fixture model" });
  console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1;
}
