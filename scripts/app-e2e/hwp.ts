import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import init, { HwpDocument } from "../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { hwpMemosOf, hwpToText } from "../../third_party/ieumoffice/file-parse/hwp.ts";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function hwpScenario(ctx: Ctx) {
  const S = "12 한글 내부 편집", { wd, api } = ctx.app;
  await init({ module_or_path: readFileSync(resolve("vendor/ieumoffice/vendor/rhwp-core/rhwp_bg.wasm")) });
  const work = await api<Work>("POST", "/api/works", { title: "한글 내부 편집 검사", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  for (const format of ["hwpx", "hwp"] as const) {
    const doc = HwpDocument.createEmpty(); doc.createBlankDocument();
    doc.insertText(0, 0, 0, "한글 본문과 검토 메모를 보존합니다.");
    doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: "검토자", text: "원본 메모를 보존" }));
    const original = Buffer.from(format === "hwpx" ? doc.exportHwpx() : doc.exportHwp()); doc.free();
    const path = join(work.cwd, `Native Hangul.${format}`); writeFileSync(path, original);
    const originalPath = join(ctx.stage.outDir, `original.${format}`); writeFileSync(originalPath, original);
    const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
    const tab = { id: `hwp-${format}`, workId: work.id, sessionId: session.id, view: { kind: "document" as const, artifactId: artifact.id, proposalId: null } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "hangul", panes: [{ ...tab, id: "hangul", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.setWindowRect({ width: 1600, height: 1100 }); await wd.refresh(); await installProbe(wd);
    const outer = await wd.waitFor('.pane:not([hidden]) iframe.office-frame', 30_000), outerRect = await wd.rect(outer);
    await wd.frame(outer); await installProbe(wd);
    const loaded = await until(async () => !!await wd.find('.hwp-app[data-phase="ready"]'), 60_000);
    const initial = await wd.execute('return {text:document.body.innerText, frames:Array.from(document.querySelectorAll("iframe")).map(f=>({src:f.src,html:f.contentDocument?.body.innerHTML.slice(0,16000)}))};');
    writeFileSync(join(ctx.stage.outDir, `${format}-initial.json`), JSON.stringify(initial, null, 2));
    ctx.report.check(S, `${format.toUpperCase()}가 Electron 없이 실제 Ieum 한글 화면에 열림`, loaded, loaded ? undefined : JSON.stringify(initial).slice(0, 1200), await shot(ctx, `12-${format}-open.png`));
    if (!loaded) throw new Error(`${format} editor did not become ready`);
    const inner = await wd.waitFor('.hwp-editor-host iframe'), innerRect = await wd.rect(inner);
    await wd.frame(inner); await installProbe(wd);
    const canvas = await wd.waitFor('.document-page-canvas', 30_000), rect = await wd.rect(canvas);
    // Click the actual page, then use the editor's own Ctrl+Home and trusted key input.
    await wd.frame(null);
    await wd.pointer([{ type: "pointerMove", x: Math.round(outerRect.x + innerRect.x + rect.x + rect.width * .2), y: Math.round(outerRect.y + innerRect.y + rect.y + Math.min(160, rect.height * .18)), duration: 80 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    await wd.frame(outer); await wd.frame(inner);
    const active = await wd.execute<string>('return document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName || "";');
    ctx.report.check(S, `${format.toUpperCase()} 실제 쪽 클릭으로 편집 입력에 초점`, active === "문서 편집 입력", active);
    await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "" }, { type: "keyUp", value: "" }, { type: "keyUp", value: KEY.control }]);
    const marker = `NATIVE ${format.toUpperCase()} EDIT `;
    await wd.keys([...marker].flatMap((value) => [{ type: "keyDown" as const, value }, { type: "keyUp" as const, value }]));
    await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "s" }, { type: "keyUp", value: "s" }, { type: "keyUp", value: KEY.control }]);
    const studioErrors = await pageErrors(wd); await wd.frame(null); await wd.frame(outer);
    const saved = await until(async () => ((await snapshot()).artifacts.find((item) => item.id === artifact.id)?.revision ?? 0) > 1, 30_000);
    const finalState = await wd.execute('return {text:document.body.innerText,phase:document.querySelector(".hwp-app")?.dataset.phase};');
    writeFileSync(join(ctx.stage.outDir, `${format}-save-state.json`), JSON.stringify(finalState, null, 2));
    const bytes = readFileSync(path), text = await hwpToText(bytes), notes = await hwpMemosOf(bytes);
    copyFileSync(path, join(ctx.stage.outDir, `edited.${format}`));
    ctx.report.check(S, `${format.toUpperCase()} 실제 키 입력·Ctrl+S가 새 판에 저장`, saved && text.includes(marker.trim()), JSON.stringify(finalState).slice(0, 1200), await shot(ctx, `12-${format}-saved.png`));
    ctx.report.check(S, `${format.toUpperCase()} 한글 본문·검토 메모·원본 전체 바이트 보존`, text.includes("한글 본문과 검토 메모를 보존합니다.") && notes.some((memo) => memo.text === "원본 메모를 보존" && memo.author === "검토자") && hash(readFileSync(originalPath)) === hash(original));
    const errors = [...studioErrors, ...await pageErrors(wd)]; await wd.frame(null);
    if (!saved || !text.includes(marker.trim())) throw new Error(`${format} native input did not reach the saved file`);
    await wd.refresh(); await installProbe(wd); await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame', 30_000));
    const reopened = await until(async () => !!await wd.find('.hwp-app[data-phase="ready"]'), 60_000);
    ctx.report.check(S, `${format.toUpperCase()} 저장한 판 재열기와 바이트 유지`, reopened && hash(readFileSync(path)) === hash(bytes), undefined, await shot(ctx, `12-${format}-reopened.png`));
    ctx.report.check(S, `${format.toUpperCase()} 편집 화면에서 페이지 예외 없음`, !errors.length && !(await pageErrors(wd)).length, errors.join("\n") || undefined);
    await wd.frame(null);
  }
}
