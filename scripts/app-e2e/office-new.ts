import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLANK_OFFICE_DOCUMENTS, type Artifact, type ArtifactRevision, type Session, type Snapshot, type Work } from "@workbench/contracts";
import { savedText } from "./office-suite.ts";
import { epubFixture } from "./epub-fixture.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** User-facing new/open commands, then original engine input and persisted bytes. No model calls. */
export async function officeNewScenario(ctx: Ctx) {
  const { wd, api } = ctx.app, S = "Office 새 문서";
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const work = await api<Work>("POST", "/api/works", { title: "새 문서 통합", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
  const tab = { id: "new-office-tab", workId: work.id, sessionId: session.id, view: { kind: "work" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "new-office-pane", panes: [{ ...tab, id: "new-office-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
  const key = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  const clickText = async (selector: string, text: string) => {
    if (!await until(async () => {
      for (const button of await wd.findAll(selector)) if (await wd.displayed(button) && await wd.execute<boolean>("return arguments[0].textContent.trim() === arguments[1]", button, text)) { await wd.click(button); return true; }
      return false;
    }, 15000)) throw new Error(`Missing command ${text}`);
  };
  const fileMenu = async () => { await wd.frame(null); await clickText('.office-file-menu button[aria-label="문서 파일 메뉴"]', "파일"); };
  const editA1 = async () => {
    if (!await until(() => wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");'), 45000)) throw new Error("Workbook did not load");
    await wd.click(await wd.waitFor('[aria-label="Go To"]'));
    const ref = await wd.waitFor('.format-cells-dialog input'); await wd.click(ref); await wd.sendKeys(ref, "A1");
    await wd.click(await wd.waitFor('.format-cells-dialog .primary-action'));
    if (!await until(() => wd.execute<boolean>('return !document.querySelector(".format-cells-dialog");'), 5000)) throw new Error("Go To did not finish");
    const field = await wd.waitFor('#univer-container [contenteditable="true"]'); await wd.execute("arguments[0].focus()", field); await wd.press("\uE032");
  };
  const selected = process.env.APP_E2E_OFFICE_NEW_FORMATS?.split(",") ?? BLANK_OFFICE_DOCUMENTS.map((kind) => kind.format);
  if (selected.some((format) => !BLANK_OFFICE_DOCUMENTS.some((kind) => kind.format === format))) throw new Error("Unknown blank document format");
  for (const kind of BLANK_OFFICE_DOCUMENTS.filter((kind) => selected.includes(kind.format))) {
    const format = kind.format === "markdown" ? "md" : kind.format, marker = `NEW DOCUMENT ${format.toUpperCase()}`;
    await fileMenu(); await clickText('.office-file-menu [role="menuitem"]', `${kind.label}.${kind.extension}`);
    let artifact: Artifact | undefined;
    if (!await until(async () => { artifact = (await snapshot()).artifacts.find((a) => a.workId === work.id && a.format === kind.format); return !!artifact; }, 30000)) throw new Error(`Creation failed ${format}`);
    const source = artifact!;
    const enter = async () => { await wd.frame(null); await wd.frame(await wd.waitFor(`.pane[data-pane-active="true"] iframe.office-frame[title*="${kind.name}.${kind.extension}"]`, 30000)); };
    await enter(); await installProbe(wd);
    if (format === "html") await clickText("button", "분할");
    if (format === "docx" || format === "md" || format === "html") {
      const field = await wd.waitFor(format === "html" ? '.cm-content[contenteditable="true"]' : '.tiptap[contenteditable="true"]', 60000);
      await wd.click(field); await wd.sendKeys(field, format === "html" ? `<html><body><p>${marker}</p></body></html>` : marker);
    } else if (format === "pptx") {
      if (!await until(() => wd.execute<boolean>('return !!window.Konva?.stages?.some(stage=>stage.width()>200);'), 45000)) throw new Error("Blank slide did not render");
      const notes = await wd.waitFor(".notes-pane textarea"); await wd.click(notes); await wd.sendKeys(notes, marker);
    } else if (format === "xlsx") {
      await editA1();
      await wd.keys([...marker].flatMap((value) => [{ type: "keyDown" as const, value }, { type: "keyUp" as const, value }])); await wd.press(KEY.enter);
    } else if (format === "xmind") {
      await wd.click(await wd.waitFor('.mm-sheet-host:not([hidden]) me-tpc', 30000)); await wd.press("\uE032");
      const field = await wd.waitFor("#input-box"); await key("a"); await wd.press("\uE003"); await wd.sendKeys(field, marker); await wd.press(KEY.enter);
    } else if (format === "hwpx") {
      await wd.waitFor('.hwp-app[data-phase="ready"]', 45000);
      await wd.frame(null); const outer = await wd.waitFor(`iframe.office-frame[title*="${kind.name}.${kind.extension}"]`), outerRect = await wd.rect(outer);
      await wd.frame(outer); const inner = await wd.waitFor('.hwp-editor-host iframe'), innerRect = await wd.rect(inner); await wd.frame(inner);
      const rect = await wd.rect(await wd.waitFor('.document-page-canvas', 30000)); await wd.frame(null);
      await wd.pointer([{ type: "pointerMove", x: Math.round(outerRect.x + innerRect.x + rect.x + rect.width * .2), y: Math.round(outerRect.y + innerRect.y + rect.y + Math.min(160, rect.height * .18)), origin: "viewport" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      await wd.frame(outer); await wd.frame(inner);
      await wd.keys([...marker].flatMap((value) => [{ type: "keyDown" as const, value }, { type: "keyUp" as const, value }]));
    } else {
      if (!await until(() => wd.execute<boolean>('return document.querySelector(".pdf-page canvas")?.width>0;'), 45000)) throw new Error("Blank PDF did not render");
    }
    const before = readFileSync(source.path);
    await key("s");
    const persisted = format === "pdf" ? readFileSync(source.path).equals(before) : await until(async () => (await savedText(source.path, format)).includes(marker), 20000);
    ctx.report.check(S, `${format}: ${format === "pdf" ? "원본 빈 1쪽 표시·무변경 저장" : "원본 빈 문서 표시·직접 편집·저장"}`, persisted, undefined, await shot(ctx, `new-${format}-edit.png`));
    if (!persisted) throw new Error(`Blank ${format} edit did not save`);
    await wd.frame(null);
    const revisions = await api<ArtifactRevision[]>("GET", `/api/artifacts/${source.id}/revisions`);
    ctx.report.check(S, `${format}: 프로젝트·작업공간·대화 출처`, source.workspaceId === session.workspaceId && revisions[0]?.sessionId === session.id);
    await wd.refresh(); await enter();
    let reopened: boolean;
    if (format === "pdf") reopened = await until(() => wd.execute<boolean>('return document.querySelector(".pdf-page canvas")?.width>0;'), 45000);
    else if (format === "hwpx") reopened = await until(() => wd.execute<boolean>('return !!document.querySelector(".hwp-app[data-phase=ready]");'), 45000) && (await savedText(source.path, format)).includes(marker);
    else if (format === "xlsx") {
      // Univer's contenteditable is an empty keyboard host, not its painted cell value.
      await wd.execute('window.__newSheetPaint=[];const paint=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__newSheetPaint.push(String(text));return paint.call(this,text,...args)};');
      await editA1();
      await wd.press(KEY.escape);
      await wd.setWindowRect({ width: 1801, height: 1100 });
      reopened = await until(() => wd.execute<boolean>('return window.__newSheetPaint.join("").includes(arguments[0]);', marker), 10000);
      writeFileSync(ctx.report.path("new-xlsx-cell.json"), JSON.stringify(await wd.execute('return {painted:window.__newSheetPaint, keyboard:[...document.querySelectorAll("#univer-container [contenteditable=true]")].map(el=>({text:el.textContent,active:el===document.activeElement}))};'), null, 2));
    }
    else reopened = await until(() => wd.execute<boolean>('return document.body.textContent.includes(arguments[0]) || [...document.querySelectorAll("textarea")].some(e=>e.value.includes(arguments[0]));', marker), 30000);
    ctx.report.check(S, `${format}: 앱 새로 열기 뒤 원본 편집기와 저장 내용`, reopened, undefined, await shot(ctx, `new-${format}-reopen.png`));
    writeFileSync(ctx.report.path(`new-${format}-errors.json`), JSON.stringify(await pageErrors(wd)));
    if (!reopened) throw new Error(`Blank ${format} did not reopen`);
    await wd.frame(null);
  }
  // EPUB has no original blank command. Exercise existing-file open through the same menu.
  const path = join(work.cwd, "Existing.epub"); writeFileSync(path, await epubFixture());
  await wd.execute(`const original=window.fetch, target=window.__TAURI_INTERNALS__.convertFileSrc("plugin:dialog|open","ipc");window.__filePickerCalls=[];window.__filePickerChoice=arguments[0];window.fetch=(url,init)=>{if(String(url)===target){window.__filePickerCalls.push(JSON.parse(init.body));return Promise.resolve(new Response(JSON.stringify(window.__filePickerChoice),{headers:{"Content-Type":"application/json","Tauri-Response":"ok"}}));}return original(url,init);};`, path);
  await fileMenu(); await clickText('.office-file-menu [role="menuitem"]', "파일 열기…");
  const epubFrame = await wd.waitFor('iframe.office-frame[title*="Existing.epub"]', 30000); await wd.frame(epubFrame);
  await wd.frame(await wd.waitFor("iframe.epub-frame", 30000));
  const opened = await until(() => wd.execute<boolean>('return document.body.textContent.includes("First paragraph.");'), 30000);
  ctx.report.check(S, "EPUB: 공통 파일 열기에서 기존 책을 원본 편집기로 열기", opened, "OS 선택기 응답만 대역; 실제 EPUB 파일과 편집기", await shot(ctx, "new-open-epub.png"));
  await wd.frame(null);
  const picker = await wd.execute<unknown>('return window.__filePickerCalls');
  writeFileSync(ctx.report.path("new-open-picker.json"), JSON.stringify(picker, null, 2));
  const epub = (await snapshot()).artifacts.find((artifact) => artifact.workId === work.id && artifact.path === path);
  const revisions = epub ? await api<ArtifactRevision[]>("GET", `/api/artifacts/${epub.id}/revisions`) : [];
  ctx.report.check(S, "열기: 같은 작업공간·대화 등록과 XLSM 선택 필터", epub?.workspaceId === session.workspaceId && revisions[0]?.sessionId === session.id && JSON.stringify(picker).includes("xlsm"));
}
