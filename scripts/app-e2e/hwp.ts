import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import init, { HwpDocument } from "../../vendor/ieumoffice/vendor/rhwp-core/rhwp.js";
import { hwpMemosOf, hwpToText } from "../../third_party/ieumoffice/file-parse/hwp.ts";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { Kordoc } from "../../apps/host/src/kordoc.ts";
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
    if (format === "hwpx") {
      // A v0.22 draft is kept as Markdown. Upgrade must expose it, leave the binary editor
      // untouched, and require an explicit user action before applying its old patch.
      const beforeLegacy = (await snapshot()).artifacts.find((item) => item.id === artifact.id)!;
      const legacy = (await new Kordoc().read(path)).replace("보존합니다.", "보존합니다. LEGACY RECOVERED");
      const key = `workbench.docDraft.${artifact.id}.older-version`;
      await wd.execute('localStorage.setItem(arguments[0], JSON.stringify(arguments[1]));', key, { baseRevision: beforeLegacy.revision, text: legacy, at: Date.now() });
      await wd.refresh(); await installProbe(wd);
      const banner = await wd.waitFor('.pane:not([hidden]) .doc-legacy-draft', 30_000);
      ctx.report.check(S, "이전 글 편집 복구본을 원본 자동 변경 없이 안내", !!banner && hash(readFileSync(path)) === beforeLegacy.sha256, undefined, await shot(ctx, "12-legacy-draft-offered.png"));
      const buttons = await wd.findAll('.doc-legacy-draft button');
      await wd.click(buttons[0]!);
      ctx.report.check(S, "이전 복구본을 비교 화면에서 검토", await until(async () => await wd.execute<boolean>('return document.body.innerText.includes("LEGACY RECOVERED") && document.body.innerText.includes("이전 글 편집 복구본");')), undefined, await shot(ctx, "12-legacy-draft-review.png"));
      await wd.click(await wd.waitFor('.doc-legacy-draft button:last-of-type:not(:disabled)'));
      const recovered = await until(async () => (await snapshot()).artifacts.find((item) => item.id === artifact.id)!.revision > beforeLegacy.revision && await wd.execute<boolean>('return localStorage.getItem(arguments[0]) === null;', key) && !await wd.find('.doc-legacy-draft'), 30_000);
      ctx.report.check(S, "명시적 복구 후 새 HWPX 판 저장·복구 항목만 정리", recovered && (await hwpToText(readFileSync(path))).includes("LEGACY RECOVERED") && (await hwpMemosOf(readFileSync(path))).some((memo) => memo.text === "원본 메모를 보존"));
      if (!recovered) throw new Error("Legacy HWPX recovery did not save");
      await wd.waitFor(`.pane:not([hidden]) iframe.office-frame[data-revision="${beforeLegacy.revision + 1}"]`, 60_000);
    }
    if (ctx.app.name === "real" && format === "hwpx") {
      const beforeAi = (await snapshot()).artifacts.find((item) => item.id === artifact.id)!;
      const prompt = "Use workbench-hwp catalog/read/apply to edit the current HWPX working copy. Replace only the exact text '보존합니다.' with '안전하게 보존합니다.'. Preserve the NATIVE HWPX EDIT prefix, LEGACY RECOVERED suffix, every memo, and all formatting. Produce the actual HWPX proposal and do not modify the original file.";
      await wd.sendKeys(await wd.waitFor('.pane:not([hidden]) .composer-input'), prompt);
      await wd.click(await wd.waitFor('.pane:not([hidden]) [aria-label="보내기"]'));
      const messages = async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
      const done = await until(async () => {
        const items = await messages();
        if (items.some((item) => item.kind === "approval" && item.decision === null)) return false;
        return items.some((item) => item.kind === "user" && item.text === prompt) && (await snapshot()).sessions.find((item) => item.id === session.id)?.status === "idle";
      }, 300_000, 1000);
      writeFileSync(join(ctx.stage.outDir, "hwp-real-transcript.json"), JSON.stringify(await messages(), null, 2));
      const proposal = (await snapshot()).proposals.find((item) => item.artifactId === artifact.id && item.status === "pending");
      ctx.report.check(S, "실제 Codex가 사람의 저장 판을 읽고 HWPX 수정안 생성", done && !!proposal && !proposal.problem && proposal.baseRevision === beforeAi.revision, proposal?.problem ?? undefined);
      if (!done || !proposal || proposal.problem) throw new Error("Real HWPX proposal was not produced; see transcript");
      ctx.report.check(S, "한글 수정안 검토 전 원본 판 유지", hash(readFileSync(path)) === beforeAi.sha256);
      let applied = false;
      for (const button of await wd.findAll('.doc-proposal-actions button')) if ((await wd.execute<string>('return arguments[0].textContent.trim();', button)) === "적용") { await wd.click(button); applied = true; break; }
      if (!applied) throw new Error("HWPX apply button was not found");
      await until(async () => (await snapshot()).artifacts.find((item) => item.id === artifact.id)!.revision > beforeAi.revision, 30_000);
      const changed = await hwpToText(readFileSync(path));
      ctx.report.check(S, "실제 한글 수정안 UI 적용과 메모·이전 입력 보존", changed.includes("안전하게 보존합니다.") && changed.includes("NATIVE HWPX EDIT") && changed.includes("LEGACY RECOVERED") && (await hwpMemosOf(readFileSync(path))).some((memo) => memo.text === "원본 메모를 보존"));
      await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame'));
      const updated = await until(async () => !!await wd.find('.hwp-app[data-phase="ready"]'), 60_000);
      ctx.report.check(S, "적용한 한글 판이 같은 세션의 내부 편집기로 갱신", updated && (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 1, undefined, await shot(ctx, "12-real-hwpx-applied.png"));
      copyFileSync(path, join(ctx.stage.outDir, "ai-edited.hwpx"));
      writeFileSync(join(ctx.stage.outDir, "hwp-real-session.json"), JSON.stringify((await snapshot()).sessions.find((item) => item.id === session.id), null, 2));
      await wd.frame(null);
    }
    if (format === "hwpx") {
      const beforeOutput = readFileSync(path);
      const menu = async (command: string) => {
        await wd.frame(null); await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame', 30_000));
        await until(async () => !!await wd.find('.hwp-app[data-phase="ready"]'), 60_000);
        await wd.frame(await wd.waitFor('.hwp-editor-host iframe'));
        await wd.click(await wd.waitFor('[data-menu="file"] .menu-title'));
        await wd.click(await wd.waitFor(`[data-cmd="ext:ieum-${command}"]`));
        await wd.frame(null);
      };
      const enterPath = async (value: string) => {
        const input = await wd.waitFor('.office-output-dialog input[aria-label="저장할 파일 경로"]');
        await wd.click(input);
        await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
        await wd.sendKeys(input, value);
      };
      await menu("save-as"); await wd.waitFor('.office-output-dialog');
      const cancel = (await wd.findAll('.office-output-dialog footer button'))[0]!; await wd.click(cancel);
      ctx.report.check(S, "다른 이름 저장 취소가 원본 판을 유지", !await wd.find('.office-output-dialog') && hash(readFileSync(path)) === hash(beforeOutput));
      await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame'));
      await wd.frame(await wd.waitFor('.hwp-editor-host iframe'));
      await wd.click(await wd.waitFor('.document-page-canvas'));
      await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "" }, { type: "keyUp", value: "" }, { type: "keyUp", value: KEY.control }]);
      await wd.keys([..."UNSAVED COPY "].flatMap((value) => [{ type: "keyDown" as const, value }, { type: "keyUp" as const, value }]));
      await wd.frame(null);
      // Actual upstream File → Export as PDF, with current page SVG and Rust native conversion.
      await menu("export-pdf");
      const pdfPath = join(work.cwd, "Native output.pdf"); await enterPath(pdfPath);
      await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]'));
      const madePdf = await until(async () => existsSync(pdfPath), 60_000);
      let pdfText = "", info = "";
      if (madePdf) {
        copyFileSync(pdfPath, join(ctx.stage.outDir, "native-output.pdf"));
        pdfText = execFileSync("pdftotext", [pdfPath, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
        info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
        writeFileSync(join(ctx.stage.outDir, "native-output.txt"), pdfText);
        writeFileSync(join(ctx.stage.outDir, "native-output-info.txt"), info);
      }
      ctx.report.check(S, "실제 파일 메뉴의 Rust PDF 출력·미저장 입력·한글 검색·A4 용지", madePdf && /Pages:\s+1/.test(info) && info.includes("(A4)") && pdfText.includes("한글") && pdfText.includes("NATIVE") && pdfText.includes("UNSAVED COPY") && pdfText.includes("LEGACY RECOVERED"), `${info}\n${pdfText}`.slice(0, 1200), await shot(ctx, "12-pdf-output.png"));
      if (!madePdf) throw new Error("Native PDF output was not saved");
      ctx.report.check(S, "PDF 출력은 원본 바이트와 편집 판을 바꾸지 않음", hash(readFileSync(path)) === hash(beforeOutput));
      await menu("save-as");
      const copyPath = join(work.cwd, "Native copy.hwpx"); await enterPath(copyPath);
      await wd.click(await wd.waitFor('.office-output-dialog button[type="submit"]'));
      const copied = await until(async () => (await snapshot()).artifacts.some((item) => item.path === copyPath), 60_000);
      ctx.report.check(S, "실제 다른 이름 저장으로 새 내부 문서 생성", copied && hash(readFileSync(path)) === hash(beforeOutput));
      if (!copied) throw new Error("Native Save As did not create the copy");
      const copy = (await snapshot()).artifacts.find((item) => item.path === copyPath)!;
      const openedCopy = await until(async () => await wd.execute<boolean>('return Array.from(document.querySelectorAll(".pane:not([hidden]) iframe.office-frame")).some(f=>f.title.includes("Native copy.hwpx"));'), 30_000);
      let readyCopy = false;
      if (openedCopy) {
        await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame[title*="Native copy.hwpx"]'));
        readyCopy = await until(async () => !!await wd.find('.hwp-app[data-phase="ready"]'), 60_000);
      }
      const copiedText = await hwpToText(readFileSync(copy.path));
      ctx.report.check(S, "저장 사본이 같은 세션에서 열리고 미저장 입력·본문·메모 보존", readyCopy && copiedText.includes("UNSAVED COPY") && copiedText.includes("LEGACY RECOVERED") && (await hwpMemosOf(readFileSync(copy.path))).some((memo) => memo.text === "원본 메모를 보존") && (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 1, undefined, await shot(ctx, "12-save-as-copy.png"));
      await wd.frame(null);
      copyFileSync(copy.path, join(ctx.stage.outDir, "native-copy.hwpx"));
    }
  }
  const originalWindow = (await wd.windowHandles())[0]!;
  await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame'));
  await wd.frame(await wd.waitFor('.hwp-editor-host iframe'));
  await wd.click(await wd.waitFor('[data-menu="file"] .menu-title'));
  await wd.click(await wd.waitFor('[data-cmd="ext:ieum-print"]'));
  await wd.frame(null);
  const printing = await until(async () => (await wd.windowHandles()).length > 1, 30_000);
  ctx.report.check(S, "실제 인쇄 메뉴가 별도 네이티브 인쇄 창을 엶", printing);
  if (!printing) throw new Error("Native print window did not open");
  const printWindow = (await wd.windowHandles()).find((handle) => handle !== originalWindow)!;
  const dialogRecord = join(ctx.stage.outDir, "native-print-dialog.txt");
  const dialogSeen = await until(async () => existsSync(dialogRecord), 30_000);
  ctx.report.check(S, "실제 GTK 인쇄 대화상자를 캡처하고 취소", dialogSeen && readFileSync(dialogRecord, "utf8").includes("type=GtkPrintUnixDialog") && readFileSync(dialogRecord, "utf8").includes("response=cancel"), dialogSeen ? readFileSync(dialogRecord, "utf8") : undefined, join(ctx.stage.outDir, "native-print-dialog.png"));
  if (!dialogSeen) throw new Error("GTK print dialog was not observed by the native harness");
  await wd.switchWindow(printWindow);
  await wd.waitFor('.page svg', 30_000);
  ctx.report.check(S, "인쇄 미리보기의 현재 쪽과 정적 벡터 출력", await wd.execute<boolean>('return document.querySelectorAll(".page").length === 1 && document.querySelectorAll("svg path").length > 0 && !document.querySelector("script,foreignObject,iframe");'), await wd.url(), await shot(ctx, "12-native-print.png"));
  await wd.closeWindow(); await wd.switchWindow(originalWindow);
}
