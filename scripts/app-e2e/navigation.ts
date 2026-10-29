import { readFileSync, writeFileSync } from "node:fs";
import type { Artifact, ProjectPage, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

export async function navigationScenario(ctx: Ctx) {
  const S = "6 문서 전환";
  const { wd, api } = ctx.app;
  const one = await api<Work>("POST", "/api/works", { title: "편집 중인 프로젝트", cwd: null });
  const two = await api<Work>("POST", "/api/works", { title: "이동할 프로젝트", cwd: null });
  await api("POST", `/api/works/${two.id}/sessions`, { provider: "codex" });
  const doc = await api<Artifact>("POST", `/api/works/${one.id}/pages`, { name: "저장 검사" });
  const snapshot = await api<Snapshot>("GET", "/api/snapshot");
  await seedLayout(ctx, { ...snapshot.prefs, navigator: { layout: "dual", selected: { kind: "root" }, includeSub: true, density: "standard" }, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: one.id, sessionId: null, view: { kind: "document", artifactId: doc.id, proposalId: null } }] } });
  await wd.setWindowRect({ width: 1280, height: 860 }); await wd.refresh();
  const editor = await wd.waitFor('.document-view .cm-content[contenteditable="true"]');
  await installProbe(wd);
  // An actual concurrent disk edit makes the gateway refuse saving; no fetch or UI state is mocked.
  writeFileSync(doc.path, "External disk revision\n");
  await wd.click(editor); await wd.sendKeys(editor, "UNSAVED LOCAL EDIT");
  await wd.click(await wd.waitFor(`.nav-project[data-row-id="${two.id}"]`));
  await until(async () => !!(await wd.find(".doc-conflict")));
  const remains = () => wd.execute<boolean>('return !!document.querySelector(".document-view") && document.querySelector(".cm-content")?.textContent.includes("UNSAVED LOCAL EDIT");');
  ctx.report.check(S, "저장 충돌 시 프로젝트 전환 보류·편집 내용 유지", await remains() && readFileSync(doc.path, "utf8") === "External disk revision\n", undefined, await shot(ctx, "6-navigation-blocked.png"));
  await wd.click(await wd.waitFor('[aria-label="저장 검사.md 탭 닫기"]'));
  ctx.report.check(S, "저장 실패 시 탭 닫기도 보류", await remains() && !!(await wd.find('[aria-label="저장 검사.md 탭 닫기"]')));
  for (const button of await wd.findAll('.doc-conflict button')) {
    if ((await wd.execute<string>('return arguments[0].textContent.trim();', button)) === "내 편집을 새 판으로") { await wd.click(button); break; }
  }
  const saved = await until(async () => readFileSync(doc.path, "utf8").includes("UNSAVED LOCAL EDIT"));
  await wd.click(await wd.waitFor(`.nav-project[data-row-id="${two.id}"]`));
  const opened = await until(async () => !!(await wd.find(".pane:not([hidden]) .work-view")) && !(await wd.find(".pane:not([hidden]) .document-view")));
  const after = await api<Snapshot>("GET", "/api/snapshot");
  ctx.report.check(S, "충돌 해결 후 저장·프로젝트 전환 성공", saved && opened && after.artifacts.find((entry) => entry.id === doc.id)!.revision >= 3, undefined, await shot(ctx, "6-navigation-saved.png"));
  await api("PUT", `/api/projects/${two.id}/body`, { body: "Project original body\n", baseRevision: null });
  await wd.click(await wd.waitFor('.pane:not([hidden]) .work-view .project-link'));
  await wd.waitFor('.pane:not([hidden]) .project-note-body');
  await wd.click(await wd.waitFor('.pane:not([hidden]) .project-note .project-section-head button'));
  const projectEditor = await wd.waitFor('.pane:not([hidden]) .project-note-editor .cm-content[contenteditable="true"]');
  await wd.click(projectEditor); await wd.sendKeys(projectEditor, "PROJECT UNSAVED BODY");
  await wd.click(await wd.waitFor(`.nav-project[data-row-id="${one.id}"]`));
  ctx.report.check(S, "프로젝트 노트의 수동 편집 중 이동 보류", !!(await wd.find('.pane:not([hidden]) .project-note-editor')) && await wd.execute<boolean>('return document.querySelector(".project-note-editor .cm-content")?.textContent.includes("PROJECT UNSAVED BODY");'));
  const page = await api<ProjectPage>("GET", `/api/projects/${two.id}`);
  const external = readFileSync(page.note.path, "utf8") + "\nEXTERNAL PROJECT CHANGE\n";
  writeFileSync(page.note.path, external);
  await wd.click(await wd.waitFor('.pane:not([hidden]) .project-note-actions button.primary'));
  const retained = await until(async () => !!(await wd.find('.pane:not([hidden]) .project-note-actions button.primary:not([disabled])')));
  ctx.report.check(S, "프로젝트 노트 저장 실패 시 편집창·초안·외부 원문 유지", retained && readFileSync(page.note.path, "utf8") === external && await wd.execute<boolean>('return document.querySelector(".project-note-editor .cm-content")?.textContent.includes("PROJECT UNSAVED BODY");'), undefined, await shot(ctx, "6-project-note-save-conflict.png"));
  // A live page refresh must not silently rebase the already-open body editor onto newer bytes.
  const refreshed = await api<ProjectPage>("GET", `/api/projects/${two.id}`);
  await api("PUT", "/api/projects/stages", { stages: refreshed.stages });
  await until(async () => await wd.execute<boolean>('return Number(document.querySelector(".pane:not([hidden]) .project-view")?.dataset.noteRevision) === arguments[0];', refreshed.note.revision));
  const refreshedDisk = readFileSync(page.note.path, "utf8");
  const saveAgain = await wd.waitFor('.pane:not([hidden]) .project-note-actions button.primary');
  await wd.execute('arguments[0].scrollIntoView({ block: "center" });', saveAgain);
  await wd.click(saveAgain);
  const stillRetained = await until(async () => !!(await wd.find('.pane:not([hidden]) .project-note-actions button.primary:not([disabled])')));
  ctx.report.check(S, "페이지 판이 갱신되어도 편집 시작 판을 유지해 덮어쓰기 거절", stillRetained && readFileSync(page.note.path, "utf8") === refreshedDisk && await wd.execute<boolean>('return document.querySelector(".project-note-editor .cm-content")?.textContent.includes("PROJECT UNSAVED BODY");'));
  const cancel = await wd.waitFor('.pane:not([hidden]) .project-note-actions button:not(.primary)');
  await wd.execute('arguments[0].scrollIntoView({ block: "center" });', cancel);
  await wd.click(cancel);
  await wd.click(await wd.waitFor(`.nav-project[data-row-id="${one.id}"]`));
  ctx.report.check(S, "수동 편집 취소 후 정상 이동", await until(async () => !!(await wd.find('.pane:not([hidden]) .work-view'))));
  ctx.report.check(S, "문서 전환 중 페이지 예외 없음", !(await pageErrors(wd)).length);
}
