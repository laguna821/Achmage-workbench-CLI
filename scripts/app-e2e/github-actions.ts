import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubActionJob, Session, Snapshot, Work } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { githubActionsFixture, type GitHubActionsFixture } from "../fixtures/github-actions.ts";
import { installProbe, pageErrors, record, recorded, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** Real native inputs, host SQLite, gh subprocess and Git; all remote writes are an isolated fixture. */
export async function githubActionsScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "GitHub PR 작업", root = join(ctx.stage.root, "github-actions-work"); mkdirSync(join(root, ".github"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-qb", "feature"); git("config", "user.name", "Native Fixture"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "code.txt"), "local fixture\n"); writeFileSync(join(root, ".github/PULL_REQUEST_TEMPLATE.md"), "## 검증\n- [ ] 확인한 동작\n"); git("add", "."); git("commit", "-qm", "base"); git("remote", "add", "origin", "git@github.com:worker/project.git");
  const head = git("rev-parse", "HEAD"), index = readFileSync(join(root, ".git/index")), bytes = readFileSync(join(root, "code.txt"));
  const fixturePath = join(ctx.stage.root, "github-actions.json"), shim = join(ctx.stage.root, "openers", "gh"), data = githubActionsFixture(head); data.empty = true; writeFileSync(fixturePath, JSON.stringify(data));
  const remote = () => JSON.parse(readFileSync(fixturePath, "utf8")) as GitHubActionsFixture;
  const moduleUrl = new URL("../fixtures/github-actions.ts", import.meta.url).href;
  writeFileSync(shim, `#!/usr/bin/env node\nimport { readFileSync, writeFileSync, renameSync } from 'node:fs';\nimport { githubActionsRead, githubActionsWrite } from ${JSON.stringify(moduleUrl)};\nconst args=process.argv.slice(2), endpoint=args.find(x=>x.startsWith('repos/')||x==='graphql'), method=args[args.indexOf('--method')+1], path=${JSON.stringify(fixturePath)};\ntry {\n if(args[0]!=='api'||args[args.indexOf('--hostname')+1]!=='github.com'||!endpoint) throw new Error('unexpected fixture command');\n const body=args.includes('--input')?JSON.parse(readFileSync(0,'utf8')):undefined, data=JSON.parse(readFileSync(path,'utf8'));\n const write=method!=='GET'&&!(endpoint==='graphql'&&body?.query?.startsWith('query'));\n const result=write?githubActionsWrite({method,endpoint,body},data):{status:200,value:githubActionsRead(endpoint,data,body)};\n if(write||endpoint.includes('/merge-async/')) { const tmp=path+'.'+process.pid+'.tmp'; writeFileSync(tmp,JSON.stringify(data)); renameSync(tmp,path); }\n process.stdout.write('HTTP/2.0 '+result.status+' OK\\r\\nX-Ratelimit-Remaining: 4000\\r\\n\\r\\n'+JSON.stringify(result.value));\n} catch(error) { process.stdout.write('HTTP/2.0 503 Unavailable\\r\\n\\r\\n'+JSON.stringify({message:error.message})); process.stderr.write(error.message); process.exitCode=1; }\n`); chmodSync(shim, 0o755);
  try {
    // This scenario replaces the fake remote universe, so discard the previous fixture's gh read cache.
    await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "github-actions-isolated", freshPort: true, window: { width: 1500, height: 1100 } });
    const work = await ctx.app.api<Work>("POST", "/api/works", { title: "GitHub 작성 검사", cwd: root }), id = work.defaultWorkspaceId!, session = await ctx.app.api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "PR lifecycle fixture" });
    const state = await ctx.app.api<Snapshot>("GET", "/api/snapshot"); await seedLayout(ctx, { ...state.prefs, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: work.id, sessionId: session.id, view: { kind: "work" } }] } });
    let wd = ctx.app.wd;
    const click = async (selector: string) => { const element = await wd.waitFor(selector); await wd.execute('arguments[0].scrollIntoView({block:"center"});', element); await wd.click(element); };
    const replace = async (selector: string, value: string) => { await click(selector); await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]); await wd.sendKeys(await wd.waitFor(selector), value); };
    const jobs = () => ctx.app.api<GitHubActionJob[]>("GET", `/api/workspaces/${id}/scm/github-actions`);
    const open = async () => { await click(".workspace-trigger"); await click(".workspace-scm-open"); await click(".scm-tab-github"); await wd.waitFor(".scm-gh-manage"); await until(async () => wd.execute<boolean>('return !document.querySelector(".scm-gh-manage").disabled;')); await click(".scm-gh-manage"); await wd.waitFor(".scm-gh-actor"); };
    const execute = async () => { await wd.waitFor(".scm-gh-action-preview"); const count = (await jobs()).length; await click(".scm-gh-execute"); await until(async () => { const list = await jobs(); return list.length === count + 1 && list[0]?.phase !== "running"; }); await until(async () => wd.execute<boolean>('return document.querySelectorAll(".scm-gh-action-job").length === arguments[0] && document.querySelector(".scm-gh-action-job")?.getAttribute("data-phase") !== "running";', count + 1)); return (await jobs())[0]!; };
    const refresh = async () => { await click(".scm-gh-result-refresh"); await until(async () => wd.execute<boolean>('return !!document.querySelector(".scm-gh-pull") && !document.querySelector(".scm-gh-manage").disabled;')); await click(".scm-gh-manage"); await wd.waitFor(".scm-gh-actor"); };
    await wd.refresh(); await wd.waitFor(".workspace-trigger"); await installProbe(wd); await record(wd); await open();
    await replace(".scm-gh-title", "네이티브 PR 작성"); await replace(".scm-gh-body", "입력한 설명을 보존합니다."); await click(".scm-gh-templates"); await wd.waitFor(".scm-gh-template-list details"); await click(".scm-gh-template-list summary"); await click(".scm-gh-template-apply");
    await until(async () => wd.execute<boolean>('return document.querySelector(".scm-gh-draft-state")?.textContent === "초안 저장됨" && document.querySelector(".scm-gh-body")?.value.includes("## 검증");'));
    const body = await wd.execute<string>('return document.querySelector(".scm-gh-body").value;');
    ctx.report.check(S, "실제 입력·커밋의 템플릿 선택·호스트 초안 저장", body.includes("입력한 설명") && body.includes("- [ ] 확인한 동작") && remote().action.requests.length === 0 && (await recorded(wd)).trusted, undefined, await shot(ctx, "23-github-draft.png"));
    const firstErrors = await pageErrors(wd); await click(".scm-close"); await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "github-actions-draft-restarted", freshPort: true, window: { width: 1500, height: 1100 } }); wd = ctx.app.wd; await wd.waitFor(".workspace-trigger"); await installProbe(wd); await open();
    ctx.report.check(S, "포트가 바뀐 앱 재시작 뒤 PR 제목·설명·템플릿 보존", await wd.execute<boolean>('return document.querySelector(".scm-gh-title")?.value === "네이티브 PR 작성" && document.querySelector(".scm-gh-body")?.value === arguments[0];', body));
    await click(".scm-gh-compose-preview"); await wd.waitFor(".scm-gh-action-preview"); await wd.execute('document.querySelector(".scm-gh-action-preview").scrollIntoView({block:"center"});');
    ctx.report.check(S, "계정·저장소·head·base·본문을 확인하기 전 외부 쓰기 없음", remote().action.requests.length === 0 && await wd.execute<boolean>('return document.querySelector(".scm-gh-action-preview").textContent.includes("worker/project:feature") && document.querySelector(".scm-gh-action-preview").textContent.includes("네이티브 PR 작성");'), undefined, await shot(ctx, "23-github-create-preview.png"));
    const created = await execute(); ctx.report.check(S, "작성한 PR과 원격 결과·링크가 실행 기록에 연결", created.phase === "complete" && created.effects[0]?.number === 7 && remote().pull.body === body && remote().action.requests.length === 1);
    await refresh(); await click(".scm-gh-ready"); const ready = await execute(); ctx.report.check(S, "초안 PR을 실제 버튼으로 검토 준비 상태로 전환", ready.phase === "complete" && !remote().pull.draft);
    await refresh(); await click(".scm-gh-reruns > summary"); await click(".scm-gh-rerun-failed"); const rerun = await execute();
    ctx.report.check(S, "실패한 Actions 작업을 원래 회차에서 한 번 재실행", rerun.phase === "complete" && remote().action.attempt === 3 && remote().action.requests.filter((r) => r.endpoint.includes("/rerun")).length === 1);
    await refresh(); await click(".scm-gh-edit"); await replace(".scm-gh-title", "수정한 네이티브 PR"); await click(".scm-gh-compose-preview"); const edited = await execute();
    ctx.report.check(S, "PR 제목·설명을 기존 PR에 수정하고 본문 보존", edited.phase === "complete" && remote().pull.title === "수정한 네이티브 PR" && remote().pull.body === body);
    await refresh(); await click(".scm-gh-merge-preview"); const pending = await execute();
    ctx.report.check(S, "고정한 head SHA로 비동기 병합을 보내고 처리 중으로 표시", pending.phase === "pending" && remote().action.requests.at(-1)?.body?.sha === head, undefined, await shot(ctx, "23-github-merge-pending.png"));
    const writes = remote().action.requests.length, errors = await pageErrors(wd); await click(".scm-close"); await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "github-actions-merge-restarted", freshPort: true, window: { width: 1500, height: 1100 } }); wd = ctx.app.wd;
    const merged = remote(); merged.action.asyncResult = "merged"; writeFileSync(fixturePath, JSON.stringify(merged));
    await wd.waitFor(".workspace-trigger"); await installProbe(wd); await open(); await click(".scm-gh-reconcile");
    const reconciled = await until(async () => (await jobs())[0]?.effects[0]?.outcome === "merged");
    ctx.report.check(S, "재시작 뒤 UUID 결과만 조회하여 병합 확인·중복 전송 없음", reconciled && remote().action.requests.length === writes, undefined, await shot(ctx, "23-github-merge-recovered.png"));
    ctx.report.check(S, "PR·CI 작업이 로컬 파일·인덱스·브랜치를 변경하지 않음", readFileSync(join(root, ".git/index")).equals(index) && readFileSync(join(root, "code.txt")).equals(bytes) && git("rev-parse", "HEAD") === head && git("branch", "--show-current") === "feature");
    ctx.report.check(S, "PR 작업 UI 페이지 예외 없음", firstErrors.length === 0 && errors.length === 0 && (await pageErrors(wd)).length === 0);
  } finally { rmSync(shim, { force: true }); }
}
