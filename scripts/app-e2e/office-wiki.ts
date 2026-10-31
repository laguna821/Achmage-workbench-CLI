import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, Session, Snapshot, Work } from "@workbench/contracts";
import type { Layout } from "../../apps/web/src/panes.ts";
import { installProbe, pageErrors, savedLayout, seedLayout, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** Original wiki UI/engine through the real document grants. No model or browser stubs. */
export async function officeWikiScenario(ctx: Ctx) {
  const S = "Office Markdown 위키", { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "원본 위키 연결", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  mkdirSync(join(work.cwd, "sub"));
  const source = join(work.cwd, "A.md"), target = join(work.cwd, "sub/B.md"), refer = join(work.cwd, "Refer.md");
  const original = '---\r\n"DIKM_단계:": ""\r\ntags: [Workflow_Engineering]\r\nunknown: null\r\n---\r\n# Source\r\n\r\n[[sub/B#Target]]\r\n\r\n[[sub/B#^point]]\r\n\r\n[[#Source]]\r\n';
  const targetText = '# Destination\n\nIntro paragraph.\n\n## Target\n\nA target paragraph.\n\nBlock destination ^point\n';
  writeFileSync(source, original); writeFileSync(target, targetText); writeFileSync(refer, '# Reference\n\n[[A#Source]]\n');
  const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: source, sessionId: session.id });
  const tab = { id: "wiki-source", workId: work.id, sessionId: session.id, view: { kind: "document", artifactId: artifact.id, proposalId: null }, ui: { mode: "rich" } };
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "wiki-pane", panes: [{ ...tab, id: "wiki-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await installProbe(wd);
  const enter = async (text: string) => {
    const opened = await until(async () => {
      await wd.frame(null);
      for (const frame of await wd.findAll('[data-pane="wiki-pane"] iframe.office-frame')) {
        if (!await wd.displayed(frame)) continue;
        await wd.frame(frame);
        return wd.execute<boolean>('return !!document.querySelector(".tiptap[contenteditable=true]")?.textContent.includes(arguments[0]);', text);
      }
      return false;
    }, 30000);
    if (!opened) throw new Error(`Wiki document did not open: ${text}`);
    await installProbe(wd);
  };
  const command = async (label: string) => {
    let button = await wd.find(`button[aria-label="${label}"]`);
    if (!button || !await wd.displayed(button)) {
      for (const candidate of await wd.findAll('button')) if ((await wd.text(candidate)).trim() === "보기") { await wd.click(candidate); break; }
      button = await wd.waitFor(`button[aria-label="${label}"]`);
    }
    await wd.click(button);
  };
  const link = async (raw: string) => {
    const css = `[data-wiki-target=${JSON.stringify(`[[${raw}]]`)}]`;
    if (!await until(() => wd.execute<boolean>('const e = document.querySelector(arguments[0]); return !!e && !e.className.includes("unresolved");', css), 10000)) throw new Error(`Unresolved wiki link: ${raw}`);
    await wd.keys([{ type: "keyDown", value: KEY.control }]);
    try { await wd.click(await wd.waitFor(css)); } finally { await wd.keys([{ type: "keyUp", value: KEY.control }]); }
  };
  const selection = () => wd.execute<string>('return document.querySelector(".tiptap")?.editor?.state.selection.$from.parent.textContent || "";');
  await enter("Source");
  await wd.execute('const original = window.markdownApi.wikiGraph; window.markdownApi.wikiGraph = async (...args) => window.__wikiGraph = await original(...args);');
  await command("그래프 보기");
  await wd.waitFor(".graph-canvas", 15000);
  ctx.report.check(S, "원본 그래프 화면·실제 문서 간 연결", await wd.execute<boolean>('return window.__wikiGraph.nodes.some(n => n.name === "A") && window.__wikiGraph.edges.some(e => e.from.endsWith("A.md") && e.to.endsWith("B.md"));'), undefined, await shot(ctx, "wiki-graph.png"));
  await wd.click(await wd.waitFor(".graph-close")); await command("백링크");
  const backlink = await wd.waitFor('.md-backlinks-item', 15000);
  ctx.report.check(S, "원본 백링크 화면에 참조 문서 표시", await wd.execute<boolean>('return arguments[0].textContent.includes("Refer");', backlink), undefined, await shot(ctx, "wiki-backlinks.png"));
  ctx.report.check(S, "그래프·백링크 조회가 YAML·CRLF·원문 바이트 보존", readFileSync(source, "utf8") === original);
  await wd.click(backlink); await enter("Reference");
  ctx.report.check(S, "백링크 클릭으로 참조 문서 열기", true);
  await link("A#Source"); await enter("Source");
  ctx.report.check(S, "문서 간 제목 fragment로 커서 이동", await until(async () => (await selection()) === "Source"));
  // Leave an edit unsaved and navigate through the original Ctrl+click handler.
  const editor = await wd.waitFor('.tiptap[contenteditable="true"]');
  await wd.click(await wd.waitFor(".tiptap h1")); await wd.sendKeys(editor, " WIKI PENDING EDIT");
  await link("sub/B#Target"); await enter("Destination");
  ctx.report.note(S, "링크 이동 직후 저장 원문과 대상 편집기 선택", { source: readFileSync(source, "utf8"), selection: await selection(), dom: await wd.execute('return {text:getSelection()?.anchorNode?.textContent, parent:getSelection()?.anchorNode?.parentElement?.tagName};') });
  ctx.report.check(S, "링크 이동 전 미저장 원문을 저장", readFileSync(source, "utf8").includes("WIKI PENDING EDIT"));
  ctx.report.check(S, "대상 제목 위치로 이동", await until(async () => (await selection()) === "Target"), undefined, await shot(ctx, "wiki-heading.png"));
  await command("백링크"); await wd.click(await wd.waitFor('.md-backlinks-item')); await enter("WIKI PENDING EDIT");
  await link("sub/B#^point"); await enter("Destination");
  ctx.report.check(S, "대상 블록 위치로 이동", await until(async () => (await selection()).includes("Block destination")), undefined, await shot(ctx, "wiki-block.png"));
  const saved = readFileSync(source, "utf8"), header = original.slice(0, original.indexOf("# Source"));
  ctx.report.check(S, "편집 후 기존 YAML 형태·키·빈 값과 대상 원문 보존", saved.startsWith(header) && readFileSync(target, "utf8") === targetText);
  const errors = await pageErrors(wd); await wd.frame(null);
  const current = await snapshot(), targetArtifact = current.artifacts.find(item => item.path === target);
  const sameSession = !!targetArtifact && targetArtifact.workId === work.id && await until(async () => {
    const layout = (await savedLayout(ctx))?.layout as Layout<{ kind: string; artifactId?: string }> | undefined;
    const pane = layout?.panes.find(item => item.id === "wiki-pane");
    return pane?.tabs?.some(item => item.view.kind === "document" && item.view.artifactId === targetArtifact.id && item.sessionId === session.id) === true;
  });
  ctx.report.check(S, "같은 작업공간·대화에 링크 문서 등록", sameSession);
  ctx.report.check(S, "편집기·상위 앱 예외 없음", errors.length === 0 && (await pageErrors(wd)).length === 0, errors.join("\n"));
}
