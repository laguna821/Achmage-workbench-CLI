import { createServer } from "node:net";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Work } from "@workbench/contracts";
import type { LaunchOptions } from "./launch.ts";
import { fixture, savedText } from "./office-suite.ts";
import { installProbe, pageErrors, shot, until, type Ctx } from "./scenarios.ts";

const require = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

/** Real external MCP clients → original tools → actual Tauri/original editors. No model fixture. */
export async function officeMcpScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "원본 MCP 문서 제어", clients: any[] = [], calls: { name: string; args: unknown; result: unknown }[] = [];
  const api = <T>(method: string, path: string, body?: unknown) => ctx.app.api<T>(method, path, body);
  const setting = (channel: string, args: unknown[] = []) => api<any>("POST", "/api/office-mcp/invoke", { channel, args });
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("No MCP fixture port");
  const port = address.port; await new Promise<void>(done => probe.close(() => done()));
  const client = async (sse = false) => {
    const value = new Client({ name: `workbench-native-${clients.length}`, version: "1.0.0" });
    clients.push(value); await value.connect(sse ? new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)) : new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    return value;
  };
  const tool = async (client: any, name: string, args: unknown = {}, allowError = false) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 150_000 });
    const text = result.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
    calls.push({ name, args, result }); writeFileSync(ctx.report.path("mcp-calls.json"), JSON.stringify(calls, null, 2));
    if (result.isError) { if (allowError) return { error: text }; throw new Error(`${name}: ${text}`); }
    try { return JSON.parse(text); } catch { return text; }
  };
  const openSettings = async () => {
    const { wd } = ctx.app; await wd.frame(null); await wd.click(await wd.waitFor('button[aria-label="연결과 설정"]'));
    const button = await wd.execute<Record<string, string>>('return [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "문서 AI 설정…");');
    await wd.click(button); await wd.frame(await wd.waitFor('iframe[title="문서 AI 설정 화면"]')); await wd.waitFor("#set-mcp-port", 20000); await installProbe(wd);
  };
  const frame = async () => {
    const { wd } = ctx.app; await wd.frame(null); await wd.frame(await wd.waitFor('.pane[data-tab-active="true"] iframe.office-frame', 30000)); await installProbe(wd);
  };
  try {
    ctx.report.check(S, "기본값은 외부 MCP 서버 꺼짐", !(await setting("home:get-mcp-status")).enabled);
    await setting("home:set-mcp-settings", [{ port }]);
    await openSettings();
    await ctx.app.wd.click(await ctx.app.wd.waitFor('.set-mcp-server [role="switch"]'));
    if (!await until(async () => (await setting("home:get-mcp-status")).running, 15000)) throw new Error("MCP switch did not start the server");
    ctx.report.check(S, "원본 설정 화면에서 포트·서버 활성화", await ctx.app.wd.execute<boolean>('return document.querySelector("#set-mcp-port").value === arguments[0] && document.querySelector(".set-mcp-server [role=switch]").getAttribute("aria-checked") === "true";', String(port)), undefined, await shot(ctx, "mcp-settings.png"));
    await ctx.app.wd.frame(null); await ctx.app.wd.click(await ctx.app.wd.waitFor('button[aria-label="문서 AI 설정 닫기"]'));
    const a = await client(), b = await client(true);
    const names = (await a.listTools()).tools.map((entry: any) => entry.name);
    ctx.report.check(S, "원본 HTTP·SSE와 3종 편집/열린 문서/PDF/HWP 도구", ["create_session", "save_session", "open_documents", "insert_content", "apply_slide_ops", "apply_sheet_ops", "read_pdf", "read_hwp"].every(name => names.includes(name)) && !names.includes("create_docx"));
    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { origin: "https://untrusted.invalid", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{}' });
    ctx.report.check(S, "다른 웹사이트 Origin의 제어 요청 거부", denied.status === 403);
    await tool(a, "create_session", { family: "docx" });
    const word = (await tool(a, "open_documents", { action: "list" })).documents.find((doc: any) => doc.kind === "docs");
    const sourceBytes = readFileSync(word.path);
    await frame(); const field = await ctx.app.wd.waitFor('.tiptap[contenteditable="true"]', 30000); await ctx.app.wd.click(field); await ctx.app.wd.sendKeys(field, "MCP_HUMAN_UNSAVED ");
    await tool(a, "insert_content", { html: "<p>MCP_WORD_EDIT</p>" });
    const liveWord = JSON.stringify(await tool(a, "read_document"));
    ctx.report.check(S, "Word: 사람의 미저장 입력과 원본 MCP 수정이 같은 편집기에 반영", liveWord.includes("MCP_HUMAN_UNSAVED") && liveWord.includes("MCP_WORD_EDIT") && sourceBytes.equals(readFileSync(word.path)));
    const first = await tool(b, "read_document", {}, true);
    ctx.report.check(S, "HTTP/SSE 클라이언트의 활성 세션 분리", !!first.error);
    await tool(b, "create_session", { family: "pptx" });
    const deck = await tool(b, "read_deck"), count = deck.slides.length;
    await tool(b, "apply_slide_ops", { ops: [{ op: "addBlankSlide", target: { slide: count - 1 } }] });
    ctx.report.check(S, "PPT: 원본 트랜잭션으로 쪽 추가·실시간 읽기", (await tool(b, "read_deck")).slides.length === count + 1);
    ctx.report.check(S, "두 번째 클라이언트의 PPT 생성이 첫 Word 세션을 바꾸지 않음", JSON.stringify(await tool(a, "read_document")).includes("MCP_WORD_EDIT"));
    const work = await api<Work>("POST", "/api/works", { title: "MCP 검증 결과", cwd: null });
    const wordOut = join(work.cwd, "MCP-word.docx"), slideOut = join(work.cwd, "MCP-slides.pptx");
    const beforeCopy = readFileSync(word.path);
    await tool(a, "save_session", { path: wordOut });
    ctx.report.check(S, "Word: 요청 경로 사본 저장·원본 파일 보존", existsSync(wordOut) && (await savedText(wordOut, "docx")).includes("MCP_WORD_EDIT") && beforeCopy.equals(readFileSync(word.path)));
    await tool(b, "save_session", { path: slideOut });
    ctx.report.check(S, "PPT: 요청 경로 사본 저장", existsSync(slideOut) && readFileSync(slideOut).subarray(0, 2).toString() === "PK");
    ctx.report.check(S, "저장 완료한 MCP 세션 종료", !!(await tool(a, "read_document", {}, true)).error);
    await tool(a, "create_session", { family: "xlsx" });
    const overview = await tool(a, "read_sheet"); writeFileSync(ctx.report.path("mcp-sheet-overview.json"), JSON.stringify(overview, null, 2));
    const sheets = overview.context?.sheets;
    const sheet = sheets?.[0]; if (!sheet) throw new Error(`No worksheet: ${JSON.stringify(overview)}`);
    await tool(a, "apply_sheet_ops", { ops: [{ op: "set_cell", sheetId: sheet.id, address: "A1", value: "MCP_SHEET_EDIT" }] });
    const cell = await tool(a, "read_sheet", { sheetId: sheet.id, addresses: ["A1"] });
    ctx.report.check(S, "Sheets: 원본 셀 수정·현재 셀 읽기", JSON.stringify(cell).includes("MCP_SHEET_EDIT"));
    const sheetOut = join(work.cwd, "MCP-sheet.xlsx"); writeFileSync(sheetOut, "existing destination");
    ctx.report.check(S, "기존 파일은 overwrite 없이 거부하고 세션 편집 보존", !!(await tool(a, "save_session", { path: sheetOut }, true)).error && readFileSync(sheetOut, "utf8") === "existing destination" && JSON.stringify(await tool(a, "read_sheet", { sheetId: sheet.id, addresses: ["A1"] })).includes("MCP_SHEET_EDIT"));
    await tool(a, "save_session", { path: sheetOut, overwrite: true });
    ctx.report.check(S, "Sheets: 명시 덮어쓰기·저장 파일 내용", (await savedText(sheetOut, "xlsx")).includes("MCP_SHEET_EDIT"));
    for (const format of ["md", "html", "xmind", "hwpx", "epub"] as const) {
      const path = join(work.cwd, `MCP-read.${format}`); await fixture(path, format);
      await tool(a, "open_in_genoffice", { path });
      const result = await tool(a, "open_documents", { action: "read", target: path });
      ctx.report.check(S, `${format}: 원본 열린 문서 읽기`, typeof result.content === "string" && result.content.length > 0, String(result.content).slice(0, 160));
    }
    const markdown = join(work.cwd, "MCP-read.md"), original = readFileSync(markdown);
    await tool(a, "open_in_genoffice", { path: markdown }); await frame();
    const md = await ctx.app.wd.waitFor('.tiptap[contenteditable="true"]', 30000); await ctx.app.wd.click(md); await ctx.app.wd.sendKeys(md, "MCPDISCARDME");
    ctx.report.check(S, "Markdown: 저장 전 내용 읽기", JSON.stringify(await tool(a, "open_documents", { action: "read", target: markdown })).includes("MCPDISCARDME") && original.equals(readFileSync(markdown)));
    await tool(a, "open_documents", { action: "close", target: markdown, unsaved: "discard" });
    await tool(a, "open_in_genoffice", { path: markdown });
    ctx.report.check(S, "명시 버리고 닫기 후 재열기에 복구 초안이 돌아오지 않음", !JSON.stringify(await tool(a, "open_documents", { action: "read", target: markdown })).includes("MCPDISCARDME") && original.equals(readFileSync(markdown)));
    await ctx.app.wd.frame(null);
    const sourceMode = await ctx.app.wd.execute<Record<string, string>>('return [...document.querySelectorAll(".pane[data-tab-active=true] .doc-header [role=radio]")].find(b => b.textContent.trim() === "원문");');
    await ctx.app.wd.click(sourceMode); await ctx.app.wd.waitFor('.pane[data-tab-active="true"] .cm-editor');
    await tool(a, "open_documents", { action: "list" });
    const sourceRead = await tool(a, "open_documents", { action: "read", target: markdown });
    ctx.report.check(S, "목록·원문 읽기는 선택한 보기 모드를 바꾸지 않음", sourceRead.content === original.toString("utf8") && await ctx.app.wd.execute<boolean>('return document.querySelector(".pane[data-tab-active=true] .doc-header [role=radio][aria-checked=true]")?.textContent.trim() === "원문";'));
    await tool(a, "insert_content", { document: wordOut, html: "<p>MCP_REOPEN_EDIT</p>" });
    await tool(a, "open_documents", { action: "save", target: wordOut });
    ctx.report.check(S, "이미 열린 문서를 경로로 지정해 편집·자기 파일 저장", (await savedText(wordOut, "docx")).includes("MCP_REOPEN_EDIT"));
    await frame(); ctx.report.check(S, "편집기 JS 오류 없음", (await pageErrors(ctx.app.wd)).length === 0, undefined, await shot(ctx, "mcp-word-final.png"));
    for (const c of clients.splice(0)) await c.close();
    await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "mcp-restarted" });
    const status = await setting("home:get-mcp-status");
    ctx.report.check(S, "재시작 후 포트·활성화 설정과 원본 서버 복원", status.running && status.port === port && status.enabled);
    const restored = await client(); ctx.report.check(S, "재시작 후 실제 MCP 재연결", (await restored.listTools()).tools.some((entry: any) => entry.name === "open_documents"));
    await restored.close(); clients.splice(0);
    await setting("home:set-mcp-settings", [{ enabled: false }]);
    ctx.report.check(S, "서버 끄기와 비활성 설정 보존", !(await setting("home:get-mcp-status")).running && JSON.parse(readFileSync(join(ctx.app.dataDir, "office/mcp-settings.json"), "utf8")).enabled === false);
  } finally {
    for (const value of clients) await value.close().catch(() => {});
    await setting("home:set-mcp-settings", [{ enabled: false }]).catch(() => {});
  }
}
