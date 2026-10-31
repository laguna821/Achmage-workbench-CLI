import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Artifact, ArtifactRevision, Session, Snapshot, Work } from "@workbench/contracts";
import { fixture, savedText } from "./office-suite.ts";
import { installProbe, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Real editor input and its original Save As, with actual gateway files. */
export async function officeCopiesScenario(ctx: Ctx) {
  const { wd, api } = ctx.app, S = "Office 현재 편집 사본";
  const formats = ["md", "html", "docx", "pptx", "xlsx", "xmind", "epub"] as const;
  const chosen = process.env.APP_E2E_OFFICE_COPY_FORMATS?.split(",") ?? [...formats];
  if (chosen.some((format) => !(formats as readonly string[]).includes(format))) throw new Error("Unknown copy format");
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const key = (value: string, shift = false) => wd.keys([{ type: "keyDown", value: KEY.control }, ...(shift ? [{ type: "keyDown" as const, value: KEY.shift }] : []), { type: "keyDown", value }, { type: "keyUp", value }, ...(shift ? [{ type: "keyUp" as const, value: KEY.shift }] : []), { type: "keyUp", value: KEY.control }]);
  const clickText = async (text: string) => {
    if (!await until(async () => {
      for (const button of await wd.findAll("button")) if (await wd.displayed(button) && (await wd.execute<string>("return arguments[0].textContent.trim()", button)) === text) { await wd.click(button); return true; }
      return false;
    }, 30000)) throw new Error(`Missing button ${text}`);
  };
  for (const format of formats.filter((format) => chosen.includes(format))) {
    const work = await api<Work>("POST", "/api/works", { title: `Copy ${format}`, cwd: null });
    const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude" });
    const source = join(work.cwd, `Original.${format}`), path = join(work.cwd, `Copy.${format}`), marker = `UNSAVED COPY ${format.toUpperCase()}`;
    if (format === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), source); else await fixture(source, format);
    const original = readFileSync(source), artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source });
    const tab = { id: "copy-tab", workId: work.id, sessionId: session.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: format === "md" || format === "html" ? "rich" : "edit" } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "copy-pane", panes: [{ ...tab, id: "copy-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
    const enter = async (copy = false) => { await wd.frame(null); await wd.frame(await wd.waitFor(`iframe.office-frame${copy ? '[title*="Copy."]' : ''}`, 30000)); };
    await enter(); await installProbe(wd);
    if (format === "html") await clickText("분할");
    if (format === "md" || format === "html" || format === "docx") {
      const editor = await wd.waitFor(format === "html" ? '.cm-content[contenteditable="true"]' : '.tiptap[contenteditable="true"]', 60000);
      await wd.click(editor); await wd.sendKeys(editor, marker);
    } else if (format === "pptx") {
      if (!await until(() => wd.execute<boolean>('return !!window.Konva?.stages?.some(stage => stage.find("Text").some(node => node.text().trim().length > 4));'), 60000)) throw new Error("Slides did not load");
      const point = await wd.execute<{ x: number; y: number }>('const stage = window.Konva.stages.reduce((a,b) => a.width() > b.width() ? a : b); const node = stage.find("Text").find(node => node.text().trim().length > 4); const r = node.getClientRect(), b = stage.container().getBoundingClientRect(), s = b.width / stage.width(); return {x:b.left+(r.x+r.width/2)*s,y:b.top+(r.y+r.height/2)*s};');
      await wd.frame(null); const frame = await wd.waitFor("iframe.office-frame"), box = await wd.rect(frame);
      await wd.pointer([{ type: "pointerMove", x: Math.round(box.x + point.x), y: Math.round(box.y + point.y), origin: "viewport" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 80 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      await wd.frame(frame); await wd.sendKeys(await wd.waitFor('.slide-text-editor[contenteditable="true"]'), marker + " SLIDE"); await wd.press(KEY.escape);
      const notes = await wd.waitFor(".notes-pane textarea"); await wd.click(notes); await wd.sendKeys(notes, marker + " NOTES");
    } else if (format === "xlsx") {
      if (!await until(() => wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");'), 45000)) throw new Error("Workbook did not load");
      await wd.execute('window.__copyFocus=[];const focus=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(...args){if(document.activeElement?.closest("[role=dialog]"))window.__copyFocus.push({from:document.activeElement.outerHTML,to:this.outerHTML,stack:new Error().stack});return focus.apply(this,args)}');
      await wd.click(await wd.waitFor('[aria-label="Go To"]')); const ref = await wd.waitFor('.format-cells-dialog input'); await wd.click(ref);
      if (!await until(() => wd.execute<boolean>('return document.activeElement === arguments[0]', ref), 5000)) throw new Error("Go To input did not receive focus");
      await wd.sendKeys(ref, "A1");
      writeFileSync(ctx.report.path("copy-xlsx-goto.json"), JSON.stringify(await wd.execute('return {value:arguments[0].value, active:document.activeElement?.outerHTML,focus:window.__copyFocus}', ref), null, 2));
      if (!await until(() => wd.execute<boolean>('return arguments[0].value === "A1"', ref), 5000)) throw new Error("Go To input did not keep A1");
      await wd.click(await wd.waitFor('.format-cells-dialog .primary-action'));
      if (!await until(() => wd.execute<boolean>('return !document.querySelector(".format-cells-dialog");'), 5000)) throw new Error("Go To did not select A1");
      // Univer's grid keyboard host is intentionally hidden: focus it as the
      // original grid does, then deliver real WebDriver key events to the cell.
      const editor = await wd.waitFor('#univer-container [contenteditable="true"]'); await wd.execute('arguments[0].focus()', editor); await wd.press("\uE032"); await key("a");
      await wd.keys([...marker].flatMap((value) => [{ type: "keyDown" as const, value }, { type: "keyUp" as const, value }])); await wd.press(KEY.enter);
    } else if (format === "xmind") {
      await wd.click(await wd.waitFor('.mm-sheet-host:not([hidden]) me-tpc[data-nodeid="meroot-1"]', 30000)); await wd.press("\uE032");
      const field = await wd.waitFor("#input-box"); await key("a"); await wd.press("\uE003"); await wd.sendKeys(field, marker); await wd.press(KEY.enter);
    } else {
      await wd.frame(await wd.waitFor("iframe.epub-frame", 30000));
      const field = await wd.waitFor('#p1[contenteditable="true"]', 15000); await wd.click(field); await key("a"); await wd.press("\uE003"); await wd.sendKeys(field, marker); await enter();
    }
    const saveAs = async () => {
      if (format === "epub") { await wd.click(await wd.waitFor('[data-action="file"]')); await wd.click(await wd.waitFor('[data-action="save-as"]')); }
      else await key("s", true);
      await wd.frame(null); await wd.waitFor(".office-output-dialog", 15000);
    };
    const choosePath = async (target: string) => {
      const input = await wd.waitFor('.office-output-dialog input[aria-label="저장할 파일 경로"]'); await wd.click(input); await key("a"); await wd.sendKeys(input, target);
      await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]'));
    };
    await saveAs();
    await enter();
    await key("s"); // A global shortcut must not bypass the input lock and write the original.
    ctx.report.check(S, `${format}: 위치 선택 중 편집 입력 잠금`, await wd.execute<boolean>('return !!document.querySelector(".workbench-copy-progress") && [...document.body.children].some(e=>e.inert);'));
    await wd.frame(null); await wd.click((await wd.findAll(".office-output-dialog footer button"))[0]!); await enter();
    const unlocked = await until(() => wd.execute<boolean>('return !document.querySelector(".workbench-copy-progress")'), 5000);
    ctx.report.check(S, `${format}: 취소는 원본 바이트·판 유지와 입력 복귀`, unlocked && hash(readFileSync(source)) === hash(original) && (await snapshot()).artifacts.find((a) => a.id === artifact.id)?.revision === 1);
    if (format === "md") {
      await saveAs(); await enter(); await wd.press(KEY.escape); await key("s", true); await wd.frame(null);
      const reopened = await until(() => wd.execute<boolean>('return !!document.querySelector(".office-output-dialog")'), 5000);
      if (!reopened) throw new Error("Immediate Save As after Escape did not reopen");
      await wd.click((await wd.findAll(".office-output-dialog footer button"))[0]!); await enter();
      if (!await until(() => wd.execute<boolean>('return !document.querySelector(".workbench-copy-progress")'), 5000)) throw new Error("Reopened save did not cancel");
      ctx.report.check(S, "md: Escape 취소 직후 새 위치 선택과 재취소", true);
      await saveAs();
      await wd.execute('const fetch=window.fetch;window.__copyFailed=false;window.fetch=async(...args)=>{if(/\\/outputs\\/[^/?]+\\?/.test(String(args[0]))){window.fetch=fetch;window.__copyFailed=true;return new Response(JSON.stringify({error:"copy-test-unavailable",message:"사본 저장 검사: 일시적인 연결 오류"}),{status:503,headers:{"content-type":"application/json"}})}return fetch(...args)}');
      await choosePath(join(work.cwd, "Failed.md"));
      if (!await until(() => wd.execute<boolean>('return window.__copyFailed === true'), 10000)) throw new Error("Copy failure was not injected");
      await enter();
      const restored = await until(() => wd.execute<boolean>('return !document.querySelector(".workbench-copy-progress") && document.querySelector(".tiptap")?.textContent.includes("UNSAVED COPY MD")'), 10000);
      ctx.report.check(S, "md: 저장 오류 뒤 미저장 입력 복귀·원본 불변·실패 사본 미등록", restored && hash(readFileSync(source)) === hash(original) && !(await snapshot()).artifacts.some((a) => a.path === join(work.cwd, "Failed.md")));
    }
    await saveAs();
    if (format === "md") await wd.execute('const fetch=window.fetch;window.__releaseCopy=null;window.fetch=async(...args)=>{if(/\\/outputs\\/[^/?]+\\?/.test(String(args[0]))){window.fetch=fetch;await new Promise(resolve=>window.__releaseCopy=resolve)}return fetch(...args)}');
    await choosePath(path);
    if (format === "md") {
      if (!await until(() => wd.execute<boolean>('return typeof window.__releaseCopy === "function"'), 10000)) throw new Error("Delayed copy was not reached");
      await enter(); await key("s"); await wd.press("x"); await wd.press("\uE004");
      ctx.report.check(S, "md: 지연된 저장 중 CtrlS·입력이 원본과 사본 스냅샷을 바꾸지 않음", await wd.execute<boolean>('return !!document.querySelector(".workbench-copy-progress") && document.querySelector(".tiptap")?.textContent.includes("UNSAVED COPY MD") && !document.querySelector(".tiptap")?.textContent.includes("MDx")') && hash(readFileSync(source)) === hash(original));
      await wd.frame(null); await wd.execute('window.__releaseCopy()');
    }
    const made = await until(async () => (await snapshot()).artifacts.some((a) => a.path === path), 45000);
    if (!made) throw new Error(`${format} copy was not created`);
    const copy = (await snapshot()).artifacts.find((a) => a.path === path)!;
    const text = await savedText(path, format);
    ctx.report.check(S, `${format}: 원본 미저장 편집을 사본에 저장하고 원본 불변`, text.includes(marker) && (format !== "pptx" || text.includes(marker + " SLIDE") && text.includes(marker + " NOTES")) && hash(readFileSync(source)) === hash(original), text.slice(0, 200));
    await enter(true);
    // A tab title and toolbar can appear before the document has actually loaded.
    // Wait for the original renderer's content, not its loading screen.
    if (format === "html") await clickText("분할");
    const opened = await until(() => wd.execute<boolean>(`
      if (document.querySelector(".workbench-copy-progress")) return false;
      const format=arguments[0], marker=arguments[1];
      if (format==="md" || format==="docx") return !!document.querySelector(".tiptap")?.textContent.includes(marker);
      if (format==="html") return !!document.querySelector(".cm-content")?.textContent.includes(marker);
      if (format==="pptx") return !!window.Konva?.stages?.some(stage=>stage.find("Text").map(node=>node.text()).join("").includes(marker+" SLIDE")) && !!document.querySelector(".notes-pane textarea")?.value.includes(marker+" NOTES");
      if (format==="xlsx") return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");
      if (format==="xmind") return !!document.querySelector('.mm-sheet-host:not([hidden]) me-tpc[data-nodeid="meroot-1"]')?.textContent.includes(marker);
      return !!document.querySelector("iframe.epub-frame")?.contentDocument?.querySelector("#p1")?.textContent.includes(marker);
    `, format, marker), 60000);
    if (format === "pptx") writeFileSync(ctx.report.path("copy-pptx-rendered.json"), JSON.stringify(await wd.execute('return {stages:window.Konva?.stages?.map(stage=>stage.find("Text").map(node=>node.text())),notes:document.querySelector(".notes-pane textarea")?.value}'), null, 2));
    await wd.frame(null);
    const revisions = await api<ArtifactRevision[]>("GET", `/api/artifacts/${copy.id}/revisions`);
    ctx.report.check(S, `${format}: 사본을 같은 대화에서 열고 원본 판 출처 보존`, opened && copy.workspaceId === artifact.workspaceId && revisions[0]?.sessionId === session.id && revisions[0]?.derivedFrom?.some((r) => r.artifactId === artifact.id && r.revision === 1) === true, undefined, await shot(ctx, `copy-${format}.png`));
    if (!opened) throw new Error(`${format} copy renderer did not load its saved content`);
    copyFileSync(path, ctx.report.path(`copy-${format}.${format}`)); writeFileSync(ctx.report.path(`copy-${format}-revisions.json`), JSON.stringify(revisions, null, 2));
  }
}
