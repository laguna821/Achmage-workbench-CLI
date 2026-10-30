import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScmJob, ScmStatus, Session, Snapshot, Work } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { installProbe, pageErrors, record, recorded, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

export async function scmConflictScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "18 Git 충돌 해결"; let wd = ctx.app.wd;
  await wd.setWindowRect({ width: 1500, height: 1100 });
  const root = join(ctx.stage.root, "Git 충돌 폴더"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", "-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Native Test"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "한글.md"), "기준 문서\n"); git("add", "."); git("commit", "-qm", "base");
  git("switch", "-qc", "other"); writeFileSync(join(root, "한글.md"), "가져온 문서\n"); git("commit", "-qam", "other");
  git("switch", "main"); writeFileSync(join(root, "한글.md"), "현재 문서\n"); git("commit", "-qam", "main"); const ours = git("rev-parse", "HEAD");
  try { git("merge", "other", "--no-edit"); } catch { /* Expected real conflict. */ }
  const work = await ctx.app.api<Work>("POST", "/api/works", { title: "충돌 해결 검사", cwd: root }), id = work.defaultWorkspaceId!;
  const session = await ctx.app.api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const snapshot = () => ctx.app.api<Snapshot>("GET", "/api/snapshot"), status = () => ctx.app.api<ScmStatus>("GET", `/api/workspaces/${id}/scm`);
  const jobs = () => ctx.app.api<{ jobs: ScmJob[] }>("GET", `/api/workspaces/${id}/scm/jobs`).then((result) => result.jobs);
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: work.id, sessionId: session.id, view: { kind: "work" } }] } });
  await wd.refresh(); await wd.waitFor(".workspace-trigger"); await installProbe(wd); await record(wd);
  const click = async (selector: string) => { const element = await wd.waitFor(selector); await wd.execute('arguments[0].scrollIntoView({block:"center"});', element); await wd.click(element); };
  const open = async () => { await click(".workspace-trigger"); await click(".workspace-scm-open"); await wd.waitFor(".scm-refresh"); };
  const review = async () => { await click('.scm-file-select[data-area="working"][data-path="한글.md"]'); await wd.waitFor("#scm-conflict-result"); };
  const replace = async (value: string) => { await click("#scm-conflict-result"); const field = await wd.waitFor("#scm-conflict-result"); await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]); const lines = value.split("\n"); for (let i = 0; i < lines.length; i++) { if (lines[i]) await wd.sendKeys(field, lines[i]!); if (i < lines.length - 1) await wd.press(KEY.enter); } };
  const settled = async (count: number) => until(async () => (await jobs()).length === count && (await jobs())[0]?.phase === "complete" && await wd.execute<boolean>('return !document.querySelector(".scm-refresh").disabled;'));
  await open(); await review();
  ctx.report.check(S, "실제 3방향 버전·충돌 표식·계속 및 스테이징 차단", await wd.execute<boolean>('return document.querySelector(".scm-conflict-versions").textContent.includes("기준 문서") && document.querySelector(".scm-conflict-versions").textContent.includes("가져온 문서") && document.querySelector(".scm-continue").disabled && document.querySelector(".scm-stage-resolution").disabled;') && (await recorded(wd)).trusted, undefined, await shot(ctx, "18-conflict-three-way.png"));
  await replace("두 쪽을 통합한 초안\n"); await click(".scm-close"); await open(); await review();
  ctx.report.check(S, "닫았다 열어도 해결 초안 보관·디스크 자동 저장 없음", await wd.execute<boolean>('return document.querySelector("#scm-conflict-result").value === "두 쪽을 통합한 초안\\n";') && readFileSync(join(root, "한글.md"), "utf8").includes("<<<<<<<"));
  writeFileSync(join(root, "한글.md"), "외부에서 수정한 해결\n"); await click(".scm-save-resolution");
  const stale = await until(async () => wd.execute<boolean>('return document.querySelector(".scm-error")?.textContent.includes("검토한 뒤") === true;'));
  ctx.report.check(S, "외부 변경을 덮어쓰지 않고 초안 유지", stale && (await jobs()).length === 0 && readFileSync(join(root, "한글.md"), "utf8") === "외부에서 수정한 해결\n");
  await click(".scm-refresh"); await wd.waitFor(".scm-adopt-draft"); await click(".scm-adopt-draft"); await click(".scm-save-resolution"); const saved = await settled(1);
  ctx.report.check(S, "최신 상태 확인 후 파일 저장·충돌 단계와 복구 사본 보존", saved && (await status()).files.some((file) => file.conflicted) && readFileSync(join(root, "한글.md"), "utf8") === "두 쪽을 통합한 초안\n" && readFileSync(join((await jobs())[0]!.recoveryPath!, "0.bin"), "utf8") === "외부에서 수정한 해결\n", undefined, await shot(ctx, "18-conflict-saved.png"));
  await wd.waitFor(".scm-stage-resolution"); await until(async () => wd.execute<boolean>('return !document.querySelector(".scm-stage-resolution").disabled;')); await click(".scm-stage-resolution"); const staged = await settled(2);
  ctx.report.check(S, "해결 완료 버튼으로 해당 파일만 스테이징", staged && !(await status()).files.some((file) => file.conflicted) && git("show", ":한글.md") === "두 쪽을 통합한 초안");
  await click(".scm-continue"); const continued = await settled(3);
  ctx.report.check(S, "병합 계속 후 실제 두 부모 커밋 생성", continued && (await status()).operation === null && git("show", "-s", "--format=%P", "HEAD").split(" ").length === 2, undefined, await shot(ctx, "18-conflict-continued.png"));
  // A new synthetic conflict checks explicit abort and durable recovery without touching the user's repo.
  git("switch", "-qc", "abort-main", ours); try { git("merge", "other", "--no-edit"); } catch { /* Expected. */ }
  writeFileSync(join(root, "한글.md"), "취소 전에 남긴 수작업\n"); await click(".scm-refresh"); await wd.waitFor(".scm-operation");
  await click(".scm-operation details summary");
  ctx.report.check(S, "작업 취소는 현재 변경 확인 전 실행 불가", await wd.execute<boolean>('return document.querySelector(".scm-abort").disabled;'));
  await click(".scm-abort-confirm"); await click(".scm-abort"); const aborted = await settled(4), abortJob = (await jobs())[0]!;
  ctx.report.check(S, "명시적 병합 취소·이전 HEAD 복원·수작업 복구 사본 보관", aborted && (await status()).operation === null && git("rev-parse", "HEAD") === ours && readFileSync(join(abortJob.recoveryPath!, "0.bin"), "utf8") === "취소 전에 남긴 수작업\n", undefined, await shot(ctx, "18-conflict-aborted.png"));
  await click(".scm-close"); try { git("rebase", "other"); } catch { /* Expected conflict. */ } await open(); await review();
  ctx.report.check(S, "재배치 충돌에서 ours/theirs 의미를 화면에 구분", await wd.execute<boolean>('return document.querySelector(".scm-conflict-versions").textContent.includes("재배치 대상") && document.querySelector(".scm-conflict-versions").textContent.includes("다시 적용할 커밋");'), undefined, await shot(ctx, "18-conflict-rebase.png"));
  await replace("재배치 양쪽 통합\n"); await click(".scm-stage-resolution"); await settled(5); await click(".scm-continue");
  ctx.report.check(S, "실제 화면에서 재배치 해결·스테이징·계속", await settled(6) && (await status()).operation === null && git("show", "HEAD:한글.md") === "재배치 양쪽 통합");
  const errors = await pageErrors(wd), head = git("rev-parse", "HEAD"); await click(".scm-close"); await ctx.app.close();
  ctx.app = await ctx.stage.launch({ ...launch, name: "conflict-restarted", freshPort: true, window: { width: 1500, height: 1100 } }); wd = ctx.app.wd;
  await wd.waitFor(".workspace-trigger"); await open();
  const historyRestored = await until(async () => wd.execute<boolean>('return document.querySelectorAll(".scm-history details").length === 6 && document.querySelector(".scm-history").textContent.includes("복구 파일");'));
  ctx.report.check(S, "재시작 후 해결·취소 기록과 복구 경로 유지·작업 재실행 없음", historyRestored && (await jobs()).length === 6 && git("rev-parse", "HEAD") === head, undefined, await shot(ctx, "18-conflict-restarted.png"));
  ctx.report.check(S, "충돌 해결 중 페이지 예외 없음", errors.length === 0 && (await pageErrors(wd)).length === 0);
  writeFileSync(join(ctx.stage.outDir, "conflict-jobs.json"), JSON.stringify(await jobs(), null, 2));
}
