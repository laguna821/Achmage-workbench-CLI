import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import JSZip from "jszip";
import type { Artifact, Session, SkillImportPreview, Snapshot, TranscriptItem, Work, WorkbenchSkill } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function deckParts(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes), parts: Record<string, string> = {};
  for (const path of Object.keys(zip.files).filter((name) => /^ppt\/(theme|slideMasters|slideLayouts)\//.test(name) && name.endsWith(".xml"))) parts[path] = digest(await zip.file(path)!.async("uint8array"));
  const text = (await Promise.all(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort().map((name) => zip.file(name)!.async("string")))).join("\n");
  return { parts, text };
}

export async function templateOfficeScenario(ctx: Ctx) {
  const S = "11 PPTX 양식", { api, wd } = ctx.app;
  const real = ctx.app.name === "real";
  const work = await api<Work>("POST", "/api/works", { title: "PPTX 양식 검사", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const original = join(ctx.stage.root, "Business Template.pptx");
  copyFileSync(resolve("vendor/ieumoffice/packages/pptx-engine/tests/fixtures/01_standard_business.pptx"), original);
  const before = readFileSync(original), originalHash = digest(before), originalParts = await deckParts(before);
  const imported = await api<SkillImportPreview>("POST", "/api/user-skills/register", { title: "Native Slide Form", description: "Synthetic business slide fixture", file: original, body: "Preserve the theme, master and slide layouts." });
  await api("POST", `/api/user-skills/imports/${imported.id}/install`, { selected: imported.candidates.map((item) => item.key) });
  const skill = (await api<WorkbenchSkill[]>("GET", `/api/user-skills?sessionId=${session.id}`)).find((item) => item.title === "Native Slide Form")!;
  await api("PUT", `/api/user-skills/${skill.id}/state`, { enabled: true, invoke: "manual" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const tab = { id: "office-template-chat", workId: work.id, sessionId: session.id, view: { kind: "work" as const } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "office-template-pane", panes: [{ ...tab, id: "office-template-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1800, height: 1200 }); await wd.refresh(); await installProbe(wd);
  const clickText = async (selector: string, text: string) => {
    const ready = await until(async () => {
      for (const element of await wd.findAll(selector)) if ((await wd.execute<string>('return arguments[0].textContent.trim();', element)).includes(text) && await wd.displayed(element) && !await wd.attribute(element, "disabled")) {
        await wd.execute('arguments[0].scrollIntoView({block:"center",inline:"nearest"});', element); await wd.click(element); return true;
      }
      return false;
    }, 15_000);
    if (!ready) throw new Error(`Missing command: ${text}`);
  };
  await wd.click(await wd.waitFor('.pane:not([hidden]) [aria-label="새 문서로 만들기"]'));
  await clickText('[role="menuitem"]', "내 양식·스킬에서 만들기");
  await wd.sendKeys(await wd.waitFor('[aria-label="양식·스킬 검색"]'), "Native Slide Form");
  await clickText('.skill-row', "Native Slide Form");
  await clickText('.skill-actions button', "양식 미리보기");
  const rendered = await until(async () => await wd.execute<boolean>('return Array.from(document.querySelectorAll(".skill-preview-page img")).some(image => image.naturalWidth > 0) || !!document.querySelector(".skill-preview .notice");'), 90_000, 300);
  const visible = await wd.execute<boolean>('return Array.from(document.querySelectorAll(".skill-preview-page img")).some(image => image.naturalWidth > 0);');
  const previewProblem = await wd.execute<string>('return document.querySelector(".skill-preview .notice")?.textContent || "";');
  ctx.report.check(S, "실제 PPTX 양식의 페이지를 앱 안에서 렌더링", rendered && visible, previewProblem || undefined, await shot(ctx, "11-pptx-template-preview.png"));
  if (!visible) throw new Error(`PPTX template preview failed: ${previewProblem}`);
  await clickText('.skill-preview button', "이 양식으로 새 문서");
  await wd.sendKeys(await wd.waitFor('.pane:not([hidden]) .composer-input'), real ? "Keep the prepared PPTX template copy exactly as supplied, without changing any bytes. Do not create another file or edit the source template. Reply ready; I will edit the copied slides myself next." : "Keep this slide template for editing.");
  await wd.click(await wd.waitFor('.pane:not([hidden]) [aria-label="보내기"]'));
  const messages = async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
  if (!await until(async () => (await snapshot()).artifacts.some((item) => item.workId === work.id && item.format === "pptx"), real ? 300_000 : 30_000)) throw new Error("PPTX copy was not tracked");
  const artifact = (await snapshot()).artifacts.find((item) => item.workId === work.id && item.format === "pptx") as Artifact;
  ctx.report.check(S, "PPTX 원본 전체 바이트와 테마·마스터를 새 사본에 보존", digest(readFileSync(artifact.path)) === originalHash && digest(readFileSync(original)) === originalHash);
  const frame = await wd.waitFor('.pane:not([hidden]) iframe.office-frame', real ? 300_000 : 30_000), frameRect = await wd.rect(frame);
  await wd.frame(frame); await installProbe(wd);
  const loaded = await until(async () => await wd.execute<boolean>('return !!window.Konva?.stages?.some(stage => stage.find("Text").some(node => node.text().trim().length > 4));'), 60_000, 300);
  ctx.report.check(S, "새 PPTX가 같은 세션의 실제 Slides 편집기로 열림", loaded, undefined, await shot(ctx, "11-pptx-editor-open.png"));
  if (!loaded) throw new Error(await wd.execute<string>('return document.body.innerText.slice(0, 1200);'));
  const point = await wd.execute<{ x: number; y: number; text: string }>('const stage = window.Konva.stages.reduce((a,b) => a.width() > b.width() ? a : b); const node = stage.find("Text").find(node => node.text().trim().length > 4); const rect = node.getClientRect(), box = stage.container().getBoundingClientRect(), scale = box.width / stage.width(); return {x: box.left + (rect.x + rect.width/2)*scale, y: box.top + (rect.y + rect.height/2)*scale, text: node.text()};');
  await wd.frame(null);
  await wd.pointer([{ type: "pointerMove", origin: "viewport", x: Math.round(frameRect.x + point.x), y: Math.round(frameRect.y + point.y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 80 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
  await wd.frame(frame);
  const edit = await wd.waitFor('[contenteditable="true"]');
  await wd.sendKeys(edit, " NATIVE SLIDE EDIT"); await wd.press(KEY.escape);
  await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "s" }, { type: "keyUp", value: "s" }, { type: "keyUp", value: KEY.control }]);
  await wd.frame(null);
  const saved = await until(async () => ((await snapshot()).artifacts.find((item) => item.id === artifact.id)?.revision ?? 0) > 1, 30_000);
  const latest = (await snapshot()).artifacts.find((item) => item.id === artifact.id)!;
  const after = await deckParts(readFileSync(artifact.path));
  copyFileSync(artifact.path, join(ctx.stage.outDir, "human-edited.pptx"));
  ctx.report.check(S, "사람의 실제 텍스트 입력·Ctrl+S가 새 PPTX 판으로 저장", saved && after.text.includes("NATIVE SLIDE EDIT"), undefined, await shot(ctx, "11-pptx-human-saved.png"));
  ctx.report.check(S, "입력 후에도 원본 및 미편집 테마·마스터·레이아웃 보존", digest(readFileSync(original)) === originalHash && JSON.stringify(after.parts) === JSON.stringify(originalParts.parts));
  if (!saved || !after.text.includes("NATIVE SLIDE EDIT")) throw new Error("PPTX edit was not saved");
  await wd.refresh(); await installProbe(wd);
  const reopened = await wd.waitFor('.pane:not([hidden]) iframe.office-frame', 30_000); await wd.frame(reopened); await installProbe(wd);
  // The parser renders a saved line as separate word/run nodes, unlike the live text editor.
  const kept = await until(async () => await wd.execute<boolean>('return window.Konva?.stages?.some(stage => stage.find("Text").map(node => node.text()).join("").includes("NATIVE SLIDE EDIT")) === true;'), 60_000);
  const reopenState = await wd.execute('return {body: document.body.innerText, texts: window.Konva?.stages?.map(stage => stage.find("Text").map(node => node.text())), url: location.pathname};');
  writeFileSync(join(ctx.stage.outDir, "reopen-state.json"), JSON.stringify(reopenState, null, 2));
  ctx.report.check(S, "PPTX 새 판 재열기에서 사람 입력 유지", kept, kept ? undefined : JSON.stringify(reopenState).slice(0, 1400), await shot(ctx, "11-pptx-reopened.png"));
  const frameErrors = await pageErrors(wd); await wd.frame(null);
  await clickText('.pane:not([hidden]) [aria-label="요청 종류"] button', "검토 요청");
  await wd.sendKeys(await wd.waitFor('.pane:not([hidden]) .composer-input'), "Review the saved slide edit.");
  await wd.click(await wd.waitFor('.pane:not([hidden]) [aria-label="보내기"]'));
  const followed = await until(async () => (await messages()).some((item) => item.kind === "user" && item.text === "Review the saved slide edit."), 30_000);
  const follow = (await messages()).find((item) => item.kind === "user" && item.text === "Review the saved slide edit.");
  ctx.report.check(S, "같은 세션의 후속 요청이 사람이 저장한 PPTX 판·해시를 받음", followed && follow?.kind === "user" && follow.refs?.some((ref) => ref.artifactId === artifact.id && ref.revision === latest.revision && ref.sha256 === latest.sha256) === true && (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 1);
  ctx.report.check(S, "PPTX 편집기와 상위 앱에서 페이지 예외 없음", !frameErrors.length && !(await pageErrors(wd)).length, frameErrors.join("\n") || undefined);
  if (!real) return;

  // An explicit real-engine run also proves Markdown reference -> PPTX proposal -> native apply.
  const idle = async () => {
    if (!await until(async () => {
      const pending = (await messages()).find((item) => item.kind === "approval" && item.decision === null);
      if (pending) throw new Error(`Real engine needs approval: ${JSON.stringify(pending)}`);
      const status = (await snapshot()).sessions.find((item) => item.id === session.id)?.status;
      if (status === "error") throw new Error("Real engine turn failed; see transcript");
      return status === "idle";
    }, 300_000, 1000)) throw new Error("Real engine did not finish within 5 minutes");
  };
  try {
    await idle();
    const briefPath = join(dirname(artifact.path), "Slide edit brief.md");
    const brief = "# Slide edit brief\n\nOn slide 1, replace the title with exactly APPROVED WORKBENCH REVIEW. Preserve the subtitle and every other slide, theme, master and layout.\n";
    writeFileSync(briefPath, brief);
    const source = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: briefPath });
    await clickText('.pane:not([hidden]) [aria-label="요청 종류"] button', "수정 요청");
    await wd.click(await wd.waitFor('.pane:not([hidden]) [aria-label="참조 문서 붙이기"]'));
    await clickText('.pane:not([hidden]) [role="menuitem"]', source.name);
    const prompt = "Edit the current PPTX using the attached Slide edit brief.md. Read the pinned brief, then use the provided ieumoffice CLI to apply only its requested title edit to the designated working copy. Keep all other slides and design parts. Do not edit the Markdown or the original template. Produce the actual PPTX proposal, not instructions.";
    await wd.sendKeys(await wd.waitFor('.pane:not([hidden]) .composer-input'), prompt);
    await wd.click(await wd.waitFor('.pane:not([hidden]) [aria-label="보내기"]'));
    if (!await until(async () => (await messages()).some((item) => item.kind === "user" && item.text === prompt), 30_000)) throw new Error("Real edit request was not delivered");
    await idle();
    const proposal = (await snapshot()).proposals.find((item) => item.artifactId === artifact.id && item.status === "pending");
    ctx.report.check(S, "실제 Codex가 읽기용 Markdown과 PPTX 작업 사본으로 수정안 생성", !!proposal && !proposal.problem && proposal.baseRevision === latest.revision, proposal?.problem ?? undefined);
    if (!proposal || proposal.problem) throw new Error("Real engine did not produce a usable PPTX proposal");
    ctx.report.check(S, "수정안 적용 전 사람의 저장본·참조 원문 보존", digest(readFileSync(artifact.path)) === latest.sha256 && readFileSync(briefPath, "utf8") === brief);
    await clickText('.pane:not([hidden]) .doc-proposal-actions button', "적용");
    if (!await until(async () => (await snapshot()).artifacts.find((item) => item.id === artifact.id)!.revision > latest.revision, 30_000)) throw new Error("PPTX proposal was not applied");
    const aiParts = await deckParts(readFileSync(artifact.path));
    ctx.report.check(S, "실제 수정안 적용 후 PPTX 제목 변경과 테마·원문 보존", aiParts.text.includes("APPROVED WORKBENCH REVIEW") && JSON.stringify(aiParts.parts) === JSON.stringify(originalParts.parts) && readFileSync(briefPath, "utf8") === brief && digest(readFileSync(original)) === originalHash, undefined, await shot(ctx, "11-pptx-real-proposal-applied.png"));
    await wd.frame(await wd.waitFor('.pane:not([hidden]) iframe.office-frame'));
    const changed = await until(async () => await wd.execute<boolean>('return window.Konva?.stages?.some(stage => stage.find("Text").map(node => node.text()).join("").replace(/\\s+/g, "").includes("APPROVEDWORKBENCHREVIEW")) === true;'), 60_000);
    const aiView = await wd.execute('return {body: document.body.innerText, texts: window.Konva?.stages?.map(stage => stage.find("Text").map(node => node.text()))};');
    writeFileSync(join(ctx.stage.outDir, "ai-editor-state.json"), JSON.stringify(aiView, null, 2));
    await wd.frame(null);
    ctx.report.check(S, "실제 AI 수정 결과가 같은 내부 편집 탭에 반영", changed, undefined, await shot(ctx, "11-pptx-real-editor-updated.png"));
    copyFileSync(artifact.path, join(ctx.stage.outDir, "ai-edited.pptx"));
  } finally {
    writeFileSync(join(ctx.stage.outDir, "real-engine-transcript.json"), JSON.stringify(await messages(), null, 2));
    writeFileSync(join(ctx.stage.outDir, "real-engine-session.json"), JSON.stringify((await snapshot()).sessions.find((item) => item.id === session.id), null, 2));
  }
}
