import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** Original live serializers through visible menus; no model calls. */
export async function textWordOutputScenario(ctx: Ctx) {
  const { wd, api } = ctx.app, S = "텍스트 문서 Word·ODT 출력";
  const work = await api<Work>("POST", "/api/works", { title: "Word ODT 출력", cwd: null });
  const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const key = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  const click = async (text: string, selector = "button,[role=menuitem]") => {
    if (!await until(async () => {
      for (const button of await wd.findAll(selector)) if (await wd.displayed(button) && await wd.execute<boolean>("return arguments[0].textContent.trim() === arguments[1]", button, text)) { await wd.click(button); return true; }
      return false;
    }, 15000)) throw new Error(`Missing command: ${text}`);
  };
  const pane = '.pane[data-tab-active="true"]';
  const enter = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`${pane} iframe.office-frame`, 30000)); };
  const menu = async (label: string) => { await wd.frame(null); await wd.click(await wd.waitFor(`${pane} button[aria-label="문서 파일 메뉴"]`)); await click(label, ".office-file-menu [role=menuitem]"); };
  const destination = async (path: string) => {
    await wd.frame(null);
    const field = await wd.waitFor('.office-output-dialog input[aria-label="저장할 파일 경로"]', 90000);
    await wd.click(field); await key("a"); await wd.sendKeys(field, path); await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]'));
  };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  mkdirSync(join(work.cwd, "assets")); writeFileSync(join(work.cwd, "assets/picture.png"), png);
  for (const format of ["md", "html"] as const) {
    const source = join(work.cwd, `원문.${format}`), marker = `UNSAVED ${format.toUpperCase()} WORD OUTPUT`;
    writeFileSync(source, format === "md"
      ? "# 원래 제목\r\n\r\n![그림](assets/picture.png)\r\n\r\n$$\r\nx^2+y^2=z^2\r\n$$\r\n\r\n원래 본문\r\n"
      : '<!doctype html><html><head><style>body{font:18px sans-serif}img{width:60px;height:60px}</style></head><body><h1>원래 제목</h1><img src="assets/picture.png"><p>원래 본문</p></body></html>');
    const original = readFileSync(source), artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source });
    const tab = { id: `text-word-${format}`, workId: work.id, sessionId: main.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "rich" } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "text-word-pane", panes: [{ ...tab, id: "text-word-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd); await enter(); await installProbe(wd);
    if (format === "html") await click("분할");
    const editor = await wd.waitFor(format === "md" ? '.tiptap[contenteditable="true"]' : '.cm-content[contenteditable="true"]', 60000);
    await wd.click(format === "md" ? await wd.waitFor(".tiptap h1") : editor);
    if (format === "html") await key("\ue010");
    await wd.sendKeys(editor, format === "md" ? ` ${marker}` : `<p>${marker}</p>`);
    await wd.execute(`window.__wordExports=[];for(const name of ["exportDocx","exportOdt"]){const api=window.markdownApi||window.htmlApi, original=api[name];api[name]=async(...args)=>{const result=await original(...args);window.__wordExports.push({name,result});return result}}`);
    const wordPath = join(work.cwd, `실제-${format}.docx`);
    await menu("Word로 내보내기"); await destination(wordPath);
    if (!await until(async () => existsSync(wordPath), 120000)) throw new Error(`${format} Word export did not finish`);
    await enter();
    if (!await until(() => wd.execute<boolean>("return window.__wordExports.some(x=>x.name==='exportDocx'&&x.result.ok)"), 10000)) throw new Error("Word export was not acknowledged");
    const word = await JSZip.loadAsync(readFileSync(wordPath)), xml = await word.file("word/document.xml")!.async("string");
    ctx.report.check(S, `${format}: 미저장 글과 실제 그림을 Word로 출력`, xml.includes(marker) && Object.keys(word.files).some(p => p.startsWith("word/media/") && !word.files[p]!.dir));
    ctx.report.check(S, `${format}: 원본 파일·판·편집 내용 유지`, readFileSync(source).equals(original) && (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision === artifact.revision && await wd.execute<boolean>("return document.body.textContent.includes(arguments[0])", marker));
    copyFileSync(wordPath, ctx.report.path(`text-${format}.docx`));
    if (format === "md") {
      const canceled = join(work.cwd, "취소.odt");
      await menu("ODT로 내보내기"); await destination(canceled); await enter();
      await wd.waitFor("dialog.workbench-export-report[open]", 30000);
      ctx.report.check(S, "MD: 수식 변환 보고를 저장 전에 표시", await wd.execute<boolean>("return document.querySelector('.workbench-export-report').textContent.includes('수식')"), undefined, await shot(ctx, "odt-report.png"));
      await click("취소", ".workbench-export-report button");
      const canceledReply = await until(() => wd.execute<boolean>("return window.__wordExports.some(x=>x.name==='exportOdt'&&x.result.canceled)"), 10000);
      ctx.report.check(S, "MD: 보고 취소는 파일을 쓰지 않음", canceledReply && !existsSync(canceled) && readFileSync(source).equals(original));
    }
    const odtPath = join(work.cwd, `실제-${format}.odt`);
    await menu("ODT로 내보내기"); await destination(odtPath); await enter();
    if (!await until(async () => {
      if (await wd.find("dialog.workbench-export-report[open]")) await click("저장", ".workbench-export-report button");
      return existsSync(odtPath);
    }, 120000)) throw new Error(`${format} ODT export did not finish`);
    if (!await until(() => wd.execute<boolean>("return window.__wordExports.some(x=>x.name==='exportOdt'&&x.result.path)"), 10000)) throw new Error("ODT export was not acknowledged");
    const odt = await JSZip.loadAsync(readFileSync(odtPath)), content = await odt.file("content.xml")!.async("string");
    ctx.report.check(S, `${format}: ODT 글·그림·파일 형식`, content.includes(marker) && await odt.file("mimetype")!.async("string") === "application/vnd.oasis.opendocument.text" && Object.keys(odt.files).some(p => /Pictures\//.test(p) && !odt.files[p]!.dir));
    ctx.report.check(S, `${format}: ODT 출력도 원본과 판 보존`, readFileSync(source).equals(original) && (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision === artifact.revision);
    copyFileSync(odtPath, ctx.report.path(`text-${format}.odt`));
    ctx.report.check(S, `${format}: 화면 예외 없음`, !(await pageErrors(wd)).length, undefined, await shot(ctx, `text-word-${format}.png`));
    if (format === "md") {
      const openedPath = join(work.cwd, "변환해 열기.docx");
      await menu("Word로 변환해 열기"); await destination(openedPath); await wd.frame(null);
      if (!await until(() => wd.execute<boolean>(`return document.querySelector('${pane} .doc-name')?.textContent==='변환해 열기.docx'`), 30000)) throw new Error("Converted Word did not open");
      await enter(); await wd.waitFor('.tiptap[contenteditable="true"]', 60000);
      ctx.report.check(S, "MD: 변환 결과를 실제 Word 편집 탭으로 열기", await wd.execute<boolean>("return document.body.textContent.includes(arguments[0])", marker));
      await wd.frame(null); await wd.click(await wd.waitFor(`[data-tab-id="${tab.id}"] [role=tab]`));
      await until(() => wd.execute<boolean>(`return document.querySelector('${pane} .doc-name')?.textContent==='원문.md'`), 10000); await enter();
      const live = await until(() => wd.execute<boolean>("return document.querySelector('.tiptap')?.textContent.includes(arguments[0])", marker), 10000);
      const diagnostic = { live, originalUnchanged: readFileSync(source).equals(original), revision: (await snapshot()).artifacts.find(a => a.id === artifact.id)?.revision };
      writeFileSync(ctx.report.path("text-word-source-return.json"), JSON.stringify(diagnostic, null, 2));
      ctx.report.check(S, "MD: 원문 탭 복귀 후 미저장 편집·원문 파일 보존", live && diagnostic.originalUnchanged && diagnostic.revision === artifact.revision, JSON.stringify(diagnostic), await shot(ctx, "text-word-source-return.png"));
    }
    await wd.frame(null);
  }
}
