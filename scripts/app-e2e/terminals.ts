import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, Snapshot, TerminalList, TerminalOutput, Work } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { installProbe, pageErrors, record, recorded, savedLayout, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

export async function terminalsScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "14 실제 터미널";
  let wd = ctx.app.wd;
  await wd.setWindowRect({ width: 1500, height: 1000 });
  const cwd = join(ctx.stage.root, "터미널 작업"); mkdirSync(cwd);
  const work = await ctx.app.api<Work>("POST", "/api/works", { title: "실제 PTY 검사", cwd });
  const session = await ctx.app.api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const snapshot = () => ctx.app.api<Snapshot>("GET", "/api/snapshot");
  const list = () => ctx.app.api<TerminalList>("GET", `/api/workspaces/${work.defaultWorkspaceId}/terminals`);
  const terminal = (id: string) => ctx.app.api<TerminalOutput>("GET", `/api/terminals/${id}`);
  const retainedOutput = async (id: string) => {
    const parts: Buffer[] = []; let cursor = 0;
    for (;;) {
      const chunk = await ctx.app.api<TerminalOutput>("GET", `/api/terminals/${id}?cursor=${cursor}`);
      parts.push(Buffer.from(chunk.data, "base64"));
      if (chunk.end >= chunk.terminal.outputEnd) return Buffer.concat(parts).toString("utf8");
      if (chunk.end <= cursor) throw new Error("Terminal output cursor did not advance");
      cursor = chunk.end;
    }
  };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 1, focus: "a", panes: [{ id: "a", workId: work.id, sessionId: session.id, view: { kind: "work" } }] } });
  await wd.refresh(); await wd.waitFor('.workspace-trigger'); await installProbe(wd); await record(wd);
  const click = async (selector: string) => wd.click(await wd.waitFor(selector));
  const buttonText = async (selector: string, text: string) => {
    for (const button of await wd.findAll(selector)) if ((await wd.execute<string>('return arguments[0].textContent;', button)).trim() === text) { await wd.click(button); return; }
    throw new Error(`Button not found: ${text}`);
  };
  await click('.workspace-trigger'); await click('.workspace-terminals-open'); await wd.waitFor('.terminal-dialog');
  await click('.terminal-dialog details summary');
  await wd.sendKeys(await wd.waitFor('[aria-label="터미널 셸"]'), "/bin/sh");
  await wd.sendKeys(await wd.waitFor('[aria-label="터미널 셸 인자"]'), "-i");
  await click('.terminal-create');
  const created = await until(async () => (await list()).terminals.some((entry) => entry.status === "running"));
  const first = (await list()).terminals[0]!;
  const prefix = `.terminal-view[data-terminal-id="${first.id}"]`;
  await wd.waitFor(`${prefix}[data-terminal-status="running"][data-terminal-ready="true"] .xterm-helper-textarea`);
  const command = async (id: string, command: string) => {
    const area = await wd.waitFor(`.terminal-view[data-terminal-id="${id}"] .xterm-helper-textarea`);
    await click(`.terminal-view[data-terminal-id="${id}"] .terminal-surface`);
    await wd.sendKeys(area, command); await wd.press(KEY.enter);
  };
  await command(first.id, "printf '사람 입력\\n' > ui-proof.txt; cat ui-proof.txt");
  const wrote = await until(async () => existsSync(join(cwd, "ui-proof.txt")) && readFileSync(join(cwd, "ui-proof.txt"), "utf8") === "사람 입력\n");
  const displayed = await until(async () => wd.execute<boolean>('return document.querySelector(arguments[0]).textContent.includes("사람 입력");', prefix));
  ctx.report.check(S, "실제 키 입력이 PTY의 정확한 폴더에서 실행되고 한글 출력 표시", created && wrote && displayed && (await recorded(wd)).trusted, undefined, await shot(ctx, "14-terminal-input.png"));
  await buttonText(`${prefix} .terminal-toolbar button`, "찾기");
  await wd.sendKeys(await wd.waitFor(`${prefix} [aria-label="터미널 출력 찾기"]`), "사람 입력");
  await buttonText(`${prefix} .terminal-find button`, "다음");
  ctx.report.check(S, "실제 출력에서 검색·선택", await until(async () => wd.execute<boolean>('return document.querySelector(arguments[0]).textContent.includes("찾았습니다");', `${prefix} .terminal-find`)), undefined, await shot(ctx, "14-terminal-find.png"));
  await buttonText(`${prefix} .terminal-find button`, "닫기");
  const originalCols = (await terminal(first.id)).terminal.cols;
  await click('.topbar-right [aria-label="오른쪽으로 분할"]');
  const split = await until(async () => (await list()).terminals.filter((entry) => entry.status === "running").length === 2 && (await wd.findAll('.pane:not([hidden]) .terminal-view')).length === 2);
  const second = (await list()).terminals.find((entry) => entry.id !== first.id)!;
  const resized = await until(async () => (await terminal(first.id)).terminal.cols < originalCols);
  ctx.report.check(S, "터미널 분할은 같은 cwd의 별도 셸 생성·PTY 크기 변경", split && resized && second.cwd === cwd && (await terminal(first.id)).terminal.pid === first.pid && second.pid !== first.pid, undefined, await shot(ctx, "14-terminal-split.png"));
  const firstPane = await wd.execute<string>('return document.querySelector(arguments[0]).closest(".pane").dataset.pane;', prefix);
  await click(`.pane[data-pane="${firstPane}"]:not([hidden]) .group-tab.active .group-tab-close`);
  const alive = (await terminal(first.id)).terminal;
  ctx.report.check(S, "탭 닫기는 셸 종료와 분리되어 같은 PID 유지", alive.status === "running" && alive.pid === first.pid);
  await click(`.terminal-view[data-terminal-id="${second.id}"] .terminal-list-open`);
  await click(`.terminal-history-row[data-terminal-id="${first.id}"]`);
  await wd.waitFor(`${prefix}[data-terminal-ready="true"] .xterm-helper-textarea`);
  ctx.report.check(S, "목록에서 닫힌 터미널 재열기·이전 출력·중복 실행 없음", (await list()).terminals.length === 2 && (await terminal(first.id)).terminal.pid === first.pid && await until(async () => wd.execute<boolean>('return document.querySelector(arguments[0]).textContent.includes("사람 입력");', prefix)), undefined, await shot(ctx, "14-terminal-reopened.png"));
  await click(`${prefix} .terminal-stop`); await wd.waitFor(`${prefix} .terminal-stop-confirm`);
  await buttonText(`${prefix} .terminal-stop-confirm button`, "종료 확인");
  const closed = await until(async () => (await terminal(first.id)).terminal.status === "exited");
  await wd.waitFor(`${prefix}[data-terminal-status="exited"]`);
  const endedOutput = await retainedOutput(first.id);
  const endedVisible = await until(async () => wd.execute<boolean>('return [...document.querySelectorAll(arguments[0] + " .xterm-accessibility-tree > div")].some(node => node.textContent.trim() === "사람 입력");', prefix));
  ctx.report.check(S, "명시적 실행 종료 후 이전 출력과 종료 상태 유지", closed && endedVisible && endedOutput.includes("사람 입력"), `종료=${closed} · 출력 표시=${endedVisible} · 기록 ${Buffer.byteLength(endedOutput)} bytes`, await shot(ctx, "14-terminal-ended.png"));
  await until(async () => JSON.stringify((await savedLayout(ctx))?.layout).includes(first.id));
  const errors = await pageErrors(wd);
  await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "terminals-restarted", freshPort: true, window: { width: 1500, height: 1000 } }); wd = ctx.app.wd;
  await wd.waitFor('.terminal-view');
  const restored = await list();
  await wd.waitFor(`${prefix}[data-terminal-ready="true"]`);
  const replayed = await until(async () => wd.execute<boolean>('return [...document.querySelectorAll(".terminal-view[data-terminal-ready=true] .xterm-accessibility-tree > div")].some(node => node.textContent.trim() === "사람 입력");'));
  ctx.report.check(S, "새 포트 재시작은 출력·탭을 복원하고 셸을 자동 재실행하지 않음", restored.terminals.length === 2 && restored.terminals.every((entry) => !["running", "starting"].includes(entry.status) && entry.pid === null) && replayed, undefined, await shot(ctx, "14-terminal-restarted.png"));
  ctx.report.check(S, "터미널 작업 중 페이지 예외 없음", errors.length === 0 && (await pageErrors(wd)).length === 0);
}
