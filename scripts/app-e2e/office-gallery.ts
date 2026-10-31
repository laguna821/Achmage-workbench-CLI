import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import type { Engines } from "./launch.ts";
import { fixture, savedText } from "./office-suite.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

/** Real original gallery/AgentLoop/page builder and native process restart. Model replies are local fixtures. */
export async function officeGalleryScenario(ctx: Ctx, launch: { binary: string; engines: Engines; profile?: string }) {
  let wd = ctx.app.wd, phase = "open", step = 0, operation: "generate" | "reuse" = "generate";
  const S = "Office 디자인 갤러리", name = "다시 쓰는 발표 스타일", requests: any[] = [];
  const api = <T,>(method: string, path: string, body?: unknown) => ctx.app.api<T>(method, path, body);
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const marker = () => operation === "generate" ? "GALLERY GENERATED 한글" : "GALLERY REUSED 한글";
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      const body = JSON.parse(raw); requests.push(body);
      const agent = Array.isArray(body.tools) && body.tools.length > 0;
      const send = (delta: unknown, finish_reason: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      res.setHeader("content-type", "text/event-stream");
      if (!agent) {
        const spec = { background: "#F4F8FF", elements: [{ type: "text", x: 80, y: 80, w: 1080, h: 180, paragraphs: [{ runs: [{ text: marker(), sizePt: 32, font: "Pretendard", color: "#123A77" }] }] }] };
        send({ role: "assistant", content: JSON.stringify(spec) }, "stop");
      } else {
        step++;
        const tool = step === 1 ? { name: "generate_deck", input: { core_hook: "Reuse the selected design", topic: "Design gallery validation", style: operation === "generate" ? "주조색을 파란색으로 해 줘" : "", ...(operation === "reuse" ? { style_template: name, insert_mode: "append" } : {}), pages: [{ title: marker(), brief: "Editable Korean and English title", layout: "title" }] } }
          : step === 2 && operation === "generate" ? { name: "save_style_template", input: { name } } : null;
        if (tool) {
          if (!body.tools.some((entry: any) => entry.function?.name === tool.name)) throw new Error(`Missing original tool ${tool.name}`);
          send({ role: "assistant", tool_calls: [{ index: 0, id: `gallery-${operation}-${step}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }, "tool_calls");
        } else send({ role: "assistant", content: "GALLERY_TURN_COMPLETE" }, "stop");
      }
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture port missing");
  const enter = async (id: string) => {
    const selector = `.pane:not([hidden]) iframe.office-frame[src*=${JSON.stringify(`a=${id}`)}]`;
    if (!await until(async () => {
      try { await wd.frame(null); const frame = await wd.find(selector); if (!frame || !await wd.displayed(frame)) return false; await wd.frame(frame); return !!await wd.find(".ai-tpl-chip-main"); } catch { return false; }
    }, 45000)) throw new Error("Gallery frame not ready");
    await installProbe(wd);
  };
  const click = async (selector: string) => { const item = await wd.waitFor(selector, 20000); await wd.execute('arguments[0].scrollIntoView({block:"center"});', item); await wd.click(item); };
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "gallery-fixture";
    settings.customEndpoints = [{ id: "gallery-fixture", name: "Local gallery fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "gallery-model", kind: "local", modelProfiles: { "gallery-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    const work = await api<Work>("POST", "/api/works", { title: S, cwd: null }), path = join(work.cwd, "갤러리.pptx"); await fixture(path, "pptx");
    const original = createHash("sha256").update(readFileSync(path)).digest("hex");
    const source = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path }), session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
    const items = async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
    const tab = { id: "gallery-doc", workId: work.id, sessionId: session.id, view: { kind: "document", artifactId: source.id, proposalId: null }, ui: { mode: "edit" } };
    const layout = { version: 2, focus: "gallery-pane", panes: [{ ...tab, id: "gallery-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] };
    await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout }); await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await enter(source.id);
    phase = "render gallery"; await click(".ai-tpl-chip-main"); await wd.waitFor("[data-template-id]");
    const covers = await until(() => wd.execute<boolean>('const cards=[...document.querySelectorAll("[data-template-id]")]; return cards.length>0 && cards.every(e=>e.querySelector(".ai-tpl-cover")?.childElementCount>0);'), 60000);
    const ids = await wd.execute<string[]>('return [...document.querySelectorAll("[data-template-id]")].map(e=>e.dataset.templateId);');
    ctx.report.check(S, "전체 내장 디자인에 원본 생성 표지 표시", covers && ids.length > 0, JSON.stringify(ids), await shot(ctx, "gallery-covers.png"));
    if (!covers) throw new Error("Original covers did not render");
    const translations = await wd.execute<any[]>(`return (async()=>{ const results=[]; for(const id of arguments[0]) for(const lang of ["ko","en"]) {const slide=await window.slidesApi.renderTemplateCover(id,lang); results.push({id,lang,nodes:slide?.nodes?.length??0});} return results; })();`, ids);
    ctx.report.check(S, "모든 디자인의 한국어·영어 실제 렌더 트리", translations.length === ids.length * 2 && translations.every((entry) => entry.nodes > 0));
    const fonts = await wd.execute<any>('return (async()=>({faces:await window.slidesApi.privateFontFaces(),loaded:[...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family),weights:[...document.fonts].filter(f=>f.status==="loaded").map(f=>({family:f.family,weight:f.weight}))}))();');
    ctx.report.check(S, "번들 템플릿 글꼴의 private face와 실제 브라우저 로드", fonts.faces.some((f: any) => f.family === "Pretendard") && fonts.loaded.some((f: string) => f.includes("Pretendard")), JSON.stringify(fonts));
    const variable = fonts.faces.filter((face: any) => face.weight?.includes(" "));
    ctx.report.check(S, "원본 가변 글꼴의 굵기 범위를 브라우저에 보존", variable.length > 0 && variable.every((face: any) => fonts.weights.some((loaded: any) => loaded.family.replaceAll('"', '') === face.family && loaded.weight === face.weight)));
    await click(`[data-template-id=${JSON.stringify(ids[0])}]`);
    const chosen = await wd.execute<any>("return window.slidesApi.getTemplateSelection();");
    ctx.report.check(S, "갤러리 선택은 문서별 기억만 저장하고 PPTX를 변경하지 않음", chosen?.key === ids[0] && createHash("sha256").update(readFileSync(path)).digest("hex") === original);
    phase = "generate and save style";
    const send = async (text: string, ends: number) => {
      const input = await wd.waitFor(".ai-panel textarea:not(:disabled)", 30000); await wd.click(input); await wd.sendKeys(input, text); await click(".ai-send-btn:not(.ai-stop-btn):not(:disabled)");
      if (!await until(async () => (await items()).filter((item) => item.kind === "turnEnd").length >= ends, 60000)) throw new Error("Gallery AI turn did not finish");
    };
    await send("선택한 디자인으로 한 장 만들고 주조색을 파란색으로 해 줘. 이 스타일을 다시 쓰는 발표 스타일로 저장해 줘.", 1);
    const selection = await wd.execute<any>("return window.slidesApi.getTemplateSelection();"), saved = await wd.execute<any>("return window.slidesApi.loadStyleTemplate(arguments[0]);", name);
    ctx.report.check(S, "원본 generate_deck가 선택 디자인·추가 요청을 저장", selection?.key === ids[0] && selection.adjustments.includes("주조색을 파란색으로 해 줘"), JSON.stringify(selection));
    ctx.report.check(S, "원본 save_style_template가 기반 디자인·추가 요청·배치를 보존", saved.ok && saved.basedOn === ids[0] && saved.styleSkill.includes("주조색을 파란색으로 해 줘") && !!saved.layout, JSON.stringify(saved));
    const savedResult = await wd.execute<any>("return window.slidesApi.save();");
    ctx.report.check(S, "생성된 편집 가능 PPTX를 원래 등록 문서에 저장", savedResult?.ok && (await savedText(path, "pptx")).includes("GALLERY GENERATED 한글"), JSON.stringify(savedResult));
    ctx.report.check(S, "생성 스타일 sidecar가 실제 문서 옆에 저장", JSON.parse(readFileSync(path.replace(/\.pptx$/, ".styleskill.json"), "utf8")).styleSkill === saved.styleSkill);
    ctx.report.check(S, "선택한 스타일이 실제 페이지 생성 요청에 전달됨", requests.some((request) => !request.tools?.length && JSON.stringify(request.messages).includes("주조색을 파란색으로 해 줘")));
    await click(".ai-tpl-chip-main");
    await wd.waitFor(".ai-tpl-card-saved", 15000);
    const savedCard = await wd.execute<any>('return [...document.querySelectorAll(".ai-tpl-card-saved")].find(e=>e.textContent.includes(arguments[0]));', name);
    if (!savedCard) throw new Error("Saved style gallery card missing"); await wd.execute('arguments[0].scrollIntoView({block:"center"});', savedCard); await wd.click(savedCard);
    ctx.report.check(S, "저장한 스타일이 갤러리에 나타나고 선택됨", (await wd.execute<any>("return window.slidesApi.getTemplateSelection();"))?.key === name, undefined, await shot(ctx, "gallery-saved.png"));
    phase = "native restart"; const count = requests.length;
    await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "gallery-restarted" }); wd = ctx.app.wd; await wd.setWindowRect({ width: 1900, height: 1200 }); await enter(source.id);
    const restored = await wd.execute<any>("return window.slidesApi.getTemplateSelection();");
    ctx.report.check(S, "실제 앱·호스트 재시작 후 저장 스타일 선택·추가 요청 판 보존", restored?.kind === "saved" && restored.key === name && requests.length === count, JSON.stringify(restored), await shot(ctx, "gallery-restored.png"));
    phase = "reuse style"; operation = "reuse"; step = 0;
    await send("저장한 다시 쓰는 발표 스타일로 한 장을 더 만들어 줘.", 2);
    const resaved = await wd.execute<any>("return window.slidesApi.save();"), text = await savedText(path, "pptx");
    ctx.report.check(S, "재시작 뒤 같은 대화에서 스타일 재사용·페이지 추가·저장", resaved?.ok && text.includes("GALLERY GENERATED 한글") && text.includes("GALLERY REUSED 한글") && (await items()).filter((item) => item.kind === "turnEnd").length === 2);
    ctx.report.check(S, "새 세션 중복 생성 없음", (await snapshot()).sessions.filter((entry) => entry.workId === work.id).length === 1);
    ctx.report.check(S, "페이지 예외 없음", (await pageErrors(wd)).length === 0, JSON.stringify(await pageErrors(wd)));
    writeFileSync(ctx.report.path("gallery-evidence.json"), JSON.stringify({ ids, translations, fonts, selection, saved, restored, requests, items: await items() }, null, 2));
  } catch (error) { ctx.report.check(S, `시나리오 진행 (${phase})`, false, String(error), await shot(ctx, "gallery-failure.png")); throw error; }
  finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
