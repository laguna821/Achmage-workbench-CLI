import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import type { Artifact, Snapshot, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { fixture } from "./office-suite.ts";
import { KEY } from "./webdriver.ts";

const binary = resolve(process.argv[2]!), outDir = resolve(process.argv[3]!);
mkdirSync(outDir, { recursive: true });
const report = new Report(outDir), stage = await openStage(outDir, { nativeX11: true });
const S = "공통 문서 설정", source = join(outDir, "original-ieum"); mkdirSync(source, { recursive: true });
const original = JSON.stringify({ authorName: "가져온 작성자", aiPanelSide: "right", aiPanelFontSize: "custom", aiPanelCustomFontSize: 18,
  aiPanelSpellcheck: false, aiPanelOpenInNewDocs: true, aiPanelShowSidebar: true, documentTheme: "light", autoSaveDefault: true, mcpEnabled: true });
writeFileSync(join(source, "app-settings.json"), original);
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
let ctx: Ctx | null = null, phase = "start";
try {
  const launch = { binary, engines: "stand-in" as const, profile: "office-preferences" };
  ctx = { stage, app: await stage.launch({ ...launch, name: "preferences" }), report }; await startScenario(ctx);
  let wd = ctx.app.wd; await wd.setWindowRect({ width: 1440, height: 1000 });
  const api = <T>(method: string, path: string, body?: unknown) => ctx!.app.api<T>(method, path, body);
  const clickText = async (text: string) => { const element = await wd.execute<any>('return [...document.querySelectorAll("button")].find(e=>e.textContent.trim()===arguments[0]);', text); if (!element) throw new Error(`Missing button: ${text}`); await wd.click(element); };
  const inputText = async (selector: string, text: string) => {
    const input = await wd.waitFor(selector); await wd.click(input);
    await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
    await wd.sendKeys(input, text);
  };
  phase = "import preview";
  await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await clickText("이음오피스 설정 가져오기…");
  await inputText('.office-import-dialog input:not([type="checkbox"])', source); await clickText("가져올 항목 확인"); await wd.waitFor(".office-import-preview");
  report.check(S, "AI 키 없이 문서 표시 설정만 선택해 가져오기", await wd.execute<boolean>('return document.querySelector(".office-import-preview").innerText.includes("문서 표시 설정 가져오기") && document.querySelectorAll(".office-import-preview input[type=checkbox]").length===1;'), undefined, await shot(ctx, "preferences-import.png"));
  await clickText("선택한 항목 가져오기");
  if (!await until(() => wd.execute<boolean>('return document.querySelector(".office-import-dialog")?.innerText.includes("문서 표시 설정 가져옴");'), 15000)) throw new Error("Preferences import did not finish");
  const prefsPath = join(ctx.app.dataDir, "office/app-settings.json");
  report.check(S, "원본 설정 보존·표시 설정 이행·실행 동의 제외", readFileSync(join(source, "app-settings.json"), "utf8") === original && !readFileSync(prefsPath, "utf8").includes("mcpEnabled"));
  await clickText("완료");
  phase = "settings UI";
  await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]')); await clickText("문서 AI 설정…");
  await wd.frame(await wd.waitFor('iframe[title="문서 AI 설정 화면"]')); await installProbe(wd);
  await wd.waitFor('.wb-document-preferences:not(:disabled)');
  report.check(S, "설정 화면에 가져온 작성자와 글자 크기 표시", await wd.execute<boolean>('return document.querySelector("#set-author-name").value==="가져온 작성자" && document.querySelector(".wb-font-size").value==="18";'));
  await inputText("#set-author-name", "설정 화면 작성자"); await wd.sendKeys(await wd.waitFor("#set-author-name"), KEY.enter);
  if (!await until(async () => JSON.parse(readFileSync(prefsPath, "utf8")).authorName === "설정 화면 작성자", 10000)) throw new Error("Author UI did not save");
  await wd.waitFor('.wb-document-preferences:not(:disabled)'); await inputText(".wb-font-size", "21"); await wd.sendKeys(await wd.waitFor(".wb-font-size"), KEY.enter);
  if (!await until(async () => JSON.parse(readFileSync(prefsPath, "utf8")).aiPanelCustomFontSize === 21, 10000)) throw new Error("Font UI did not save");
  report.check(S, "원본 설정 컨트롤의 실제 입력·저장", true, undefined, await shot(ctx, "preferences-settings.png"));
  await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="문서 AI 설정 닫기"]'));
  const work = await api<Work>("POST", "/api/works", { title: S, cwd: null });
  const originals: { path: string; hash: string; format: string }[] = [];
  const formats = ["docx", "html", "hwpx", "pptx", "xlsx", "pdf", "xmind", "epub", "md"] as const;
  const bridges = { docx: "desktop", html: "htmlApi", hwpx: "hwpApi", pptx: "slidesApi", xlsx: "desktopApi", pdf: "pdfApi", xmind: "mindmapApi", epub: "epubApi", md: "markdownApi" };
  for (const format of formats) {
    phase = format;
    const path = join(work.cwd, `설정 검사.${format}`);
    if (format === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), path); else await fixture(path, format);
    originals.push({ path, hash: digest(path), format });
    const doc = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
    const tab = { id: `prefs-${format}`, workId: work.id, sessionId: null, view: { kind: "document", artifactId: doc.id, proposalId: null }, ui: { mode: format === "md" || format === "html" ? "rich" : "edit" } };
    await wd.frame(null);
    await seedLayout(ctx, { ...(await api<Snapshot>("GET", "/api/snapshot")).prefs, paneLayout: { version: 2, focus: "prefs-pane", panes: [{ ...tab, id: "prefs-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.refresh(); await wd.frame(await wd.waitFor('iframe.office-frame', 30000)); await installProbe(wd);
    const rendered = await until(() => wd.execute<boolean>('return document.documentElement.dataset.aiPanelSide==="right" && document.documentElement.dataset.aiFontSize==="custom";'), 30000);
    const values = await wd.execute<any>('const api=window[arguments[0]]; return Promise.all([api.getAiPanelPrefs(), api.getAutoSaveDefault()]);', bridges[format]);
    report.check(S, `${format}: 원본 화면의 공통 패널·글자 크기·맞춤법·자동 저장`, rendered && values[0].customFontSize === 21 && values[0].spellcheck === false && values[1].on === true, undefined, await shot(ctx, `preferences-${format}.png`));
    if (["docx", "xlsx", "md"].includes(format)) report.check(S, `${format}: 원본 문서 페이지 테마`, await wd.execute<boolean>('return document.documentElement.dataset.docTheme==="light";'));
    const authorMethod = ({ docx: "getAuthorName", hwpx: "getAuthorName", xlsx: "getUserDisplayName", pdf: "getUsername" } as Record<string, string>)[format];
    if (authorMethod) {
      const author = await wd.execute<any>('return window[arguments[0]][arguments[1]]();', bridges[format], authorMethod);
      report.check(S, `${format}: 원본 작성자 경로`, (typeof author === "string" ? author : author.value) === "설정 화면 작성자");
    }
    if (format === "pptx") {
      if (!await until(() => wd.execute<boolean>('return window.slidesApi.getAllComments().then(slides=>slides.length>0);'), 30000)) throw new Error("PPT session did not finish opening");
      await wd.execute('return window.slidesApi.addComment({slideIndex:0,text:"PREFERENCE AUTHOR PROOF"});');
      await wd.execute('return window.slidesApi.save();');
      const zip = await JSZip.loadAsync(readFileSync(path));
      const commentXml = await Promise.all(Object.keys(zip.files).filter(name => /comment.*\.xml$/i.test(name)).map(name => zip.file(name)!.async("string")));
      report.check(S, "PPT 원본 메모 작성·저장에 공통 작성자 기록", commentXml.some(xml => xml.includes("설정 화면 작성자")) && commentXml.some(xml => xml.includes("PREFERENCE AUTHOR PROOF")));
    }
    if (format === "md") {
      phase = "autosave";
      const editor = await wd.waitFor('.tiptap[contenteditable="true"]', 30000); await wd.click(await wd.waitFor(".tiptap p")); await wd.sendKeys(editor, " AUTOMATIC SAVE PROOF");
      // The original editor saves every 30 seconds (and on blur); keep that policy.
      const saved = await until(async () => readFileSync(path, "utf8").includes("AUTOMATIC SAVE PROOF"), 45000);
      report.check(S, "Markdown 실제 입력이 Ctrl+S·탭 이동 없이 자동 저장", saved && (await api<Snapshot>("GET", "/api/snapshot")).artifacts.find(item => item.id === doc.id)!.revision > 1);
      if (!saved) throw new Error("Autosave did not save the original editor input");
      phase = "live preferences";
      await api("POST", "/api/office-preferences", { channel: "home:set-ai-panel-prefs", args: [{ side: "left", spellcheck: true }] });
      report.check(S, "다른 창의 설정 변경이 열린 편집기에 반영", await until(() => wd.execute<boolean>('return window.markdownApi.getAiPanelPrefs().then(p=>document.documentElement.dataset.aiPanelSide==="left" && p.spellcheck===true);'), 15000));
      await api("POST", "/api/office-preferences", { channel: "home:set-document-theme", args: ["dark"] });
      report.check(S, "열린 문서의 페이지 테마 변경 반영", await until(() => wd.execute<boolean>('return document.documentElement.dataset.docTheme==="dark";'), 10000));
    }
    report.check(S, `${format}: 화면 예외 없음`, (await pageErrors(wd)).length === 0);
  }
  report.check(S, "표시 설정만으로 편집하지 않은 원문 바이트 보존", originals.filter(item => !["md", "pptx"].includes(item.format)).every(item => digest(item.path) === item.hash));
  phase = "restart"; await ctx.app.close(); ctx.app = await stage.launch({ ...launch, name: "preferences-restart" }); wd = ctx.app.wd;
  await wd.frame(await wd.waitFor('iframe.office-frame', 30000)); await installProbe(wd);
  report.check(S, "앱 재시작 후 설정·자동 저장된 문서 유지", await until(() => wd.execute<boolean>('return document.documentElement.dataset.aiPanelSide==="left" && document.body.innerText.includes("AUTOMATIC SAVE PROOF");'), 30000)
    && JSON.parse(readFileSync(prefsPath, "utf8")).authorName === "설정 화면 작성자", undefined, await shot(ctx, "preferences-restart.png"));
} catch (error) {
  report.check(S, phase, false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ phase, error: String(error), page: await ctx.app.wd.execute('return document.body.innerText').catch(() => null), errors: await pageErrors(ctx.app.wd).catch(() => []) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  await stage.close(); report.write({ binary, sourceUnchanged: readFileSync(join(source, "app-settings.json"), "utf8") === original }); console.log(report.summary()); if (report.steps.some(step => !step.ok)) process.exitCode = 1;
}
