import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignDraft, DocumentPresence, Session, Snapshot, Work, Workspace } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** Actual doory/UI/host and Tauri, with only the model and one export-response delay simulated. */
export async function designScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "Doory 문서 흐름";
  let wd = ctx.app.wd;
  const api: typeof ctx.app.api = (...args) => ctx.app.api(...args);
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const clickLabel = async (selector: string, text: string, starts = false) => {
    if (!await until(async () => {
      for (const element of await wd.findAll(selector)) {
        const label = await wd.execute<string>("return arguments[0].textContent.trim();", element);
        if ((starts ? label.includes(text) : label === text) && await wd.displayed(element)) { await wd.click(element); return true; }
      }
      return false;
    }, 15_000)) throw new Error(`Missing doory command: ${text}; ${await wd.execute('return document.body.innerText.slice(0,1500);')}`);
  };
  const work = await api<Work>("POST", "/api/works", { title: "디자인 기본 흐름", cwd: null });
  const other = join(ctx.stage.root, "design-workspace"); mkdirSync(other);
  const workspace = await api<Workspace>("POST", `/api/works/${work.id}/workspaces`, { cwd: other, label: "디자인 작업공간" });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", workspaceId: workspace.id });
  const open = async (artifactId?: string) => {
    const tab = { id: "design-tab", workId: work.id, workspaceId: workspace.id, sessionId: session.id, view: artifactId ? { kind: "document", artifactId, proposalId: null } : { kind: "work" } };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "design-pane", panes: [{ ...tab, id: "design-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
    await wd.refresh(); await installProbe(wd);
  };
  const enter = async (revision?: number) => {
    if (!await until(async () => {
      await wd.frame(null);
      const frame = await wd.find(".pane:not([hidden]) iframe.design-frame");
      if (!frame) return false;
      await wd.frame(frame);
      return wd.execute<boolean>('return !!document.querySelector("canvas, [aria-label=\\"디자인 편집 복구\\"]") && (arguments[0] === null || document.querySelector(".wb-design-rev")?.textContent.trim() === "r" + arguments[0]);', revision ?? null);
    }, 30_000)) throw new Error(`Design frame not ready at revision ${revision ?? "current"}`);
    await installProbe(wd);
  };
  const saveKey = () => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "s" }, { type: "keyUp", value: "s" }, { type: "keyUp", value: KEY.control }]);
  await open(); await wd.setWindowRect({ width: 1800, height: 1100 });
  await clickLabel(".work-view button", "문서", true);
  await clickLabel('[role="menuitem"]', "정사각 (SNS)", true);
  await enter(); await wd.waitFor("canvas", 30_000);
  const design = (await snapshot()).artifacts.find((entry) => entry.workId === work.id && entry.format === "design")!;
  ctx.report.check(S, "실제 새 디자인 메뉴·작업공간·기본 캔버스", !!design && design.workspaceId === workspace.id && design.path.startsWith(other), undefined, await shot(ctx, "design-new.png"));
  await clickLabel("button", "글자"); await clickLabel("button", "제목 추가", true);
  // Send immediately through the real parent composer: it must await the editor's exact flush ack.
  await wd.frame(null);
  const composer = await wd.waitFor(".doc-composer textarea"); await wd.click(composer); await wd.sendKeys(composer, "제목 고쳐");
  await wd.keys([{ type: "keyDown", value: KEY.enter }, { type: "keyUp", value: KEY.enter }]);
  const proposed = await until(async () => (await snapshot()).proposals.some((entry) => entry.artifactId === design.id && entry.status === "pending"), 30_000);
  const proposal = (await snapshot()).proposals.find((entry) => entry.artifactId === design.id && entry.status === "pending");
  const change = proposal ? await api<{ base: string; proposed: string }>("GET", `/api/proposals/${proposal.id}`) : null;
  ctx.report.check(S, "사람 편집 저장 확인 후 같은 대화에 최신 판을 전달", proposed && proposal?.sessionId === session.id && proposal.baseRevision > 1 && !!JSON.parse(change!.base).pages[0].objects.length && change!.proposed.includes("NATIVE DESIGN AI"));
  ctx.report.check(S, "수정안은 원본을 먼저 덮지 않음", !readFileSync(design.path, "utf8").includes("NATIVE DESIGN AI"));
  await clickLabel(".doc-proposal button", "적용");
  if (!await until(async () => readFileSync(design.path, "utf8").includes("NATIVE DESIGN AI"), 15_000)) throw new Error("Design proposal was not applied");
  let latest = (await snapshot()).artifacts.find((entry) => entry.id === design.id)!;
  await enter(latest.revision); await wd.waitFor("canvas");
  ctx.report.check(S, "명시적 수정안 적용·원본 편집기 재열기", latest.revision === proposal!.baseRevision + 1, undefined, await shot(ctx, "design-applied.png"));
  await clickLabel("button", "도형"); await wd.click(await wd.waitFor('[data-testid="shape-rect"]'));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  // Real original drop handler and upload pipeline; only the OS drop input is synthetic.
  await wd.execute(`const data=new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(arguments[0]), c=>c.charCodeAt(0))], 'native-image.png', {type:'image/png'})); const target=document.querySelector('[data-workspace-bg]'); const r=target.getBoundingClientRect(); target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));`, png);
  const mediaSaved = await until(async () => {
    const objects = JSON.parse(readFileSync(design.path, "utf8")).pages[0].objects;
    return objects.some((entry: { type: string }) => entry.type.toLowerCase() === "image") && objects.some((entry: { type: string }) => entry.type.toLowerCase() === "rect");
  }, 20_000);
  latest = (await snapshot()).artifacts.find((entry) => entry.id === design.id)!;
  const originalImage = JSON.parse(readFileSync(design.path, "utf8")).pages[0].objects.find((entry: { src?: string }) => entry.src)?.src;
  ctx.report.check(S, "도형 메뉴·원본 그림 드롭 처리·실제 자산 파일 저장", mediaSaved && !!originalImage && readFileSync(join(other, originalImage)).equals(Buffer.from(png, "base64")), undefined, await shot(ctx, "design-media.png"));
  const expectedObjects = JSON.parse(readFileSync(design.path, "utf8")).pages[0].objects.length + 1;

  // Hold only the network response, so quick-export success cannot race the actual host save.
  await wd.execute(`const original=window.fetch; window.fetch=async (...args)=>{if(String(args[0]).endsWith('/exports')) {await new Promise(resolve=>{window.__releaseDesignExport=resolve;});} return original(...args);}; window.__originalDesignFetch=original;`);
  await wd.click(await wd.waitFor('[data-testid="ed-share"]')); await clickLabel('[role="menuitem"]', "PNG", true);
  const waiting = await until(async () => await wd.execute<boolean>("return typeof window.__releaseDesignExport === 'function';"), 20_000);
  ctx.report.check(S, "PNG 출력은 실제 저장 응답 전 완료로 표시하지 않음", waiting && !readdirSync(other).some((name) => name.endsWith(".png")) && await wd.execute<boolean>('return document.querySelector("[data-testid=ed-share]").disabled;'));
  await wd.execute("window.__releaseDesignExport(); window.fetch=window.__originalDesignFetch;");
  const pngSaved = await until(async () => readdirSync(other).some((name) => name.endsWith(".png")), 20_000);
  const pngFile = readdirSync(other).find((name) => name.endsWith(".png"));
  ctx.report.check(S, "PNG 확정 저장·원본 유지", pngSaved && readFileSync(join(other, pngFile!)).subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && readFileSync(design.path, "utf8").includes("NATIVE DESIGN AI"));
  await wd.click(await wd.waitFor('[data-testid="ed-share"]')); await clickLabel('[role="menuitem"]', "PDF", true);
  const pdfSaved = await until(async () => (await snapshot()).artifacts.some((entry) => entry.workId === work.id && entry.format === "pdf"), 20_000);
  const pdf = (await snapshot()).artifacts.find((entry) => entry.workId === work.id && entry.format === "pdf");
  ctx.report.check(S, "PDF 실제 파일·같은 작업공간 문서 등록", pdfSaved && pdf?.workspaceId === workspace.id && readFileSync(pdf.path).subarray(0, 5).toString() === "%PDF-");
  const receipts = readdirSync(join(ctx.app.dataDir, "design-exports")).map((name) => JSON.parse(readFileSync(join(ctx.app.dataDir, "design-exports", name), "utf8")));
  ctx.report.check(S, "출력 영수증에 같은 세션·정확한 저장 판·작업공간", receipts.length === 2 && receipts.every((entry) => entry.sessionId === session.id && entry.sourceArtifactId === design.id && entry.sourceRevision === latest.revision && entry.workspaceId === workspace.id));
  await wd.frame(null); await open(design.id); await enter(); await wd.waitFor("canvas");
  // Add a second object through the UI; then create a real disk conflict before autosave.
  await clickLabel("button", "글자"); await clickLabel("button", "부제목 추가", true);
  const external = JSON.parse(readFileSync(design.path, "utf8")); external.pages[0].background = { type: "solid", color: "#feaabb" };
  const externalText = `${JSON.stringify(external, null, 2)}\n`; writeFileSync(design.path, externalText);
  await api("POST", `/api/artifacts/${design.id}/adopt-disk`);
  await saveKey();
  const conflict = await until(async () => await wd.execute<boolean>('return document.body.innerText.includes("이 디자인이 다른 곳에서 바뀌었습니다");'), 15_000);
  ctx.report.check(S, "실제 외부 변경 충돌·사람 편집 DOM과 원본 보호", conflict && readFileSync(design.path, "utf8") === externalText, undefined, await shot(ctx, "design-conflict.png"));
  const draftsFolder = join(ctx.app.dataDir, "design-drafts", design.id);
  if (!await until(async () => existsSync(draftsFolder) && readdirSync(draftsFolder).some((name) => name.endsWith(".json")))) throw new Error("No durable design draft");
  const kept = JSON.parse(readFileSync(join(draftsFolder, readdirSync(draftsFolder).find((name) => name.endsWith(".json"))!), "utf8")) as DesignDraft;
  ctx.report.check(S, "충돌 중 복구본에 마지막 사람 편집 보관", JSON.parse(kept.text).pages[0].objects.length === expectedObjects && kept.baseRevision === latest.revision);
  const errors = await pageErrors(wd); await wd.frame(null);
  await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "design-restarted", freshPort: true }); wd = ctx.app.wd;
  await wd.setWindowRect({ width: 1800, height: 1100 });
  await enter();
  await wd.waitFor('[role="dialog"][aria-label="디자인 편집 복구"]', 30_000);
  ctx.report.check(S, "실제 앱 재시작·새 포트에서 명시적 복구 선택", readFileSync(design.path, "utf8") === externalText, undefined, await shot(ctx, "design-recovery.png"));
  await clickLabel("button", "이 편집 복구"); await wd.waitFor("canvas"); await saveKey();
  if (!await until(async () => await wd.execute<boolean>('return document.body.innerText.includes("이 디자인이 다른 곳에서 바뀌었습니다");'))) throw new Error("Recovered draft did not retain its stale base");
  await clickLabel("button", "내 편집을 사본으로 저장");
  const copied = await until(async () => (await snapshot()).artifacts.some((entry) => entry.format === "design" && entry.id !== design.id && entry.workId === work.id), 15_000);
  const copy = (await snapshot()).artifacts.find((entry) => entry.format === "design" && entry.id !== design.id && entry.workId === work.id);
  ctx.report.check(S, "복구 충돌 사본·원래 작업공간·외부 원본 유지", copied && copy?.workspaceId === workspace.id && JSON.parse(readFileSync(copy.path, "utf8")).pages[0].objects.length === expectedObjects && readFileSync(design.path, "utf8") === externalText);
  const copiedImage = JSON.parse(readFileSync(copy!.path, "utf8")).pages[0].objects.find((entry: { src?: string }) => entry.src)?.src;
  ctx.report.check(S, "사본에 독립된 이미지 바이트·상대 경로", !!copiedImage && copiedImage !== originalImage && readFileSync(join(other, copiedImage)).equals(Buffer.from(png, "base64")));
  ctx.report.check(S, "사본 완료 뒤 정확한 복구본 정리", await until(async () => !readdirSync(draftsFolder).some((name) => name.endsWith(".json"))));
  await wd.frame(null); await open(copy!.id); await enter(); await wd.waitFor("canvas");
  ctx.report.check(S, "사본 재열기·중복 복구 안내 없음", !(await wd.find('[aria-label="디자인 편집 복구"]')), undefined, await shot(ctx, "design-copy.png"));
  const beforeLoss = readFileSync(copy!.path, "utf8");
  await wd.execute('window.__keptDesignEditor = "same DOM";');
  await clickLabel("button", "글자"); await wd.click(await wd.waitFor('[data-testid="text-preset-body"]'));
  await wd.frame(null);
  const viewId = await wd.execute<string>('return document.querySelector(".pane:not([hidden]) .document-view").dataset.editorView;');
  const views = (await api<{ views: DocumentPresence[] }>("GET", "/api/document-views")).views;
  const ownView = views.find((entry) => entry.viewId === viewId)!;
  await api("DELETE", `/api/document-views/${viewId}`, { windowId: ownView.windowId });
  await api("POST", `/api/artifacts/${copy!.id}/views`, { viewId: "design-elsewhere", windowId: "design-external", claim: true });
  const lost = await until(async () => !!await wd.find('.pane:not([hidden]) .document-view[data-editor-access="read"] .doc-body[inert]'), 15_000);
  await enter();
  ctx.report.check(S, "권한 상실 때 동일 편집기 DOM·미저장 편집 유지", lost && await wd.execute<boolean>('return window.__keptDesignEditor === "same DOM";') && readFileSync(copy!.path, "utf8") === beforeLoss);
  await wd.frame(null); await api("DELETE", "/api/document-views/design-elsewhere", { windowId: "design-external" });
  await clickLabel(".doc-access button", "편집 권한 받기");
  await wd.waitFor('.pane:not([hidden]) .document-view[data-editor-access="write"]');
  await enter(); await saveKey();
  ctx.report.check(S, "권한 재획득 뒤 남겨 둔 편집 저장", await until(async () => JSON.parse(readFileSync(copy!.path, "utf8")).pages[0].objects.length === expectedObjects + 1));
  const afterErrors = await pageErrors(wd); await wd.frame(null);
  ctx.report.check(S, "디자인 편집기·상위 앱 예외 없음", !errors.length && !afterErrors.length && !(await pageErrors(wd)).length, [...errors, ...afterErrors].join("\n"));
  ctx.report.note(S, "AI는 로컬 JSON-RPC 대체 엔진, 그림 드롭은 합성 File 입력. 메뉴/글자/도형/자산 저장/복구/실제 파일/PNG/PDF/권한은 배포 앱 코드이며 물리 OS 입력·실제 모델 품질 인수는 별도입니다.");
}
