import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import type { Engines } from "./launch.ts";
import { fixture, savedText, toolCall } from "./office-suite.ts";
import { installProbe, pageErrors, savedLayout, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

const COMPOSER = ".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)";
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Original buttons → current bytes → copied document → original model edit →
 * explicit template Save. The local provider uses real editor tools with a visible marker. */
export async function officePreviewsScenario(ctx: Ctx, launch: { binary: string; engines: Engines; profile?: string }) {
  let wd = ctx.app.wd, requests: any[] = [], name = "", operation: "propose" | "edit" = "propose", step = 0;
  const formats = ["md", "docx", "pptx", "xlsx", "html", "hwpx", "xmind", "epub", "pdf"] as const;
  let active: (typeof formats)[number] = "md";
  const chosen = process.env.APP_E2E_OFFICE_PREVIEW_FORMATS?.split(",") ?? [...formats];
  if (chosen.some((format) => !(formats as readonly string[]).includes(format))) throw new Error("Unknown preview format");
  const marker = () => `TEMPLATE PREVIEW ${active.toUpperCase()} EDIT`;
  const api = <T,>(method: string, path: string, body?: unknown) => ctx.app.api<T>(method, path, body);
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push(body); step++;
      res.setHeader("content-type", "text/event-stream");
      const send = (delta: unknown, finish_reason: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const tool = operation === "propose" ? step === 1 ? { name: "propose_skill", input: { name, description: "Use this document template", body: "PREVIEW_CARD_BODY", wantsTemplate: true } } : null
        : active === "docx" ? step === 1 ? { name: "insert_content", input: { html: `<p>${marker()}</p>`, afterBlockIndex: -1 } } : null : toolCall(active, step, body, marker());
      if (tool) {
        if (!body.tools?.some((t: any) => t.function?.name === tool.name)) throw new Error(`Original ${tool.name} missing`);
        send({ role: "assistant", tool_calls: [{ index: 0, id: `preview-${active}-${operation}-${step}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }, "tool_calls");
      } else send({ role: "assistant", content: "PREVIEW_TURN_COMPLETE" }, "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const enter = async (id: string) => {
    await wd.frame(null);
    const selector = `.pane:not([hidden]) iframe.office-frame[src*=${JSON.stringify(`a=${id}`)}]`;
    if (!await until(async () => { const frame = await wd.find(selector); return !!frame && await wd.displayed(frame); }, 30000)) throw new Error(`Visible Office frame missing: ${id}`);
    await wd.frame(await wd.waitFor(selector)); await installProbe(wd);
    if (!await until(async () => { const input = await wd.find(COMPOSER); return !!input && await wd.displayed(input) && (active !== "xlsx" || await wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");')); }, 45000)) throw new Error("Preview composer not ready");
    if (active === "xlsx") await wd.execute(`if (!window.__previewExport) { window.__previewExport=[]; const original=window.desktopApi.workbookTemplateBytes; window.desktopApi.workbookTemplateBytes=async function(input){ try { const result=await original(input); window.__previewExport.push({input,ok:result.ok,byteLength:result.bytes?.byteLength,type:result.bytes?.constructor?.name}); return result; } catch(error) { window.__previewExport.push({input,error:String(error)}); throw error; } }; }`);
  };
  const click = async (selector: string) => {
    const element = await wd.waitFor(selector, 20000); await wd.execute('arguments[0].scrollIntoView({block:"center"});', element);
    let previous = "", stable = 0;
    if (!await until(async () => { const current = JSON.stringify(await wd.rect(element)); stable = current === previous ? stable + 1 : 0; previous = current; return stable >= 3; }, 10000)) throw new Error(`Control kept moving: ${selector}`);
    await wd.click(element);
  };
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "previews-fixture";
    settings.customEndpoints = [{ id: "previews-fixture", name: "Local preview fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "preview-model", kind: "local", modelProfiles: { "preview-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    for (const format of chosen as (typeof formats)[number][]) {
      active = format; const S = `Office 미리보기 ${format}`; name = `native-preview-${format}`; operation = "propose"; requests = []; step = 0;
      try {
        const work = await api<Work>("POST", "/api/works", { title: `현재 문서 양식 ${format}`, cwd: null }), path = join(work.cwd, `원본.${format}`);
        if (format === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), path); else await fixture(path, format);
        const before = hash(path), source = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
        const tab = { id: "preview-source", workId: work.id, sessionId: null as string | null, view: { kind: "document", artifactId: source.id, proposalId: null }, ui: { mode: format === "md" || format === "html" ? "rich" : "edit" } };
        const layout = (artifactId: string) => { const current = { ...tab, view: { ...tab.view, artifactId } }; return { version: 2, focus: "preview-pane", panes: [{ ...current, id: "preview-pane", tabs: [current], activeTabId: current.id, recentTabIds: [current.id] }] }; };
        await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout(source.id) }); await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await enter(source.id);
        const input = await wd.waitFor(COMPOSER); await wd.click(input); await wd.sendKeys(input, "현재 문서를 양식으로 포함하는 스킬을 제안해 줘"); await click(".ai-send-btn:not(.ai-stop-btn):not(:disabled)");
        let session: Session | undefined;
        if (!await until(async () => { session = (await snapshot()).sessions.find((s) => s.workId === work.id); return !!session && (await items(session.id)).some((i) => i.kind === "turnEnd"); }, 60000)) throw new Error("Proposal run did not end");
        tab.sessionId = session!.id;
        await wd.waitFor(".ai-skill-card", 15000);
        const cardBody = await wd.waitFor(".ai-skill-card-body"); await wd.click(cardBody); await wd.sendKeys(cardBody, " SOURCE_DRAFT_EDIT");
        ctx.report.check(S, "원본 카드의 양식 선택·원본 그대로 저장 버튼 활성", await until(() => wd.execute<boolean>('return !!document.querySelector(".ai-skill-card input[type=checkbox]:checked") && [...document.querySelectorAll(".ai-skill-card button")].some(e=>e.textContent.includes("원래 문서 그대로 저장") && !e.disabled);')), undefined, await shot(ctx, `preview-${format}-original.png`));
        operation = "edit"; step = 0; requests = [];
        await click(".ai-skill-card .primary:not(:disabled)");
        let copy: Artifact | undefined;
        if (!await until(async () => { copy = (await snapshot()).artifacts.find((a) => a.workId === work.id && a.id !== source.id); return !!copy; }, 45000)) throw new Error("Preview document missing");
        await enter(copy!.id);
        if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length >= 2, 60000)) throw new Error("Preview handoff did not finish");
        await wd.waitFor(".ai-skill-card .primary:not(:disabled)", 20000);
        ctx.report.check(S, "새 문서에서 원본 AI 요청·같은 대화·인계한 카드 초안", await wd.execute<boolean>('return document.querySelector(".ai-skill-card-body")?.value.includes("SOURCE_DRAFT_EDIT") === true && [...document.querySelectorAll(".ai-skill-card button")].some(e=>e.textContent.includes("이 탭을"));') && (await snapshot()).sessions.filter((s) => s.workId === work.id).length === 1, undefined, await shot(ctx, `preview-${format}-copy.png`));
        if (format === chosen[0]) {
          const count = requests.length;
          await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout(copy!.id) });
          await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "previews-restarted" }); wd = ctx.app.wd;
          await wd.setWindowRect({ width: 1900, height: 1200 }); await enter(copy!.id); await wd.waitFor(".ai-skill-card .primary:not(:disabled)", 20000);
          ctx.report.check(S, "실제 앱·host 재시작 후 카드 복원·AI 요청 중복 없음", requests.length === count && (await items(session!.id)).filter((i) => i.kind === "turnEnd").length === 2, undefined, await shot(ctx, `preview-${format}-restarted.png`));
        }
        if (format === "md") {
          const editor = await wd.waitFor('.tiptap[contenteditable="true"]'); await wd.click(editor); await wd.sendKeys(editor, " PERSON TEMPLATE EDIT ");
        }
        const finalBody = await wd.waitFor(".ai-skill-card-body"); await wd.click(finalBody); await wd.sendKeys(finalBody, " PREVIEW_DRAFT_EDIT");
        await click(".ai-skill-card .primary:not(:disabled)");
        if (!await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-skill-card-status=saved]")].some(e=>e.textContent.includes(arguments[0]));', name), 15000)) throw new Error(`Preview card did not save: ${await wd.execute('return document.body.innerText.slice(-3000);')}`);
        const skillPath = join(ctx.app.dataDir, "user-skills", name, "SKILL.md"), template = join(ctx.app.dataDir, "user-skills", name, "assets", `원본.${format}`);
        const templateText = existsSync(template) ? await savedText(template, format) : "";
        ctx.report.check(S, "AI가 편집한 현재 사본 바이트·사람이 바꾼 카드 본문 저장", templateText.includes(marker()) && existsSync(skillPath) && readFileSync(skillPath, "utf8").includes("PREVIEW_DRAFT_EDIT") && (format !== "md" || templateText.includes("PERSON TEMPLATE EDIT")), undefined, await shot(ctx, `preview-${format}-saved.png`));
        ctx.report.check(S, "원본 파일 바이트 보존·저장 기록 하나", hash(path) === before && (await items(session!.id)).filter((i) => i.office?.cardSaved).length === 1);
        const errors = await pageErrors(wd);
        await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout(source.id) }); await wd.refresh(); await enter(source.id);
        ctx.report.check(S, "원본 탭 재열기에도 저장 완료 표시", await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-skill-card-status=saved]")].some(e=>e.textContent.includes(arguments[0]));', name)));
        ctx.report.check(S, "미리보기·저장·복원 중 페이지 예외 없음", errors.length === 0 && (await pageErrors(wd)).length === 0, JSON.stringify([...errors, ...await pageErrors(wd)]));
        writeFileSync(ctx.report.path(`preview-${format}.json`), JSON.stringify({ items: await items(session!.id), requests, before, after: hash(path), templateText }, null, 2));
        if (format === chosen[0]) {
          for (const outcome of ["original", "cancel", "close"] as const) {
            name = `native-preview-${format}-${outcome}`; operation = "propose"; step = 0; requests = [];
            const oldIds = new Set((await snapshot()).artifacts.map((entry) => entry.id)), oldEnds = (await items(session!.id)).filter((entry) => entry.kind === "turnEnd").length;
            const composer = await wd.waitFor(COMPOSER); await wd.click(composer); await wd.sendKeys(composer, `현재 문서를 양식으로 포함하는 새 스킬을 제안해 줘 ${outcome}`); await click(".ai-send-btn:not(.ai-stop-btn):not(:disabled)");
            if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length > oldEnds, 60000)) throw new Error("Additional proposal missing");
            await wd.waitFor(".ai-skill-card .primary:not(:disabled)"); operation = "edit"; step = 0; requests = [];
            await click(".ai-skill-card .primary:not(:disabled)");
            let next: Artifact | undefined;
            if (!await until(async () => { next = (await snapshot()).artifacts.find((entry) => entry.workId === work.id && !oldIds.has(entry.id)); return !!next; }, 30000)) throw new Error("Additional preview missing");
            await enter(next!.id);
            if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length >= oldEnds + 2, 60000)) throw new Error("Additional handoff missing");
            await wd.waitFor(".ai-skill-card .primary:not(:disabled)");
            if (outcome === "original") {
              const count = requests.length;
              await wd.frame(null); await wd.click(await wd.waitFor(`.pane:not([hidden]) .group-tab [role=tab][title^=${JSON.stringify(source.path)}]`));
              await enter(source.id);
              if (!await until(async () => {
                const layout = (await savedLayout(ctx))?.layout as { focus: string; panes: { id: string; view: { artifactId?: string } }[] } | undefined;
                const pane = layout?.panes.find((entry) => entry.id === layout.focus);
                return pane?.view.artifactId === source.id;
              }, 10000)) throw new Error("Source tab activation was not persisted");
              await wd.frame(null); await wd.refresh(); await enter(source.id);
              const continued = await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-skill-card-status=preview]")].some(e=>e.textContent.includes(arguments[0]));', name));
              ctx.report.check(S, "원본 탭 재열기에서 진행 중인 미리보기 링크 복원", continued, undefined, await shot(ctx, `preview-${format}-source-link.png`));
              if (!continued) throw new Error("Ongoing preview link did not restore");
              await click('[data-skill-card-status=preview] button'); await enter(next!.id);
              await wd.waitFor(".ai-skill-card .primary:not(:disabled)");
              ctx.report.check(S, "복원한 링크로 사본에 돌아와도 AI 요청 중복 없음", requests.length === count);
              await click(".ai-skill-card-actions > button:nth-of-type(2):not(:disabled)");
              if (!await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-skill-card-status=saved]")].some(e=>e.textContent.includes(arguments[0]));', name))) throw new Error("Original snapshot save missing");
              const text = await savedText(join(ctx.app.dataDir, "user-skills", name, "assets", `원본.${format}`), format);
              ctx.report.check(S, "원본 그대로 저장은 AI 수정된 사본 대신 보관한 원본을 사용", !text.includes(marker()) && hash(path) === before, undefined, await shot(ctx, `preview-${format}-original-saved.png`));
            } else if (outcome === "cancel") {
              await click(".ai-skill-card-actions > button:last-of-type:not(:disabled)");
              if (!await until(() => wd.execute<boolean>('return !document.querySelector(".ai-skill-card");'))) throw new Error("Cancel did not close the preview card");
            } else {
              await wd.frame(null); await wd.click(await wd.waitFor(`.pane:not([hidden]) [aria-label=${JSON.stringify(`${next!.name} 탭 닫기`)}]`));
              if (!await until(async () => !await wd.find(`.pane:not([hidden]) iframe.office-frame[src*=${JSON.stringify(`a=${next!.id}`)}]`))) throw new Error("Preview tab did not close");
            }
            await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout(source.id) }); await wd.refresh(); await enter(source.id);
            if (outcome !== "original") {
              const finished = await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-skill-card-status=unsaved]")].some(e=>e.textContent.includes(arguments[0]));', name));
              const links = await wd.execute<any[]>("return window.aiOfficeUserSkills.previewLinks();");
              ctx.report.check(S, outcome === "close" ? "실제 탭 닫기: 미저장 종료·사본 보존·보관함 미생성" : "취소: 원본에 미저장 표시·사본 보존·보관함 미생성", finished && links.some((link) => link.label === name && link.outcome === "unsaved") && existsSync(next!.path) && !existsSync(join(ctx.app.dataDir, "user-skills", name)), undefined, await shot(ctx, `preview-${format}-${outcome}.png`));
            }
          }
          if (format === "md") {
            const path = join(work.cwd, "가림 문서.md"), secret = "TEMPLATE_NATIVE_HIDDEN_SECRET";
            writeFileSync(path, `# 가림 문서\n\n<span class="redact-span" data-redaction="" data-label="숨김">${secret}</span>\n`);
            const originalHash = hash(path), redacted = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
            await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout(redacted.id) }); await wd.refresh(); await enter(redacted.id);
            name = "native-preview-redacted"; operation = "propose"; requests = []; step = 0;
            const oldIds = new Set((await snapshot()).artifacts.map((entry) => entry.id)), oldEnds = (await items(session!.id)).filter((entry) => entry.kind === "turnEnd").length;
            const composer = await wd.waitFor(COMPOSER); await wd.click(composer); await wd.sendKeys(composer, "이 문서를 양식 스킬로 제안해 줘"); await click(".ai-send-btn:not(.ai-stop-btn):not(:disabled)");
            if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length > oldEnds, 60000)) throw new Error("Redacted proposal did not finish");
            await wd.waitFor(".ai-skill-card .primary:not(:disabled)");
            ctx.report.check(S, "가린 원본의 그대로 저장 차단·모델에 숨긴 값 제외", await wd.execute<boolean>('return document.querySelector("[data-template-as-is-blocked=redacted]")?.disabled === true;') && !JSON.stringify(requests).includes(secret), undefined, await shot(ctx, "preview-redacted-original.png"));
            operation = "edit"; step = 0; requests = []; await click(".ai-skill-card .primary:not(:disabled)");
            let next: Artifact | undefined;
            if (!await until(async () => { next = (await snapshot()).artifacts.find((entry) => entry.workId === work.id && !oldIds.has(entry.id)); return !!next; }, 30000)) throw new Error("Redacted preview missing");
            await enter(next!.id);
            if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length >= oldEnds + 2, 60000)) throw new Error("Redacted handoff did not finish");
            await wd.waitFor(".ai-skill-card .primary:not(:disabled)");
            ctx.report.check(S, "미리보기도 원본의 가림 상태 유지·모델 요청에 숨긴 값 없음", await wd.execute<boolean>('return document.querySelector("[data-template-as-is-blocked=redacted]")?.disabled === true;') && !JSON.stringify(requests).includes(secret), undefined, await shot(ctx, "preview-redacted-copy.png"));
            await click(".ai-skill-card-actions > button:last-of-type:not(:disabled)");
            await until(() => wd.execute<boolean>('return !document.querySelector(".ai-skill-card");'));
            ctx.report.check(S, "가린 양식 취소에도 원본 파일 보존·보관함 미생성", hash(path) === originalHash && !existsSync(join(ctx.app.dataDir, "user-skills", name)));
          }
        }
      } catch (error) {
        ctx.report.check(S, "현재 문서 양식 진행", false, String(error), await shot(ctx, `preview-${format}-failed.png`).catch(() => null));
        writeFileSync(ctx.report.path(`preview-${format}-diagnostic.json`), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : null, page: await wd.execute('return document.body.innerText.slice(-12000);').catch(() => null), errors: await pageErrors(wd).catch(() => []), exports: await wd.execute('return window.__previewExport ?? null;').catch(() => null), requests }, null, 2)); break;
      } finally { await wd.frame(null); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
