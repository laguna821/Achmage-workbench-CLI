import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { PreparationJob, Session, Snapshot, TerminalList, Work, WorktreeCreation } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { installProbe, pageErrors, record, recorded, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

export async function preparationScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "15 워크트리 환경 준비";
  let wd = ctx.app.wd; await wd.setWindowRect({ width: 1500, height: 1000 });
  const root = join(ctx.stage.root, "환경 원본"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Native test", "-c", "user.email=native@example.invalid", ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".env\n.cache/\n*.local\n");
  writeFileSync(join(root, "orca.yaml"), stringify({
    scripts: { setup: 'printf "run\\n" >> runs.local; printf "%s\\n" "$ORCA_ROOT_PATH" "$ORCA_WORKTREE_PATH" > roots.local; printf "준비 완료\\n"', archive: 'printf "보관 실패 검사\\n"; exit 7' },
    worktree: { sharedDirectories: [".cache"] },
    defaultTabs: [{ title: "기본 명령", command: 'printf "기본 탭 완료\\n" > default.local; cat default.local', color: "#4aa" }, { title: "작업 셸" }],
  }));
  writeFileSync(join(root, ".worktreeinclude"), ".env\n"); git("add", "."); git("commit", "-qm", "fixture");
  mkdirSync(join(root, ".cache")); writeFileSync(join(root, ".cache/value"), "shared");
  writeFileSync(join(root, ".env"), "fake before");
  const work = await ctx.app.api<Work>("POST", "/api/works", { title: "환경 준비 검사", cwd: root });
  await ctx.app.api("POST", "/api/works/" + work.id + "/worktree-creations", { requestId: randomUUID(), sourceWorkspaceId: work.defaultWorkspaceId, label: "환경 feature", branch: "feature/preparation", baseRef: "HEAD" });
  const creationList = () => ctx.app.api<WorktreeCreation[]>("GET", "/api/works/" + work.id + "/worktree-creations");
  await until(async () => (await creationList()).some((job) => job.phase === "ready"));
  const creation = (await creationList()).find((job) => job.phase === "ready")!;
  const snapshot = () => ctx.app.api<Snapshot>("GET", "/api/snapshot");
  const workspace = (await snapshot()).workspaces!.find((space) => space.id === creation.workspaceId)!;
  const session = await ctx.app.api<Session>("POST", "/api/works/" + work.id + "/sessions", { provider: "codex", workspaceId: workspace.id });
  const jobs = () => ctx.app.api<{ jobs: PreparationJob[] }>("GET", "/api/workspaces/" + workspace.id + "/preparations").then((result) => result.jobs);
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: work.id, sessionId: session.id, view: { kind: "work" } }] } });
  await wd.refresh(); await wd.waitFor(".workspace-trigger"); await installProbe(wd); await record(wd);
  const click = async (selector: string) => {
    const element = await wd.waitFor(selector); await wd.execute('arguments[0].scrollIntoView({block:"center"});', element); await wd.click(element);
  };
  const clickText = async (selector: string, text: string, contains = false) => {
    for (const element of await wd.findAll(selector)) {
      const label = (await wd.execute<string>("return arguments[0].textContent;", element)).trim();
      if (contains ? label.includes(text) : label === text) { await wd.execute('arguments[0].scrollIntoView({block:"center"});', element); await wd.click(element); return; }
    }
    throw new Error("Button not found: " + text);
  };
  const open = async () => { await click(".workspace-trigger"); await click(".workspace-preparation-open"); await wd.waitFor(".preparation-dialog"); };
  await open(); await click(".preparation-preview-button"); await wd.waitFor(".preparation-preview");
  ctx.report.check(S, "실제 미리보기에서 복사·공유·정확한 명령을 표시하고 실행 전 파일 불변", !existsSync(join(workspace.cwd, ".env")) && !existsSync(join(workspace.cwd, "runs.local")) && await wd.execute<boolean>('return document.querySelector(".preparation-preview").textContent.includes("공유 링크") && document.querySelector(".preparation-script").textContent.includes("ORCA_WORKTREE_PATH");'), undefined, await shot(ctx, "15-preparation-preview.png"));
  writeFileSync(join(root, ".env"), "fake changed");
  await click(".preparation-apply");
  const stale = await until(async () => wd.execute<boolean>('return document.querySelector(".preparation-error")?.textContent.includes("미리보기 뒤") === true;'));
  ctx.report.check(S, "미리보기 뒤 원본 변경은 적용 전에 거절", stale && !existsSync(join(workspace.cwd, ".env")) && (await jobs()).length === 0, undefined, await shot(ctx, "15-preparation-stale.png"));
  await click(".preparation-preview-button"); await wd.waitFor(".preparation-preview"); await click(".preparation-apply");
  const done = await until(async () => (await jobs()).some((job) => job.phase === "complete"), 30_000);
  const prepared = (await jobs()).find((job) => job.phase === "complete")!;
  if (!done || !prepared) throw new Error("Preparation did not complete");
  const tabs = await until(async () => (await wd.findAll('.pane:not([hidden]) .group-tab [role="tab"]')).length >= 4 && !(await wd.findAll(".preparation-dialog")).length);
  ctx.report.check(S, "실제 PTY 준비·기본 터미널 생성 후 공통 탭으로 열기", tabs && prepared.terminalIds.length === 3 && readFileSync(join(workspace.cwd, "runs.local"), "utf8") === "run\n" && readFileSync(join(workspace.cwd, "roots.local"), "utf8") === root + "\n" + workspace.cwd + "\n" && (await recorded(wd)).trusted, undefined, await shot(ctx, "15-preparation-tabs.png"));
  const isolated = readFileSync(join(workspace.cwd, ".env"), "utf8") === "fake changed";
  writeFileSync(join(workspace.cwd, ".env"), "workspace edit");
  ctx.report.check(S, "독립 사본 수정은 원본을 보존하고 공유 디렉터리는 같은 실제 경로", isolated && readFileSync(join(root, ".env"), "utf8") === "fake changed" && realpathSync(join(workspace.cwd, ".cache")) === join(root, ".cache"));
  await clickText('.pane:not([hidden]) .group-tab [role="tab"]', "환경 준비");
  await wd.waitFor('.terminal-view[data-terminal-id="' + prepared.hookTerminalId + '"][data-terminal-ready="true"]');
  ctx.report.check(S, "준비 출력은 실제 터미널에서 한글로 조회", await until(async () => wd.execute<boolean>('return [...document.querySelectorAll(".terminal-view .xterm-accessibility-tree > div")].some(node => node.textContent.trim() === "준비 완료");')), undefined, await shot(ctx, "15-preparation-output.png"));
  const terminalList = await ctx.app.api<TerminalList>("GET", "/api/workspaces/" + workspace.id + "/terminals");
  for (const terminal of terminalList.terminals) if (terminal.status === "running") await ctx.app.api("DELETE", "/api/terminals/" + terminal.id);
  await clickText('.pane:not([hidden]) .group-tab [role="tab"]', "환경 준비 검사", true);
  await open(); await click('[aria-label="환경 준비 종류"] option[value="archive"]');
  await click(".preparation-preview-button"); await wd.waitFor(".preparation-preview"); await click(".preparation-apply");
  const failed = await until(async () => (await jobs()).some((job) => job.preview.options.kind === "archive" && job.phase === "failed"));
  await wd.waitFor('.preparation-job[data-phase="failed"]');
  ctx.report.check(S, "보관 명령의 실제 종료 코드 실패를 기록하고 폴더 유지", failed && existsSync(workspace.cwd), undefined, await shot(ctx, "15-archive-failed.png"));
  await clickText(".preparation-dialog > header button", "닫기");
  await click(".workspace-trigger"); await click('[aria-label="환경 feature 보관"]');
  const blocked = await until(async () => wd.execute<boolean>('return document.body.textContent.includes("보관 명령을 먼저 확인하세요");'));
  ctx.report.check(S, "실패한 보관 명령은 보관 동작을 차단", blocked && (await snapshot()).workspaces!.find((space) => space.id === workspace.id)!.archivedAt === null);
  await click(".workspace-preparation-open"); await wd.waitFor(".preparation-dialog");
  await click('[aria-label="환경 준비 종류"] option[value="archive"]'); await click('[aria-label="준비 명령 실행"]');
  await click(".preparation-preview-button"); await wd.waitFor(".preparation-preview"); await click(".preparation-apply");
  const skipped = await until(async () => (await jobs()).some((job) => job.preview.options.kind === "archive" && !job.preview.options.runCommands && job.phase === "complete"));
  await clickText(".preparation-dialog > header button", "닫기"); await click(".workspace-trigger"); await click('[aria-label="환경 feature 보관"]');
  const archived = await until(async () => (await snapshot()).workspaces!.find((space) => space.id === workspace.id)!.archivedAt !== null);
  ctx.report.check(S, "명시적 명령 건너뛰기 후 보관·원본과 작업 파일 유지", skipped && archived && existsSync(workspace.cwd) && readFileSync(join(workspace.cwd, ".env"), "utf8") === "workspace edit" && readFileSync(join(root, ".env"), "utf8") === "fake changed", undefined, await shot(ctx, "15-archive-skipped.png"));
  const errors = await pageErrors(wd), count = (await jobs()).length;
  await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "preparation-restarted", freshPort: true, window: { width: 1500, height: 1000 } }); wd = ctx.app.wd;
  await wd.waitFor(".workspace-trigger"); await open(); await wd.waitFor(".preparation-job");
  ctx.report.check(S, "앱 재시작은 준비 기록·탭을 복원하고 명령을 다시 실행하지 않음", (await jobs()).length === count && readFileSync(join(workspace.cwd, "runs.local"), "utf8") === "run\n" && (await wd.findAll(".preparation-job")).length === count, undefined, await shot(ctx, "15-preparation-restarted.png"));
  ctx.report.check(S, "환경 준비 중 페이지 예외 없음", errors.length === 0 && (await pageErrors(wd)).length === 0);
  writeFileSync(join(ctx.stage.outDir, "preparations.json"), JSON.stringify(await jobs(), null, 2));
}
