import { readFileSync, writeFileSync } from "node:fs";
import type { Artifact, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, shot, until, type Ctx } from "./scenarios.ts";

export async function navigationScenario(ctx: Ctx) {
  const S = "6 문서 전환";
  const { wd, api } = ctx.app;
  const one = await api<Work>("POST", "/api/works", { title: "편집 중인 프로젝트", cwd: null });
  const two = await api<Work>("POST", "/api/works", { title: "이동할 프로젝트", cwd: null });
  await api("POST", `/api/works/${two.id}/sessions`, { provider: "codex" });
  const doc = await api<Artifact>("POST", `/api/works/${one.id}/pages`, { name: "저장 검사" });
  const snapshot = await api<Snapshot>("GET", "/api/snapshot");
  await api("PUT", "/api/prefs", { prefs: { ...snapshot.prefs, navigator: { layout: "dual", selected: { kind: "root" }, includeSub: true, density: "standard" }, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: one.id, sessionId: null, view: { kind: "document", artifactId: doc.id, proposalId: null } }] } } });
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
  const opened = await until(async () => !!(await wd.find(".work-view")) && !(await wd.find(".document-view")));
  const after = await api<Snapshot>("GET", "/api/snapshot");
  ctx.report.check(S, "충돌 해결 후 저장·프로젝트 전환 성공", saved && opened && after.artifacts.find((entry) => entry.id === doc.id)!.revision >= 3, undefined, await shot(ctx, "6-navigation-saved.png"));
  ctx.report.check(S, "문서 전환 중 페이지 예외 없음", !(await pageErrors(wd)).length);
}
