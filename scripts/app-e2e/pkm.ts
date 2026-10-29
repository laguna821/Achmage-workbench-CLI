import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { center, KEY } from "./webdriver.ts";
import { installProbe, pageErrors, record, recorded, shot, until, type Ctx } from "./scenarios.ts";

/** Only temporary gateway data and fixture files; all actions under test use native WebDriver input. */
export async function pkmScenario(ctx: Ctx) {
  const S = "3 프로젝트 노트";
  const { wd, api } = ctx.app;
  const folder = await api<{ id: string }>("POST", "/api/folders", { name: "템플릿 검사", parentId: null });
  const child = await api<{ id: string }>("POST", "/api/folders", { name: "하위 분류", parentId: folder.id });
  const work = await api<{ id: string; cwd: string }>("POST", "/api/works", { title: "표지가 있는 프로젝트", folderId: child.id, cwd: null });
  writeFileSync(join(work.cwd, "cover.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#087e8b"/><circle cx="160" cy="90" r="48" fill="#d6f5ee"/></svg>');
  const { prefs } = await api<{ prefs: Record<string, unknown> }>("GET", "/api/snapshot");
  await api("PUT", "/api/prefs", { prefs: { ...prefs, paneLayout: null, navigator: { layout: "dual", selected: { kind: "root" }, includeSub: true, density: "standard" } } });
  await wd.refresh();
  await wd.waitFor(".sidebar");
  await installProbe(wd);
  const clickText = async (selector: string, text: string) => {
    const found = await until(async () => {
      for (const element of await wd.findAll(selector)) {
        const label = await wd.execute<string>('return (arguments[0].querySelector(".context-menu-text") || arguments[0]).textContent;', element);
        if (label.trim() === text) { await wd.click(element); return true; }
      }
      return false;
    });
    if (!found) {
      await shot(ctx, "3-missing-action.png");
      const diagnostic = await wd.execute(`return {menus:[...document.querySelectorAll('[role="menu"]')].map(x=>x.innerText), dialogs:[...document.querySelectorAll('[role="dialog"]')].map(x=>x.innerText), events:window.__e2e?.events.slice(-12)};`);
      ctx.report.note(S, JSON.stringify(diagnostic));
      throw new Error(`Missing action: ${text}`);
    }
  };
  const row = await wd.waitFor(`.nav-folder-tree [data-row-id="${folder.id}"]`);
  const at = center(await wd.rect(row));
  await record(wd);
  await wd.pointer([{ type: "pointerMove", ...at }, { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 }]);
  await wd.releaseActions();
  await clickText('[role="menuitem"]', "폴더 노트 템플릿…");
  const source = await wd.waitFor('textarea[aria-label="노트 템플릿 마크다운"]');
  const template = '---\n"DIKM_단계:": "I"\ntags: [검증]\ncover: ./cover.svg\n---\n# 폴더에서 온 노트\n\n원문과 속성을 함께 시작합니다.\n';
  const lines = template.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (index) await wd.press(KEY.enter);
    if (lines[index]) await wd.sendKeys(source, lines[index]!);
  }
  await clickText('[role="dialog"] button', "이 폴더에 저장");
  await until(async () => (await api<{ own: string }>("GET", `/api/projects/folder-templates/${folder.id}`)).own === template);
  const saved = await api<{ own: string }>("GET", `/api/projects/folder-templates/${folder.id}`);
  const events = await recorded(wd);
  ctx.report.check(S, "폴더 메뉴에서 실제 입력으로 템플릿 저장", saved.own === template && events.trusted, JSON.stringify({ saved: saved.own, trusted: events.trusted }), await shot(ctx, "3-template-saved.png"));

  const workRow = await wd.waitFor(`.nav-project[data-row-id="${work.id}"]`);
  const workAt = center(await wd.rect(workRow));
  await wd.pointer([{ type: "pointerMove", ...workAt }, { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 }]);
  await wd.releaseActions();
  await clickText('[role="menuitem"]', "프로젝트 페이지");
  await clickText(".project-empty button", "템플릿으로 노트 만들기");
  const copied = await until(() => wd.execute<boolean>('return document.querySelector(".project-note-body")?.textContent.includes("원문과 속성을 함께 시작합니다.") === true;'));
  const page = await api<{ note: { path: string; properties: [string, string[]][] } }>("GET", `/api/projects/${work.id}`);
  const original = readFileSync(page.note.path, "utf8");
  ctx.report.check(S, "상위 폴더 템플릿을 하위 프로젝트 새 노트에 복사", copied && original.includes('"DIKM_단계:": "I"') && original.includes("tags: [검증]") && original.includes("workbench_id:"), undefined, await shot(ctx, "3-template-note.png"));
  const selector = `.nav-project[data-row-id="${work.id}"] .project-thumbnail img`;
  const picture = await until(() => wd.execute<boolean>(`const img=document.querySelector(arguments[0]); return !!img && img.complete && img.naturalWidth > 0;`, selector));
  ctx.report.check(S, "내비게이터에 인증된 로컬 표지 이미지 표시", picture, undefined, await shot(ctx, "3-project-thumbnail.png"));
  await api("PUT", `/api/projects/folder-templates/${folder.id}`, { markdown: "# 다음 프로젝트부터 적용\n" });
  ctx.report.check(S, "템플릿 변경 후 기존 노트 원문 보존", readFileSync(page.note.path, "utf8") === original);
  ctx.report.check(S, "프로젝트 노트 검사 중 페이지 예외 없음", !(await pageErrors(wd)).length, JSON.stringify(await pageErrors(wd)));
}
