import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** Original Ieum renderers inside the real Tauri app; the stage has no Electron installation. */
export async function textOfficeScenario(ctx: Ctx) {
  const S = "26 Markdown·HTML 편집기", { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "이음 원문 편집 검사", cwd: null });
  const sources = {
    markdown: '\ufeff# Original heading\r\n\r\nOriginal paragraph.\r\n\r\n[link][ref]\r\n\r\n[ref]: https://example.com\r\n\r\n[^1]: Keep this footnote\r\n\r\n<div data-keep="yes">Raw HTML stays</div>\r\n',
    html: '<!doctype html>\r\n<html><head><title>Original page</title></head><body><h1>Original HTML</h1><p data-keep="yes">Keep exact spacing.</p></body></html>\r\n',
  };
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const saveKey = () => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "s" }, { type: "keyUp", value: "s" }, { type: "keyUp", value: KEY.control }]);
  const clickLabel = async (selector: string, text: string) => {
    if (!await until(async () => {
      for (const button of await wd.findAll(selector)) if ((await wd.execute<string>("return arguments[0].textContent.trim();", button)) === text && await wd.displayed(button)) { await wd.click(button); return true; }
      return false;
    }, 15_000)) throw new Error(`Missing visible command: ${text}`);
  };
  for (const kind of ["markdown", "html"] as const) {
    const file = join(work.cwd, kind === "markdown" ? "원문 보존.md" : "화면 편집.html");
    writeFileSync(file, sources[kind]);
    const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
    const tab = { id: `text-${kind}`, workId: work.id, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "rich" } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "text-pane", panes: [{ ...tab, id: "text-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
    const frame = await wd.waitFor('iframe.office-frame', 30_000);
    await wd.frame(frame); await installProbe(wd);
    if (kind === "html") await clickLabel("button", "분할");
    const selector = kind === "markdown" ? '.tiptap[contenteditable="true"]' : '.cm-content[contenteditable="true"]';
    const editor = await wd.waitFor(selector, 60_000);
    ctx.report.check(S, `${kind}: 원본 이음 편집기를 Electron 없이 열기`, !!editor, undefined, await shot(ctx, `26-${kind}-open.png`));
    await wd.execute('const api = window.markdownApi || window.htmlApi; const original = api.save; api.save = async (...args) => { const result = await original(...args); window.__textSave = {source: args[0].text, result}; return result; };');
    await saveKey();
    // A no-op save must preserve BOM/CRLF/reference definitions/raw HTML, not just visible prose.
    const unchanged = await until(async () => await wd.execute<boolean>('return !!window.__textSave?.result.ok;'), 10_000) && readFileSync(file, "utf8") === sources[kind];
    ctx.report.check(S, `${kind}: 변경 없는 저장이 원문 바이트를 보존`, unchanged);
    await wd.click(kind === "markdown" ? await wd.waitFor(".tiptap h1") : editor);
    if (kind === "html") await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "" }, { type: "keyUp", value: "" }, { type: "keyUp", value: KEY.control }]);
    const marker = kind === "markdown" ? " NATIVE MARKDOWN EDIT" : "<!--NATIVE HTML EDIT-->";
    await wd.sendKeys(editor, marker); await saveKey();
    const saved = await until(async () => readFileSync(file, "utf8").includes(marker), 20_000);
    ctx.report.check(S, `${kind}: 실제 입력·Ctrl+S를 새 판으로 저장`, saved, undefined, await shot(ctx, `26-${kind}-edited.png`));
    if (!saved) throw new Error(`${kind} input was not persisted: ${await wd.execute<string>('return document.body.innerText.slice(0, 1600);')}`);
    const result = readFileSync(file, "utf8");
    const preserved = kind === "markdown" ? result.includes('[ref]: https://example.com\r\n') && result.includes('[^1]: Keep this footnote\r\n') && result.includes('<div data-keep="yes">Raw HTML stays</div>') : result.includes('<p data-keep="yes">Keep exact spacing.</p>');
    ctx.report.check(S, `${kind}: 편집하지 않은 원문 구간 보존`, preserved);
    const errors = await pageErrors(wd);
    if (kind === "html") {
      const preview = await wd.waitFor("iframe.preview-frame", 15_000);
      await wd.frame(preview);
      const rendered = await until(async () => await wd.execute<boolean>('return document.body.textContent.includes("Original HTML");'), 15_000);
      const isolated = await wd.execute<boolean>('try { return !parent.htmlApi; } catch { return true; }');
      ctx.report.check(S, "HTML 실제 미리보기·편집기 권한 격리", rendered && isolated);
    }
    await wd.frame(null);
    await clickLabel('.doc-header [role="radio"]', kind === "markdown" ? "원문" : "원문");
    const source = await wd.waitFor('.document-view .cm-content', 10_000);
    ctx.report.check(S, `${kind}: 원문 보기 전환에 최신 저장 판 반영`, await until(async () => await wd.execute<boolean>('return arguments[0].textContent.includes(arguments[1]);', source, marker)));
    await clickLabel('.doc-header [role="radio"]', "편집");
    await wd.frame(await wd.waitFor("iframe.office-frame", 15_000));
    ctx.report.check(S, `${kind}: 편집기 재열기`, await until(async () => await wd.execute<boolean>('return document.body.textContent.includes(arguments[0]);', marker), 20_000));
    // A conflicting disk update must survive; this editor's unsaved source survives a reload.
    if (kind === "html") await clickLabel("button", "분할");
    const reopenedEditor = await wd.waitFor(selector, 15_000);
    await wd.click(kind === "markdown" ? await wd.waitFor(".tiptap h1") : reopenedEditor);
    const recoveryMarker = kind === "markdown" ? " RECOVERED MARKDOWN DRAFT" : "<!--RECOVERED HTML DRAFT-->";
    await wd.sendKeys(reopenedEditor, recoveryMarker);
    const external = kind === "markdown" ? "# EXTERNAL REVISION\n" : "<html><body>EXTERNAL REVISION</body></html>";
    writeFileSync(file, external);
    await api("POST", `/api/artifacts/${artifact.id}/adopt-disk`);
    await saveKey(); await wd.frame(null);
    await wd.waitFor(".doc-conflict", 15_000);
    ctx.report.check(S, `${kind}: 충돌 저장 거절·외부 판 보존`, readFileSync(file, "utf8") === external);
    await wd.refresh(); await installProbe(wd);
    await wd.frame(await wd.waitFor("iframe.office-frame", 15_000));
    const recovered = await until(async () => await wd.execute<boolean>('return document.body.textContent.includes(arguments[0]);', recoveryMarker), 20_000);
    ctx.report.check(S, `${kind}: 새로고침 뒤 저장하지 못한 원문 복구`, recovered && readFileSync(file, "utf8") === external);
    await wd.frame(null);
    await clickLabel(".doc-conflict button", "내 편집을 새 판으로");
    ctx.report.check(S, `${kind}: 명시적 충돌 해결을 새 판으로 저장`, await until(async () => readFileSync(file, "utf8").includes(recoveryMarker), 15_000));
    await wd.frame(await wd.waitFor("iframe.office-frame"));
    const reopenedErrors = await pageErrors(wd); await wd.frame(null);
    ctx.report.check(S, `${kind}: 편집기·상위 앱 예외 없음`, !errors.length && !reopenedErrors.length && !(await pageErrors(wd)).length, [...errors, ...reopenedErrors].join("\n") || undefined);
  }
}
