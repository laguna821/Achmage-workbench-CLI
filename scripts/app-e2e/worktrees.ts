import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, Snapshot, Work, WorktreeCreation } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { installProbe, pageErrors, record, recorded, savedLayout, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

export async function worktreesScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "13 Git 워크트리";
  let wd = ctx.app.wd;
  const root = join(ctx.stage.root, "Git 원본"), external = join(ctx.stage.root, "외부 워크트리"); mkdirSync(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Native test", "-c", "user.email=native@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "-q", "-b", "main"); writeFileSync(join(root, "내용.md"), "기준 판\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD"); git(root, "tag", "starting");
  writeFileSync(join(root, "내용.md"), "새 커밋\n"); git(root, "commit", "-qam", "next");
  git(root, "worktree", "add", "-b", "existing", external);
  writeFileSync(join(root, "내용.md"), "원본의 미커밋 수정\n"); writeFileSync(join(external, "보존.txt"), "외부 파일 보존\n");
  const work = await ctx.app.api<Work>("POST", "/api/works", { title: "Git 공간 검사", cwd: root });
  const first = await ctx.app.api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const snapshot = () => ctx.app.api<Snapshot>("GET", "/api/snapshot");
  const jobs = () => ctx.app.api<WorktreeCreation[]>("GET", `/api/works/${work.id}/worktree-creations`);
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: work.id, sessionId: first.id, view: { kind: "work" } }] } });
  await wd.refresh(); await wd.waitFor('.workspace-trigger'); await installProbe(wd); await record(wd);
  const textButton = async (selector: string, text: string) => {
    for (const button of await wd.findAll(selector)) if ((await wd.execute<string>('return arguments[0].textContent;', button)).trim() === text) {
      await wd.execute('arguments[0].scrollIntoView({block:"center"});', button); await wd.click(button); return;
    }
    throw new Error(`Button not found: ${text}`);
  };
  const management = async () => { await wd.click(await wd.waitFor('.workspace-trigger')); await wd.click(await wd.waitFor('.workspace-git-open')); await wd.waitFor('.worktree-row'); };
  const input = async (label: string, value: string) => {
    const field = await wd.waitFor(`[aria-label="${label}"]`); await wd.click(field);
    await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
    await wd.sendKeys(field, value);
  };
  await management();
  ctx.report.check(S, "실제 Git 목록에 기본·외부 워크트리가 표시", (await wd.findAll('.worktree-row')).length === 2, undefined, await shot(ctx, "13-discovery.png"));
  await wd.click(await wd.waitFor(`[data-worktree-path="${external}"]`));
  const connected = await until(async () => ((await snapshot()).workspaces ?? []).some((space) => space.cwd === external && !space.managed));
  const linked = ((await snapshot()).workspaces ?? []).find((space) => space.cwd === external)!;
  await until(async () => (await snapshot()).sessions.some((session) => session.workspaceId === linked.id));
  ctx.report.check(S, "기존 워크트리 연결·새 세션·외부 파일 보존", connected && readFileSync(join(external, "보존.txt"), "utf8") === "외부 파일 보존\n" && (await recorded(wd)).trusted, undefined, await shot(ctx, "13-external-connected.png"));
  await wd.click(await wd.waitFor('.worktree-chip button')); await wd.waitFor('.worktree-review');
  ctx.report.check(S, "외부에서 연결한 워크트리는 실제 삭제 버튼 비활성", await wd.execute<boolean>('return document.querySelector(".worktree-foot .danger").disabled;'), undefined, await shot(ctx, "13-external-protected.png"));
  await textButton('.worktree-foot button', "닫기");
  await wd.click(await wd.waitFor('.workspace-trigger')); await wd.click(await wd.waitFor(`[data-workspace-id="${work.defaultWorkspaceId}"]`));
  await until(async () => (await snapshot()).prefs.layoutScope === work.defaultWorkspaceId);
  await management(); await textButton('.worktree-tabs button', "새 워크트리");
  await input("새 워크트리 이름", "기준 판에서 새 작업"); await input("새 워크트리 브랜치", "main"); await input("워크트리 기준 ref", "refs/tags/starting");
  await wd.click(await wd.waitFor('.worktree-create button[type="submit"]'));
  const rejected = await until(async () => (await jobs()).some((job) => job.phase === "failed"), 30_000);
  await wd.waitFor('.worktree-job[data-phase="failed"]');
  ctx.report.check(S, "기존 브랜치 충돌은 생성 실패로 남기고 원본 유지", rejected && readFileSync(join(root, "내용.md"), "utf8") === "원본의 미커밋 수정\n", undefined, await shot(ctx, "13-branch-conflict.png"));
  await textButton('.worktree-tabs button', "새 워크트리"); await input("새 워크트리 브랜치", "feature/native");
  await wd.click(await wd.waitFor('.worktree-create button[type="submit"]'));
  const created = await until(async () => (await jobs()).some((job) => job.phase === "ready"), 30_000);
  const job = (await jobs()).find((item) => item.phase === "ready")!;
  if (!created || !job?.workspaceId) throw new Error("Worktree was not created");
  const space = ((await snapshot()).workspaces ?? []).find((item) => item.id === job.workspaceId)!;
  await wd.waitFor('.worktree-job[data-phase="ready"] button');
  ctx.report.check(S, "선택한 기준 커밋과 브랜치로 독립 작업공간 생성", job.base === base && git(space.cwd, "branch", "--show-current") === "feature/native" && readFileSync(join(space.cwd, "내용.md"), "utf8") === "기준 판\n" && space.parentWorkspaceId === work.defaultWorkspaceId, undefined, await shot(ctx, "13-created.png"));
  await wd.click(await wd.waitFor('.worktree-job[data-phase="ready"] button'));
  await until(async () => (await snapshot()).sessions.some((session) => session.workspaceId === space.id));
  const firstInSpace = (await snapshot()).sessions.find((session) => session.workspaceId === space.id)!;
  const provider = firstInSpace.provider === "claude" ? "Claude" : "Codex";
  for (const button of await wd.findAll('.work-view .select-button')) if ((await wd.execute<string>('return arguments[0].textContent;', button)).includes(`${provider} ·`)) { await wd.click(button); break; }
  await wd.waitFor('.popover [role="menuitem"]');
  await textButton('.popover button', firstInSpace.provider === "claude" ? "새 Codex 세션" : "새 Claude 세션");
  const shared = await until(async () => (await snapshot()).sessions.filter((session) => session.workspaceId === space.id).length === 2);
  const secondInSpace = (await snapshot()).sessions.find((session) => session.workspaceId === space.id && session.id !== firstInSpace.id)!;
  ctx.report.check(S, "같은 워크트리에 두 세션이 공유되고 원본 cwd는 유지", shared && secondInSpace.worktree?.cwd === space.cwd && (await snapshot()).works.find((item) => item.id === work.id)?.cwd === root && readFileSync(join(root, "내용.md"), "utf8") === "원본의 미커밋 수정\n", undefined, await shot(ctx, "13-shared-sessions.png"));
  await until(async () => JSON.stringify((await savedLayout(ctx, space.id))?.layout).includes(secondInSpace.id));
  ctx.report.check(S, "워크트리 작업 중 페이지 예외 없음", !(await pageErrors(wd)).length);
  await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "worktrees-restarted", freshPort: true }); wd = ctx.app.wd;
  await wd.waitFor('.workspace-trigger');
  const restored = await snapshot();
  ctx.report.check(S, "새 포트로 앱 재시작 후 작업공간·세션·생성 기록 복원", restored.prefs.layoutScope === space.id && JSON.stringify((await savedLayout(ctx, space.id))?.layout).includes(secondInSpace.id) && (await jobs()).find((item) => item.id === job.id)?.workspaceId === space.id && restored.sessions.filter((session) => session.workspaceId === space.id).length === 2, undefined, await shot(ctx, "13-restarted.png"));
  const alias = await ctx.app.api<Work>("POST", "/api/works", { title: "같은 워크트리 연결", cwd: space.cwd });
  await wd.click(await wd.waitFor('.worktree-chip button')); await wd.waitFor('.worktree-review');
  await wd.click(await wd.waitFor('.worktree-foot .danger')); await wd.waitFor('.worktree-confirm');
  ctx.report.check(S, "삭제 전 실제 대상 폴더를 확인하고 아직 파일 보존", existsSync(space.cwd) && await wd.execute<boolean>('return document.querySelector(".worktree-confirm").textContent.includes(arguments[0]);', space.cwd), undefined, await shot(ctx, "13-delete-confirm.png"));
  await textButton('.worktree-confirm button', "폴더 삭제");
  const removed = await until(async () => ((await snapshot()).workspaces ?? []).find((item) => item.id === space.id)?.removedAt != null);
  const final = await snapshot();
  ctx.report.check(S, "확인 후 실제 제거·다른 프로젝트 연결 보관·원본과 외부 파일 보존", removed && !existsSync(space.cwd) && final.workspaces?.find((item) => item.id === alias.defaultWorkspaceId)?.removedAt != null && final.sessions.filter((item) => item.workspaceId === space.id).every((item) => item.archivedAt != null) && readFileSync(join(root, "내용.md"), "utf8") === "원본의 미커밋 수정\n" && readFileSync(join(external, "보존.txt"), "utf8") === "외부 파일 보존\n", undefined, await shot(ctx, "13-removed.png"));
  writeFileSync(join(ctx.stage.outDir, "worktree-creations.json"), JSON.stringify(await jobs(), null, 2));
}
