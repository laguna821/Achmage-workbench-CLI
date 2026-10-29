import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY, sleep } from "./webdriver.ts";
import { importBase } from "../../apps/web/src/base-interop.ts";
import { pageErrors, shot, until, type Ctx } from "./scenarios.ts";

export async function basesScenario(ctx: Ctx, workId: string) {
  const S = "4 Bases 교환";
  const { wd, api } = ctx.app;
  const clickText = async (selector: string, text: string) => {
    for (const element of await wd.findAll(selector)) {
      const label = await wd.execute<string>("return arguments[0].textContent.trim();", element);
      if (label === text) { await wd.click(element); return; }
    }
    await shot(ctx, "4-missing-action.png");
    throw new Error(`Missing Bases action: ${text}`);
  };
  const other = await api<{ id: string }>("POST", "/api/works", { title: "필터에서 빠질 프로젝트", folderId: null, cwd: null });
  await api("POST", `/api/projects/${other.id}/initialize-note`, {});
  await wd.click(await wd.waitFor(".side-home"));
  await clickText(".home-mode-bar button", "프로젝트");
  await wd.click(await wd.waitFor('.view-add[aria-label="보기 더하기"]'));
  await clickText(".view-add-pop button", "Bases 가져오기…");
  const source = await wd.waitFor('textarea[aria-label="Bases YAML"]');
  const yaml = 'filters: \'note["DIKM_단계:"] == "I"\'\nviews:\n  - type: table\n    name: 가져온 검증 보기\n    order:\n      - file.name\n      - note.DIKM_단계:\n  - type: table\n    name: 지원하지 않는 식\n    filters: formula.cost > 2\n';
  // Quote colon-ending property names as YAML values; never use sendKeys for line separators.
  const fixed = yaml.replace("      - note.DIKM_단계:\n", '      - "note.DIKM_단계:"\n');
  const lines = fixed.split("\n");
  for (let index = 0; index < lines.length; index++) { if (index) await wd.press(KEY.enter); if (lines[index]) await wd.sendKeys(source, lines[index]!); }
  await clickText('[role="dialog"] button', "보기 확인");
  const preview = await wd.execute<{ enabled: number; disabled: number; issue: string }>(`return {enabled:document.querySelectorAll('.base-import-entry input:enabled').length,disabled:document.querySelectorAll('.base-import-entry input:disabled').length,issue:document.querySelector('.base-import-entry .base-issue')?.textContent || ''};`);
  ctx.report.check(S, "가져오기에서 지원되는 보기와 지원하지 않는 수식 구분", preview.enabled === 1 && preview.disabled === 1 && preview.issue.includes("formula"), JSON.stringify(preview), await shot(ctx, "4-import-preview.png"));
  await clickText('[role="dialog"] button', "선택한 보기 추가");
  const shown = await until(() => wd.execute<boolean>(`return !!document.querySelector('.projects-table [data-work="${workId}"]') && !document.querySelector('.projects-table [data-work="${other.id}"]');`));
  ctx.report.check(S, "가져온 필터로 실제 프로젝트 노트 행을 구분", shown, undefined, await shot(ctx, "4-import-filtered.png"));
  const stored = await until(async () => {
    const snapshot = await api<{ prefs: { homeViews?: { modes: { projects: { views: { name: string; baseFilters?: unknown }[] } } } } }>("GET", "/api/snapshot");
    return Boolean(snapshot.prefs.homeViews?.modes.projects.views.find((view) => view.name === "가져온 검증 보기")?.baseFilters);
  });
  await wd.refresh();
  const restored = await until(() => wd.execute<boolean>(`return !!document.querySelector('.projects-table [data-work="${workId}"]') && !document.querySelector('.projects-table [data-work="${other.id}"]');`));
  ctx.report.check(S, "보기·필터를 저장하고 새로 열어 복원", stored && restored);
  await wd.click(await wd.waitFor('.view-add[aria-label="보기 더하기"]'));
  await clickText(".view-add-pop button", "현재 보기 .base로 내보내기…");
  const exported = await wd.waitFor('textarea[aria-label="Bases YAML"]');
  const text = await wd.execute<string>("return arguments[0].value;", exported);
  await sleep(250); // Let the existing modal opening transition finish for the visual artifact.
  const path = join(ctx.stage.root, "native-export.base");
  await api("POST", "/api/projects/bases/export", { path, source: text });
  const reimported = importBase(readFileSync(path, "utf8"));
  ctx.report.check(S, "내보내기 미리보기·새 .base 저장 API·재가져오기", text.includes("workbench:") && !!reimported.entries[0]?.view?.baseFilters && readFileSync(path, "utf8") === text, "OS 저장 대화상자 선택 자체는 이 검사 범위 밖입니다.", await shot(ctx, "4-export-preview.png"));
  await clickText('[role="dialog"] button', "닫기");
  ctx.report.check(S, "Bases 검사 중 페이지 예외 없음", !(await pageErrors(wd)).length);
}
