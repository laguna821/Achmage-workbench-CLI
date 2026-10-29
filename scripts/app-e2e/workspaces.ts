import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Session, Snapshot, Work } from "@workbench/contracts";
import { installProbe, pageErrors, record, recorded, savedLayout, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

export async function workspacesScenario(ctx: Ctx) {
  const S = "5 작업공간";
  const { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "작업공간 검사", cwd: null });
  const first = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const before = await snapshot();
  await seedLayout(ctx, { ...before.prefs, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: work.id, sessionId: first.id, view: { kind: "work" } }] } });
  await wd.refresh(); await wd.waitFor('[aria-label="작업공간 선택"]'); await installProbe(wd);
  const selected = async () => wd.execute<string>('return document.querySelector(".workspace-trigger")?.textContent || "";');
  const clickLabel = async (label: string) => wd.click(await wd.waitFor(`[aria-label="${label}"]`));
  const buttonText = async (text: string) => {
    for (const button of await wd.findAll('.workspace-menu button')) {
      if ((await wd.execute<string>('return arguments[0].textContent;', button)).trim() === text) { await wd.click(button); return; }
    }
    throw new Error(`Workspace action missing: ${text}`);
  };
  const folder = join(ctx.stage.root, "연결 폴더"); mkdirSync(folder);
  await record(wd); await clickLabel("작업공간 선택");
  await wd.sendKeys(await wd.waitFor('[aria-label="작업공간 폴더 경로"]'), folder);
  await buttonText("작업공간 추가");
  await until(async () => (await selected()).includes("연결 폴더"));
  const after = await snapshot();
  const added = after.workspaces?.find((entry) => entry.cwd === folder)!;
  const second = after.sessions.find((entry) => entry.workspaceId === added?.id)!;
  const events = await recorded(wd);
  ctx.report.check(S, "실제 폴더 연결·새 세션의 작업공간 고정", !!added && !!second && second.id !== first.id && after.sessions.find((entry) => entry.id === first.id)?.workspaceId === first.workspaceId && events.trusted, undefined, await shot(ctx, "5-workspace-added.png"));
  await wd.click(await wd.waitFor('.topbar-right button[aria-label="아래로 분할"]'));
  await until(async () => ((await savedLayout(ctx, added.id))?.layout.panes as unknown[])?.length === 2);

  await clickLabel("작업공간 선택"); await clickLabel("연결 폴더 이름 바꾸기");
  const name = await wd.waitFor('[aria-label="작업공간 이름"]'); await wd.click(name);
  await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
  await wd.sendKeys(name, "문서 초안"); await buttonText("이름 저장");
  await until(async () => (await selected()).includes("문서 초안"));
  await clickLabel("문서 초안 보관");
  await until(async () => !!(await snapshot()).workspaces?.find((entry) => entry.id === added.id)?.archivedAt);
  ctx.report.check(S, "보관은 실행 입력만 막고 세션·폴더 연결을 유지", !!(await wd.execute('return document.querySelector(".work-view .composer textarea")?.disabled;')) && (await snapshot()).sessions.some((entry) => entry.id === second.id && !entry.archivedAt), undefined, await shot(ctx, "5-workspace-archived.png"));
  await clickLabel("문서 초안 복원"); await until(async () => !(await snapshot()).workspaces?.find((entry) => entry.id === added.id)?.archivedAt);
  await wd.click(await wd.waitFor(`[data-workspace-id="${work.defaultWorkspaceId}"]`));
  await until(async () => (await selected()).includes("기본 작업공간"));
  const defaultSeparate = (await wd.findAll('.pane:not([hidden])')).length === 1;
  await clickLabel("작업공간 선택"); await wd.click(await wd.waitFor(`[data-workspace-id="${added.id}"]`));
  await until(async () => (await snapshot()).works.find((entry) => entry.id === work.id)?.activeSessionId === second.id);
  await until(async () => (await snapshot()).prefs.layoutScope === added.id && JSON.stringify((await savedLayout(ctx, added.id))?.layout).includes(second.id));
  ctx.report.check(S, "작업공간별 분할 배치를 독립 저장·왕복 복원", defaultSeparate && (await wd.findAll('.pane:not([hidden])')).length === 2 && ((await savedLayout(ctx))?.layout.panes as unknown[])?.length === 1, undefined, await shot(ctx, "5-workspace-layouts.png"));
  await wd.refresh(); await wd.waitFor('[aria-label="작업공간 선택"]');
  const restored = await snapshot();
  ctx.report.check(S, "작업공간 왕복·새로고침에도 같은 세션 복원", (await selected()).includes("문서 초안") && restored.sessions.filter((entry) => entry.workId === work.id).length === 2 && restored.works.find((entry) => entry.id === work.id)?.cwd === work.cwd, undefined, await shot(ctx, "5-workspace-restored.png"));
  ctx.report.check(S, "작업공간 검사 중 페이지 예외 없음", !(await pageErrors(wd)).length);
}
