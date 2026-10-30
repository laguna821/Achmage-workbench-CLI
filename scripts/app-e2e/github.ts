import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, Snapshot, Work } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { githubFixture } from "../fixtures/github.ts";
import { installProbe, pageErrors, record, recorded, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

/** Actual native UI and gh subprocess boundary; only the remote API responses are fixtures. */
export async function githubScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "GitHub PR·CI", root = join(ctx.stage.root, "github-work"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-qb", "feature"); git("config", "user.name", "Native Fixture"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "code.txt"), "local fixture\n"); git("add", "code.txt"); git("commit", "-qm", "base"); git("remote", "add", "origin", "git@github.com:worker/project.git");
  const index = readFileSync(join(root, ".git/index")), bytes = readFileSync(join(root, "code.txt")), localHead = git("rev-parse", "HEAD");
  const fixturePath = join(ctx.stage.root, "github.json"), callsPath = join(ctx.stage.root, "github-calls.jsonl"), shim = join(ctx.stage.root, "openers", "gh");
  let data = githubFixture(localHead); const save = () => writeFileSync(fixturePath, JSON.stringify(data)); save();
  const moduleUrl = new URL("../fixtures/github.ts", import.meta.url).href;
  writeFileSync(shim, `#!/usr/bin/env node\nimport { readFileSync, appendFileSync } from 'node:fs';\nimport { githubFixtureResponse } from ${JSON.stringify(moduleUrl)};\nconst args=process.argv.slice(2), endpoint=args.find(x=>x.startsWith('repos/')||x==='graphql'), method=args[args.indexOf('--method')+1];\ntry {\n if (args[0]!=='api' || args[args.indexOf('--hostname')+1]!=='github.com' || !endpoint) throw new Error('unexpected command');\n if (method==='POST') { const body=JSON.parse(readFileSync(0,'utf8')); if(endpoint!=='graphql'||!body.query.startsWith('query')) throw new Error('fixture forbids writes'); } else if(method!=='GET') throw new Error('fixture forbids writes');\n appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({endpoint,method,debug:!!process.env.GH_DEBUG})+'\\n');\n const data=JSON.parse(readFileSync(${JSON.stringify(fixturePath)},'utf8')); const value=githubFixtureResponse(endpoint,data);\n process.stdout.write('HTTP/2.0 200 OK\\r\\nX-Ratelimit-Remaining: 4000\\r\\n\\r\\n'+(endpoint.endsWith('/logs')?value:JSON.stringify(value)));\n} catch(error) { process.stdout.write('HTTP/2.0 503 Unavailable\\r\\n\\r\\n'+JSON.stringify({message:error.message})); process.stderr.write(error.message); process.exitCode=1; }\n`); chmodSync(shim, 0o755);
  try {
    const work = await ctx.app.api<Work>("POST", "/api/works", { title: "GitHub 검토", cwd: root }), session = await ctx.app.api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "PR review" });
    const state = await ctx.app.api<Snapshot>("GET", "/api/snapshot"); await seedLayout(ctx, { ...state.prefs, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: work.id, sessionId: session.id, view: { kind: "work" } }] } });
    let wd = ctx.app.wd;
    const click = async (selector: string) => { const element = await wd.waitFor(selector); await wd.execute('arguments[0].scrollIntoView({block:"center"});', element); await wd.click(element); };
    const open = async () => { await click(".workspace-trigger"); await click(".workspace-scm-open"); await click(".scm-tab-github"); await wd.waitFor(".scm-gh-pull"); await until(async () => wd.execute<boolean>('return !document.querySelector(".scm-gh-load").disabled;')); };
    await wd.refresh(); await wd.waitFor(".workspace-trigger"); await installProbe(wd); await record(wd); await open();
    ctx.report.check(S, "포크의 원본 저장소·브랜치와 PR 커밋을 연결", await wd.execute<boolean>('return document.querySelector(".scm-gh-binding summary").textContent.includes("worker/project:feature → fixture/project") && document.querySelector(".scm-gh-pull").textContent.includes("#7 한글 PR 검토");') && (await recorded(wd)).trusted);
    ctx.report.check(S, "이름 변경·한글 차이를 앱 안에 표시하고 원격 이미지 로딩 없음", await wd.execute<boolean>('return document.querySelector(".scm-diff-header").textContent.includes("이전.txt → 한글.txt") && document.querySelector(".scm-lines").textContent.includes("+검토한 PR 내용") && !document.querySelector(".scm-github img");'), undefined, await shot(ctx, "22-github-files.png"));
    await click('.scm-gh-file[data-path="image.png"]');
    ctx.report.check(S, "차이가 없는 바이너리 파일을 빈 변경으로 오인하지 않음", await wd.execute<boolean>('return document.querySelector(".scm-github .scm-review").textContent.includes("바이너리 또는 큰 파일") && !document.querySelector(".scm-github .scm-lines");'));
    await click(".scm-gh-checks-tab");
    ctx.report.check(S, "실패·외부 상태·실행 승인·시험 병합 검사를 구분", (await wd.findAll(".scm-gh-check")).length === 4 && await wd.execute<boolean>('return document.querySelector(".scm-gh-check-list").textContent.includes("실행 승인 필요") && document.querySelector(".scm-gh-check-list").textContent.includes("시험 병합");'));
    await click(".scm-gh-detail"); await wd.waitFor(".scm-gh-log-button"); await click(".scm-gh-log-button"); await wd.waitFor(".scm-gh-log pre");
    ctx.report.check(S, "검토한 실행 시도의 작업·단계·실패 로그를 내부에서 확인", await wd.execute<boolean>('return document.querySelector(".scm-gh-details").textContent.includes("테스트 실행") && document.querySelector(".scm-gh-log pre").textContent.includes("expected boundary");'), undefined, await shot(ctx, "22-github-log.png"));
    data.logMissing = true; save(); await click(".scm-gh-log-button");
    ctx.report.check(S, "만료된 로그를 빈 성공 결과로 처리하지 않음", await until(async () => wd.execute<boolean>('return document.querySelector(".scm-gh-checks .scm-error")?.textContent.includes("410 logs expired") === true;')));
    data.logMissing = false; data.fail = true; save(); await click(".scm-gh-load"); await wd.waitFor(".scm-gh-stale");
    ctx.report.check(S, "조회 실패 때 마지막 PR과 검사 결과·조회 시각 유지", await wd.execute<boolean>('return !!document.querySelector(".scm-gh-pull") && document.querySelectorAll(".scm-gh-check").length === 4 && document.querySelector(".scm-gh-stale").textContent.includes("unavailable");'), undefined, await shot(ctx, "22-github-stale.png"));
    data = githubFixture("e".repeat(40)); data.pull.title = "새 커밋 PR"; save(); await click(".scm-gh-load");
    ctx.report.check(S, "명시적 새로고침에서 새 커밋 채택·로컬 차이 표시", await until(async () => wd.execute<boolean>('return document.querySelector(".scm-gh-pull")?.textContent.includes("새 커밋 PR") && document.querySelector(".scm-gh-pull")?.textContent.includes("현재 로컬 커밋") && !document.querySelector(".scm-gh-stale");')));
    await click(".scm-gh-files-tab"); ctx.report.check(S, "새로고침 뒤 선택한 파일 유지", await wd.execute<boolean>('return document.querySelector(".scm-gh-file.selected")?.getAttribute("data-path") === "image.png";'));
    const errors = await pageErrors(wd); await click(".scm-close"); await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "github-restarted", freshPort: true, window: { width: 1500, height: 1100 } }); wd = ctx.app.wd;
    await wd.waitFor(".workspace-trigger"); await installProbe(wd); await open();
    ctx.report.check(S, "앱 재시작 뒤 같은 작업공간의 PR을 다시 조회", await wd.execute<boolean>('return document.querySelector(".scm-gh-pull").textContent.includes("새 커밋 PR");'), undefined, await shot(ctx, "22-github-restarted.png"));
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    ctx.report.check(S, "Git 파일·인덱스·로컬 커밋 유지와 읽기 요청만 실행", readFileSync(join(root, ".git/index")).equals(index) && readFileSync(join(root, "code.txt")).equals(bytes) && git("rev-parse", "HEAD") === localHead && calls.length > 0 && calls.every((call) => call.method === "GET" || (call.method === "POST" && call.endpoint === "graphql")));
    ctx.report.check(S, "PR·CI UI 페이지 예외 없음", errors.length === 0 && (await pageErrors(wd)).length === 0);
  } finally { rmSync(shim, { force: true }); }
}
