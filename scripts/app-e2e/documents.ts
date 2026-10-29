import { readFileSync } from "node:fs";
import type { Artifact, DocumentPresence, DocumentRegistration, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

export async function documentsScenario(ctx: Ctx) {
  const S = "8 문서 편집 권한";
  const { wd, api, gateway } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "공통 문서 검사", cwd: null });
  const doc = await api<Artifact>("POST", `/api/works/${work.id}/pages`, { name: "함께 연 문서" });
  const snapshot = await api<Snapshot>("GET", "/api/snapshot");
  const panes = ["a", "b"].map((id) => {
    const tab = { id: `registry-${id}`, workId: work.id, sessionId: null, view: { kind: "document", artifactId: doc.id, proposalId: null } };
    return { ...tab, id, tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] };
  });
  await seedLayout(ctx, { ...snapshot.prefs, paneLayout: { version: 2, focus: "a", panes } });
  await wd.setWindowRect({ width: 1500, height: 900 }); await wd.refresh(); await installProbe(wd);
  const writer = await wd.waitFor('.pane:not([hidden]) .document-view[data-editor-access="write"]');
  const reader = await wd.waitFor('.pane:not([hidden]) .document-view[data-editor-access="read"] .cm-content[contenteditable="false"]');
  const viewId = await wd.execute<string>('return arguments[0].dataset.editorView;', writer);
  const tabId = await wd.execute<string>('return arguments[0].closest(".pane").dataset.tab;', writer);
  const own = `.document-view[data-editor-view="${viewId}"]`;
  const editor = await wd.waitFor(`${own} .cm-content[contenteditable="true"]`);
  await wd.execute('arguments[0].dataset.keptRegistry = "yes";', editor);
  ctx.report.check(S, "같은 문서 두 뷰 중 하나만 편집 가능", (await wd.findAll('.document-view[data-editor-access="write"]')).length === 1 && !!reader, undefined, await shot(ctx, "8-one-writer.png"));
  let refused = false;
  try { await api("PUT", `/api/artifacts/${doc.id}/text`, { expectedRevision: 1, text: "UNSCOPED OVERWRITE" }); } catch (error) { refused = String(error).includes("423"); }
  await wd.click(editor); await wd.sendKeys(editor, "FIRST WRITER INPUT");
  const saved = await until(async () => readFileSync(doc.path, "utf8").includes("FIRST WRITER INPUT"));
  ctx.report.check(S, "권한 없는 저장 거절·실제 편집기 저장과 읽기 뷰 갱신", refused && saved && await until(async () => await wd.execute<boolean>('return arguments[0].textContent.includes("FIRST WRITER INPUT");', reader)));
  const views = (await api<{ views: DocumentPresence[] }>("GET", "/api/document-views")).views;
  const prior = views.find((view) => view.viewId === viewId)!;
  await wd.click(editor); await wd.sendKeys(editor, " UNSAVED AFTER LOST ACCESS");
  const typed = await wd.execute<boolean>('return arguments[0].textContent.includes("UNSAVED AFTER LOST ACCESS");', editor);
  if (!typed) throw new Error("The unsaved draft was not typed before access was removed");
  await api("DELETE", `/api/document-views/${prior.viewId}`, { windowId: prior.windowId });
  const elsewhere = await api<DocumentRegistration>("POST", `/api/artifacts/${doc.id}/views`, { viewId: "external-editor", windowId: "external-window", claim: true });
  // Access goes away after the actual draft has been typed; it must remain in this editor.
  const before = (await api<Snapshot>("GET", "/api/snapshot")).artifacts.find((entry) => entry.id === doc.id)!;
  const response = await fetch(`${gateway.url}/api/artifacts/${doc.id}/text`, { method: "PUT", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json", "x-workbench-view": elsewhere.view.viewId, "x-workbench-write": elsewhere.writeToken! }, body: JSON.stringify({ expectedRevision: before.revision, text: "OTHER WINDOW REVISION\n" }) });
  if (!response.ok) throw new Error(`External writer setup failed: ${response.status}`);
  const locked = await until(async () => !!(await wd.find(`${own}[data-editor-access="read"] .cm-content[contenteditable="false"]`)), 15_000);
  const intact = await wd.execute<boolean>('return arguments[0].dataset.keptRegistry === "yes" && arguments[0].textContent.includes("UNSAVED AFTER LOST ACCESS");', editor);
  ctx.report.check(S, "권한 상실 시 편집기·초안 유지와 다른 창의 파일 보호", locked && intact && readFileSync(doc.path, "utf8") === "OTHER WINDOW REVISION\n", undefined, await shot(ctx, "8-access-lost.png"));
  await api("DELETE", "/api/document-views/external-editor", { windowId: "external-window" });
  await wd.click(await wd.waitFor(`${own} .doc-access button`));
  await until(async () => !!(await wd.find(`${own}[data-editor-access="write"]`)));
  for (const button of await wd.findAll(`${own} .doc-conflict button`)) if ((await wd.execute<string>('return arguments[0].textContent.trim();', button)) === "내 편집을 새 판으로") { await wd.click(button); break; }
  const restored = await until(async () => readFileSync(doc.path, "utf8").includes("UNSAVED AFTER LOST ACCESS"));
  ctx.report.check(S, "권한을 다시 받은 뒤 명시적으로 충돌 해결·입력 저장", restored && await wd.execute<boolean>('return arguments[0].dataset.keptRegistry === "yes";', editor));
  await wd.click(await wd.waitFor(`.pane[data-tab="${tabId}"] [aria-label="함께 연 문서.md 탭 닫기"]`));
  await until(async () => !(await wd.find(own)));
  await wd.click(await wd.waitFor('.pane:not([hidden]) .doc-access button'));
  ctx.report.check(S, "작성자 탭을 닫으면 읽기 뷰가 명시적으로 편집권 인계", await until(async () => !!(await wd.find('.pane:not([hidden]) .document-view[data-editor-access="write"] .cm-content[contenteditable="true"]'))));
  const errors = await pageErrors(wd);
  await wd.refresh(); await installProbe(wd);
  ctx.report.check(S, "새로고침 후 이전 창의 권한에 막히지 않고 문서 재개", await until(async () => !!(await wd.find('.pane:not([hidden]) .document-view[data-editor-access="write"] .cm-content[contenteditable="true"]'))));
  ctx.report.check(S, "문서 권한 조작 중 페이지 예외 없음", !errors.length && !(await pageErrors(wd)).length);
}
