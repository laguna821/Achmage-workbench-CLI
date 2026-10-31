import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, Snapshot, Work } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { KEY } from "./webdriver.ts";
import { installProbe, pageErrors, shot, until, type Ctx } from "./scenarios.ts";

export async function officeControlScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "원본 CLI 문서 제어";
  const startupOnly = process.env.APP_E2E_CONTROL_STARTUP_ONLY === "1";
  const cli = async (...args: string[]) => {
    const result = await ctx.app.command(join(ctx.app.dataDir, "bin/ieumoffice"), [...args, "--json"]);
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  };
  const work = await ctx.app.api<Work>("POST", "/api/works", { title: "CLI 문서 제어", cwd: null });
  for (const format of (startupOnly ? [] : ["docx", "pptx", "xlsx", "pdf"]) as ("docx" | "pptx" | "xlsx" | "pdf")[]) {
    const artifact = await ctx.app.api<Artifact>("POST", `/api/works/${work.id}/office-documents`, { format });
    const before = readFileSync(artifact.path);
    const target = format === "docx" ? ["--block", "0"] : format === "pptx" ? ["--slide", "0"] : format === "xlsx" ? ["--range", "B2:C3"] : ["--page", "1"];
    const opened = await cli("open", artifact.path, ...target);
    const selected = await cli("selection", artifact.path);
    const actual = selected.detail;
    const correct = format === "docx" ? actual.blocks?.[0] === 0 : format === "pptx" ? actual.slide === 0 : format === "xlsx" ? actual.range === "B2:C3" : actual.page === 1;
    ctx.report.check(S, `${format}: 원본 CLI 위치 이동과 실제 편집기 선택 읽기`, opened.status === "ok" && selected.status === "ok" && correct, JSON.stringify({ opened, selected }));
    if (!correct) throw new Error(`Wrong ${format} selection`);
    ctx.report.check(S, `${format}: 이동·선택 읽기는 파일을 변경하지 않음`, before.equals(readFileSync(artifact.path)));
    const { wd } = ctx.app;
    await wd.frame(null); await wd.frame(await wd.waitFor(`.pane[data-pane-active="true"] iframe.office-frame`, 15000)); await installProbe(wd);
    await wd.execute('window.__controlFrameIdentity="same-original-editor"');
    if (format === "docx") {
      const field = await wd.waitFor('.tiptap[contenteditable="true"]'); await wd.click(field); await wd.sendKeys(field, "UNSAVED CLI SELECTION");
      await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
      const live = await cli("selection", artifact.path);
      ctx.report.check(S, "Word: 저장 전 실제 선택 텍스트 읽기", String(live.detail.text).includes("UNSAVED CLI SELECTION") && before.equals(readFileSync(artifact.path)), JSON.stringify(live.detail));
    }
    await cli("open", artifact.path);
    ctx.report.check(S, `${format}: 재열기는 같은 편집기 인스턴스를 유지`, await wd.execute<boolean>('return window.__controlFrameIdentity==="same-original-editor"'));
    if (format === "docx") {
      ctx.report.check(S, "Word: 재열기 후 저장 전 내용 보존", await wd.execute<boolean>('return document.querySelector(".tiptap")?.textContent.includes("UNSAVED CLI SELECTION")===true'));
      await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "s" }, { type: "keyUp", value: "s" }, { type: "keyUp", value: KEY.control }]);
      if (!await until(async () => !before.equals(readFileSync(artifact.path)), 15000)) throw new Error("Explicit original save did not finish");
    }
    const errors = await pageErrors(wd); ctx.report.check(S, `${format}: 편집기 JS 오류 없음`, errors.length === 0, JSON.stringify(errors));
    await wd.frame(null);
  }
  if (!startupOnly) {
    const socketFile = join(ctx.app.dataDir, "office/control.json"), socketBefore = readFileSync(socketFile);
    const documents = (await ctx.app.api<Snapshot>("GET", "/api/snapshot")).artifacts;
    const word = documents.find(artifact => artifact.workId === work.id && artifact.format === "docx")!;
    const pdf = join(work.cwd, "CLI-export.pdf");
    const exported = await cli("convert", word.path, "--to", "pdf", "--out", pdf);
    const text = await ctx.app.command("pdftotext", [pdf, "-"]);
    ctx.report.check(S, "기본 CLI 래퍼 → native Word PDF 출력", exported.status === "ok" && text.stdout.includes("UNSAVED CLI SELECTION"));
    const html = join(work.cwd, "CLI-source.html"), docx = join(work.cwd, "CLI-html.docx");
    writeFileSync(html, "<!doctype html><meta charset=utf-8><p>Native wrapper 한글 Word</p>");
    const wordExport = await cli("convert", html, "--to", "docx", "--out", docx);
    ctx.report.check(S, "기본 CLI 래퍼 → 원본 HTML Word 출력", wordExport.status === "ok" && readFileSync(docx).subarray(0, 2).toString() === "PK");
    ctx.report.check(S, "CLI 출력 중 실행 중 앱 제어 endpoint 보존", socketBefore.equals(readFileSync(socketFile)));
  }
  const shownContent = async (name: string, content: string) => until(async () => {
    const { wd } = ctx.app;
    await wd.frame(null);
    const frame = await wd.find(`.pane[data-pane-active="true"] iframe.office-frame[title*="${name}"]`);
    if (!frame) return false;
    await wd.frame(frame);
    const ready = await wd.execute<boolean>('return document.querySelector(".tiptap")?.textContent.includes(arguments[0])===true', content);
    await wd.frame(null); return ready;
  }, 25000);
  const second = join(work.cwd, "Second-instance.md"); writeFileSync(second, "# SECOND INSTANCE DOCUMENT\n");
  await ctx.app.command(launch.binary, [second]);
  const shownSecond = await shownContent("Second-instance.md", "SECOND INSTANCE DOCUMENT");
  ctx.report.check(S, "실제 두 번째 native 프로세스의 파일 인자 → 기존 창과 원본 편집기 본문", shownSecond);
  if (!shownSecond) throw new Error("Second instance lost its file argument");
  const beforeRestart = await ctx.app.api<Snapshot>("GET", "/api/snapshot");
  ctx.report.check(S, "CLI에서 연 파일은 기존 프로젝트에 등록", beforeRestart.artifacts.some(artifact => artifact.path === second && artifact.workId === work.id));
  const directory = join(ctx.stage.root, "startup-documents"); mkdirSync(directory);
  const first = join(directory, "First-launch.md"); writeFileSync(first, "# FIRST LAUNCH DOCUMENT\n");
  await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "control-restarted", args: [first] });
  const shownFirst = await shownContent("First-launch.md", "FIRST LAUNCH DOCUMENT");
  ctx.report.check(S, "첫 실행 파일 인자는 UI 준비 후 원본 편집기 본문까지 열림", shownFirst, undefined, await shot(ctx, "cli-first-launch.png"));
  const afterRestart = await ctx.app.api<Snapshot>("GET", "/api/snapshot");
  const imported = afterRestart.artifacts.find(artifact => artifact.path === first);
  ctx.report.check(S, "새 경로는 실제 폴더 프로젝트로 열고 파일 보존", !!imported && afterRestart.works.some(work => work.id === imported.workId && work.cwd === directory) && readFileSync(first, "utf8") === "# FIRST LAUNCH DOCUMENT\n");
  if (!shownFirst) throw new Error("First launch lost its file argument");
}
