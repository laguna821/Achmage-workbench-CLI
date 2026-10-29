import { readFileSync } from "node:fs";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { installProbe, pageErrors, record, recorded, savedLayout as layoutRecord, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { center, moveSteps } from "./webdriver.ts";

export async function tabsScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "7 그룹 탭";
  let wd = ctx.app.wd;
  const work = await ctx.app.api<Work>("POST", "/api/works", { title: "탭 그룹 검사", cwd: null });
  const session = await ctx.app.api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const a = await ctx.app.api<Artifact>("POST", `/api/works/${work.id}/pages`, { name: "첫 문서" });
  const b = await ctx.app.api<Artifact>("POST", `/api/works/${work.id}/pages`, { name: "둘째 문서" });
  await ctx.app.api("PUT", `/api/artifacts/${a.id}/text`, { expectedRevision: a.revision, text: Array.from({ length: 160 }, (_, index) => `문서 위치 검사 ${index + 1}`).join("\n\n") });
  const tabs = [
    { id: "native-tab-a", view: { kind: "document", artifactId: a.id, proposalId: null }, workId: work.id, sessionId: session.id },
    { id: "native-tab-b", view: { kind: "document", artifactId: b.id, proposalId: null }, workId: work.id, sessionId: session.id },
    { id: "native-tab-chat", view: { kind: "work" }, workId: work.id, sessionId: session.id },
  ];
  const snapshot = await ctx.app.api<Snapshot>("GET", "/api/snapshot");
  await seedLayout(ctx, { ...snapshot.prefs, paneLayout: { version: 2, focus: "a", panes: [{ ...tabs[0], id: "a", tabs, activeTabId: tabs[0]!.id, recentTabIds: [tabs[0]!.id] }] } });
  await wd.setWindowRect({ width: 1500, height: 1000 }); await wd.refresh(); await installProbe(wd);
  const current = '.pane:not([hidden])';
  const editor = await wd.waitFor(`${current} .cm-content[contenteditable="true"]`);
  await wd.execute('arguments[0].dataset.testIdentity = "kept-editor"; return true;', editor);
  await wd.click(editor); await wd.sendKeys(editor, "TAB INPUT PRESERVED");
  await wd.press("\uE00F"); await wd.press("\uE00F"); await wd.press("\uE012");
  const select = async (id: string) => wd.click(await wd.waitFor(`${current} [data-tab-id="${id}"] [role="tab"]`));
  await select("native-tab-b");
  await until(async () => !!(await wd.find('.pane[data-tab="native-tab-b"]:not([hidden]) .document-view')));
  await select("native-tab-a");
  const kept = await wd.execute<boolean>('return !!document.querySelector(".pane:not([hidden]) .cm-content[data-test-identity=kept-editor]");');
  ctx.report.check(S, "세션·문서 공통 탭과 문서 왕복 시 편집기·입력 유지", kept && readFileSync(a.path, "utf8").includes("TAB INPUT PRESERVED"), undefined, await shot(ctx, "7-tab-switch.png"));
  const from = center(await wd.rect(await wd.waitFor(`${current} [data-tab-id="native-tab-a"] [role="tab"]`)));
  const rect = await wd.rect(await wd.waitFor(current));
  const to = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height - 25) };
  await wd.releaseActions();
  await record(wd);
  await wd.pointer([{ type: "pointerMove", ...from }, { type: "pointerDown", button: 0 }, ...moveSteps(from, to, 16), { type: "pointerUp", button: 0 }]);
  const events = await recorded(wd);
  await wd.releaseActions();
  const moved = await until(async () => (await wd.findAll(`${current}`)).length === 2);
  const same = await wd.execute<boolean>('return document.querySelectorAll("[data-test-identity=kept-editor]").length === 1 && document.querySelector("[data-test-identity=kept-editor]")?.closest(".pane")?.dataset.pane !== "a";');
  ctx.report.check(S, "실제 탭 드래그로 상하 분할·편집기 중복 생성 없음", moved && same && events.trusted, JSON.stringify(events), await shot(ctx, "7-tab-moved.png"));
  if (!moved || !same) throw new Error("Tab split did not occur; dependent restore checks were not run");
  const btab = await wd.waitFor('.pane[data-pane="a"]:not([hidden]) [data-tab-id="native-tab-b"] [role="tab"]');
  await wd.click(btab);
  await wd.keys([{ type: "keyDown", value: "\uE009" }, { type: "keyDown", value: "\uE008" }, { type: "keyDown", value: "\uE014" }, { type: "keyUp", value: "\uE014" }, { type: "keyUp", value: "\uE008" }, { type: "keyUp", value: "\uE009" }]);
  const reordered = await wd.execute<boolean>('return document.querySelector(".pane[data-pane=a]:not([hidden]) .group-tab")?.dataset.tabId === "native-tab-chat";');
  ctx.report.check(S, "키보드로 그룹 내 탭 순서 변경", reordered);
  const savedLayout = async () => JSON.stringify((await layoutRecord(ctx))?.layout);
  await until(async () => { const raw = JSON.parse(await savedLayout()); return raw?.panes?.length === 2 && raw.panes[0]?.tabs?.[0]?.id === "native-tab-chat"; });
  let saved = await savedLayout();
  await until(async () => { const next = await savedLayout(), same = next === saved; saved = next; return same; }, 3000, 350);
  const errorsBefore = await pageErrors(wd), oldOrigin = ctx.app.gateway.url;
  await ctx.app.close();
  ctx.app = await ctx.stage.launch({ ...launch, name: "tabs-restarted", freshPort: true, window: { width: 1500, height: 1000 } });
  wd = ctx.app.wd; await installProbe(wd);
  const restored = await until(async () => (await wd.findAll(current)).length === 2);
  const structural = (json: string) => JSON.stringify(JSON.parse(json), (key, value) => key === "ui" ? undefined : value);
  ctx.report.check(S, "새 포트 재시작 후 탭 ID·순서·MRU·배치 복원", restored && oldOrigin !== ctx.app.gateway.url && structural(saved) === structural(await savedLayout()), undefined, await shot(ctx, "7-tabs-restarted.png"));
  const originalPosition = JSON.parse(saved).panes.flatMap((pane: { tabs: { id: string; ui?: { cursor?: { anchor: number; head: number }; scroll?: { top: number } } }[] }) => pane.tabs).find((tab: { id: string }) => tab.id === "native-tab-a")?.ui;
  const scrolled = await until(async () => await wd.execute<number>('return document.querySelector(".pane[data-tab=native-tab-a] .cm-scroller")?.scrollTop || 0;') >= (originalPosition?.scroll?.top ?? 1) - 2);
  ctx.report.check(S, "문서 커서 위치 저장·재시작 후 스크롤 복원", !!originalPosition?.cursor?.head && (originalPosition?.scroll?.top ?? 0) > 0 && scrolled, JSON.stringify(originalPosition));
  // A separate API writer represents another window; the local user then changes their own tab.
  const remote = (await layoutRecord(ctx))!;
  const changedElsewhere = { ...remote.layout, focus: "pane-1" };
  await ctx.app.api("PUT", "/api/layouts/global", { expectedRevision: remote.revision, layout: changedElsewhere });
  await wd.click(await wd.waitFor('.pane[data-pane="a"]:not([hidden]) [data-tab-id="native-tab-chat"] [role="tab"]'));
  const conflict = await until(async () => !!(await wd.find('.layout-problem')));
  ctx.report.check(S, "다른 창의 배치 수정 충돌 시 양쪽 배치 유지", conflict && (await layoutRecord(ctx))?.revision === remote.revision + 1 && !!(await wd.find('.pane[data-tab="native-tab-chat"]:not([hidden]) .work-view')), undefined, await shot(ctx, "7-layout-conflict.png"));
  for (const button of await wd.findAll('.layout-problem button')) if ((await wd.execute<string>('return arguments[0].textContent.trim();', button)) === "현재 배치로 저장") { await wd.click(button); break; }
  const resolved = await until(async () => !(await wd.find('.layout-problem')) && ((await layoutRecord(ctx))?.revision ?? 0) > remote.revision + 1);
  ctx.report.check(S, "사용자가 현재 배치를 선택한 뒤 충돌 해결", resolved);
  await wd.click(await wd.waitFor('.pane:not([hidden]) [aria-label="첫 문서.md 탭 닫기"]'));
  const closed = await until(async () => (await wd.findAll(current)).length === 1);
  const after = await ctx.app.api<Snapshot>("GET", "/api/snapshot");
  ctx.report.check(S, "마지막 탭 닫기 시 빈 칸 정리·파일과 세션 유지", closed && !after.sessions.find((entry) => entry.id === session.id)!.archivedAt && readFileSync(a.path, "utf8").includes("TAB INPUT PRESERVED"));
  ctx.report.check(S, "탭 조작 중 페이지 예외 없음", !errorsBefore.length && !(await pageErrors(wd)).length);
}
