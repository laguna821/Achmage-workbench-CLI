import { existsSync } from "node:fs";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import { installProbe, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

/** Actual sidebar, top tabs and blank-file UI, without any model call. */
export async function usabilityScenario(ctx: Ctx) {
  const { wd, api } = ctx.app, S = "설치본 사용성";
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const work = await api<Work>("POST", "/api/works", { title: "프로젝트 오버뷰 검사", cwd: null });
  const main = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "메인 채팅" });
  const tab = { id: "usability-main", workId: work.id, sessionId: main.id, view: { kind: "work" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, sidebar: true, navigator: { layout: "stacked" }, paneLayout: { version: 2, focus: "usability-pane", panes: [{ ...tab, id: "usability-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
  const clickText = async (selector: string, label: string) => {
    if (!await until(async () => {
      for (const element of await wd.findAll(selector)) if (await wd.displayed(element) && await wd.execute<boolean>("return arguments[0].textContent.trim() === arguments[1]", element, label)) { await wd.click(element); return true; }
      return false;
    }, 15000)) throw new Error(`Command missing: ${label}`);
  };
  const project = await wd.waitFor(`.sidebar .row-work[data-row-id="${work.id}"]`, 20000);
  await wd.click(project); await wd.waitFor(".project-view .properties-panel", 20000);
  ctx.report.check(S, "사이드바 프로젝트 한 번 클릭 → 오버뷰와 YAML 속성", await wd.execute<boolean>('return document.querySelector(".project-title")?.textContent === arguments[0] && document.querySelector(".group-tab.active")?.textContent.includes("프로젝트") === true;', work.title), undefined, await shot(ctx, "usability-project-overview.png"));
  ctx.report.check(S, "전체 프로젝트 보기와 정리 폴더, 채팅 목록의 구분", await wd.execute<boolean>('const rows=[...document.querySelectorAll(".sidebar [data-row-id]")];return document.querySelector(".nav-root")?.textContent.includes("전체 프로젝트 보기") === true && document.querySelector(".nav-folder-heading")?.textContent === "정리 폴더" && rows.some(el=>el.dataset.rowId === "chats:"+arguments[0]) && rows.some(el=>el.dataset.rowId === arguments[1]);', work.id, main.id));
  await clickText(".topbar button", "새 문서");
  await wd.sendKeys(await wd.waitFor('.new-document-dialog[open] input[placeholder="새 워드"]'), "오프라인 새 문서");
  await wd.click(await wd.waitFor('.new-document-dialog[open] button[type="submit"]'));
  let created: Artifact | undefined;
  if (!await until(async () => { created = (await snapshot()).artifacts.find((entry) => entry.workId === work.id && entry.name === "오프라인 새 문서.docx"); return !!created; }, 30000)) throw new Error("Blank document was not created");
  await wd.frame(await wd.waitFor('.pane[data-pane-active="true"] iframe.office-frame', 30000));
  await wd.waitFor('.tiptap[contenteditable="true"]', 60000);
  await wd.frame(null);
  ctx.report.check(S, "AI 요청 없이 새 문서 버튼에서 실제 빈 Word 파일 생성", existsSync(created!.path) && (await api<{ items: unknown[] }>("GET", `/api/sessions/${main.id}/items`)).items.length === 0);
  ctx.report.check(S, "문서 집중 화면: 사이드바·중복 CLI 입력 숨김, 상단 탭 유지", await wd.execute<boolean>('return !document.querySelector(".sidebar") && !document.querySelector(".pane[data-pane-active=true] .doc-composer") && !!document.querySelector(".pane[data-pane-active=true] .group-tabs");'), undefined, await shot(ctx, "usability-document-focus.png"));
  await wd.click(await wd.waitFor('.group-tab[data-tab-id="usability-main"] [role="tab"]'));
  ctx.report.check(S, "상단 메인 채팅 탭으로 돌아오면 사이드바와 입력 복원", await until(() => wd.execute<boolean>('return !!document.querySelector(".sidebar") && !!document.querySelector(".pane[data-pane-active=true] .composer-area");'), 15000), undefined, await shot(ctx, "usability-main-restored.png"));
}
