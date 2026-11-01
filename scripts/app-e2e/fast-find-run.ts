// Installed Tauri/WebKitGTK search acceptance. No hosted model, user vault or user profile.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SearchPage, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { openStage } from "./launch.ts";
import { Report } from "./report.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

const binary = resolve(process.argv[2]!), output = resolve(process.argv[3]!);
mkdirSync(output, { recursive: true });
const report = new Report(output), stage = await openStage(output);
const S = "설치본 Fast Find", vault = join(stage.root, "search-vault");
mkdirSync(join(vault, ".obsidian/plugins/notebook-navigator"), { recursive: true });
mkdirSync(join(vault, "비밀"), { recursive: true });
writeFileSync(join(vault, ".obsidian/app.json"), "{}");
writeFileSync(join(vault, ".obsidian/plugins/notebook-navigator/data.json"), JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["비밀"] }] }));
const original = '---\ntitle: 가을 연구 메모\naliases: [발표자료]\n"단계:": A\n---\n# 연구 배경\n\n' + "일반 배경 문단입니다.\n\n".repeat(60) + '## 📝 해바라기 분석\n\n나비정원 검토를 끝냈습니다.\n';
writeFileSync(join(vault, "가을.md"), original);
writeFileSync(join(vault, "가을 사본.md"), '---\ntitle: 가을 연구 메모\n"단계:": B\n---\n관련 노트입니다.');
writeFileSync(join(vault, "비밀/숨김.md"), '---\ntitle: 가을 연구 메모\n---\n숨김고유표식');
let ctx: Ctx | null = null;
try {
  ctx = { stage, app: await stage.launch({ binary, engines: "stand-in", name: "fast-find", window: { width: 1440, height: 1000 } }), report };
  const { api, wd } = ctx.app, snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  await wd.click(await wd.waitFor(".onboarding-actions button", 30_000));
  if (!await until(async () => (await snapshot()).prefs.onboarding === "done")) throw Error("Onboarding did not finish");
  const work = await api<Work>("POST", "/api/works", { title: "검색 확인", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "검색 대화" });
  await api("POST", `/api/sessions/${session.id}/messages`, { requestId: "fast-find-native", text: "별빛해설을 정리해 줘" });
  if (!await until(async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items.some(item => item.kind === "turnEnd"), 20_000)) throw Error("Fixture turn did not end");
  await api("PUT", "/api/pkm/vault", { path: vault });
  const tab = { id: "find-main", workId: work.id, sessionId: session.id, view: { kind: "work" } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, sidebar: true, paneLayout: { version: 2, focus: "find-pane", panes: [{ ...tab, id: "find-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.refresh(); await installProbe(wd); await wd.waitFor(".sidebar", 30_000);
  const control = (key: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: key }, { type: "keyUp", value: key }, { type: "keyUp", value: KEY.control }]);
  const search = async (query: string) => {
    if (!await wd.find(".palette")) await control("k");
    const input = await wd.waitFor('input[aria-label="찾을 말"]');
    await wd.click(input); await control("a"); await wd.sendKeys(input, query);
    if (!await until(() => wd.execute<boolean>('return document.querySelector(".search-summary")?.dataset.searchQuery === arguments[0] && document.querySelector(".palette-list")?.getAttribute("aria-busy") === "false";', query), 15_000)) throw Error(`Search not shown: ${query}`);
  };
  await search("나비정원");
  await wd.waitFor(".search-source mark", 10_000);
  const page = await api<SearchPage>("GET", "/api/search?q=나비정원&legacy=0");
  report.check(S, "내장 native 엔진 결과와 본문 강조", page.engine === "fast-find" && page.total === 1 && await wd.execute<boolean>('return document.querySelector(".search-source")?.textContent.includes("나비정원") === true'), undefined, await shot(ctx, "search-preview.png"));
  report.check(S, "제목 기반 관련 노트와 숨김 제외", await wd.execute<boolean>('return document.querySelector(".search-related")?.textContent.includes("가을 연구 메모") === true') && (await api<SearchPage>("GET", "/api/search?q=숨김고유표식")).total === 0);
  await wd.click(await wd.waitFor(".palette-entry.kind-note"));
  await wd.waitFor(".pkm-note-body .search-open-target", 10_000);
  report.check(S, "검색한 노트의 정확한 문단 열기", await wd.execute<boolean>('return document.querySelector(".pkm-note-body .search-open-target")?.textContent.includes("나비정원") === true'), undefined, await shot(ctx, "note-location.png"));
  await search("별빛해설");
  const hits = (await api<SearchPage>("GET", "/api/search?q=별빛해설&legacy=0")).groups.flatMap(group => group.hits);
  const user = hits.find(hit => hit.kind === "user");
  await wd.click(await wd.waitFor(".palette-entry.kind-hit"));
  report.check(S, "세션 검색에서 정확한 원본 요청으로 이동", !!user?.itemId && await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-item-id].flash")].some(el => el.dataset.itemId === arguments[0]);', user!.itemId)), undefined, await shot(ctx, "message-location.png"));
  writeFileSync(join(vault, "가을.md"), original + "\n새로운달맞이 확인\n");
  await search("새로운달맞이");
  if (!await until(async () => (await api<SearchPage>("GET", "/api/search?q=새로운달맞이")).total === 1)) throw Error("External change not indexed");
  renameSync(join(vault, "가을.md"), join(vault, "이름변경.md"));
  const renamed = await until(async () => (await api<SearchPage>("GET", "/api/search?q=새로운달맞이")).groups.flatMap(group => group.hits).some(hit => hit.path === "이름변경.md"));
  await search("달맞이");
  report.check(S, "외부 저장과 이름 변경이 결과·열기에 반영", renamed && readFileSync(join(vault, "이름변경.md"), "utf8") === original + "\n새로운달맞이 확인\n", undefined, await shot(ctx, "external-change.png"));
  report.check(S, "원본 숨김 파일 보존·페이지 오류 없음", readFileSync(join(vault, "비밀/숨김.md"), "utf8").endsWith("숨김고유표식") && (await pageErrors(wd)).length === 0);
} catch (error) {
  report.check(S, "설치 앱 시나리오", false, String(error));
  if (ctx) { writeFileSync(report.path("failure.json"), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null, page: await ctx.app.wd.execute('return document.body.innerText').catch(() => null) }, null, 2)); await shot(ctx, "failure.png").catch(() => {}); }
} finally {
  await stage.close(); report.write({ binary, modelCalls: 0, source: "installed Tauri app and native Fast Find worker; private synthetic session/vault" }); console.log(report.summary()); if (report.steps.some(row => !row.ok)) process.exitCode = 1;
}
