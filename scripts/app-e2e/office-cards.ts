import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import type { OfficeSkillView } from "../../packages/contracts/src/office-skills.ts";
import type { Engines } from "./launch.ts";
import { fixture } from "./office-suite.ts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

const COMPOSER = ".ai-panel textarea:not(:disabled), .copilot textarea:not(:disabled)";
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Original propose_skill UI and use_skill tool in the real Tauri/WebKit app.
 * The provider alone is a deterministic local SSE server; saves use the actual host. */
export async function officeCardsScenario(ctx: Ctx, launch: { binary: string; engines: Engines; profile?: string }) {
  let wd = ctx.app.wd, requests: any[] = [], name = "", targetId: string | undefined, selectedId = "", operation: "propose" | "auto" = "propose";
  const api = <T,>(method: string, path: string, body?: unknown) => ctx.app.api<T>(method, path, body);
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const formats = ["pptx", "docx", "xlsx", "html", "hwpx", "xmind", "epub", "md", "pdf"] as const;
  const chosen = process.env.APP_E2E_OFFICE_CARD_FORMATS?.split(",") ?? [...formats];
  if (chosen.some((format) => !(formats as readonly string[]).includes(format))) throw new Error("Unknown card format");
  let toolSequence = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += String(part);
      if (req.url !== "/v1/chat/completions") { res.statusCode = 404; res.end(); return; }
      const body = JSON.parse(raw); requests.push(body); res.setHeader("content-type", "text/event-stream");
      const send = (delta: unknown, finish_reason: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (body.messages.at(-1)?.role !== "tool") {
        const tool = operation === "auto" ? "use_skill" : "propose_skill";
        if (!body.tools?.some((t: any) => t.function?.name === tool)) throw new Error(`Original ${tool} missing`);
        const input = operation === "auto" ? { id: selectedId } : { name, description: "Save repeatable document work", body: "NATIVE_CARD_BODY", wantsTemplate: false, ...(targetId ? { targetId } : {}) };
        send({ role: "assistant", tool_calls: [{ index: 0, id: `card-${++toolSequence}`, type: "function", function: { name: tool, arguments: JSON.stringify(input) } }] }, "tool_calls");
      } else send({ role: "assistant", content: "CARD_TURN_COMPLETE" }, "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const enter = async (id: string, format: string) => {
    await wd.frame(null); await wd.frame(await wd.waitFor(`iframe.office-frame[src*=${JSON.stringify(`a=${id}`)}]`, 30000)); await installProbe(wd);
    if (format === "xlsx" && !await until(() => wd.execute<boolean>('return !!document.querySelector("#univer-container canvas") && !document.body.innerText.includes("통합 문서를 여는 중");'), 45000)) throw new Error("Workbook not ready");
    if (!await until(async () => { const input = await wd.find(COMPOSER); return !!input && await wd.displayed(input); }, 45000)) throw new Error("Original composer not ready");
  };
  const send = async (text: string) => { const input = await wd.waitFor(COMPOSER); await wd.click(input); await wd.sendKeys(input, text); await wd.click(await wd.waitFor(".ai-send-btn:not(.ai-stop-btn):not(:disabled)")); };
  const savedLine = (name: string) => until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-skill-card-status=saved]")].some(e=>e.textContent.includes(arguments[0]));', name));
  const clickSettled = async (selector: string) => {
    const element = await wd.waitFor(selector);
    await wd.execute('arguments[0].scrollIntoView({block:"center"});', element);
    let previous = "", stable = 0;
    if (!await until(async () => { const current = JSON.stringify(await wd.rect(element)); stable = current === previous ? stable + 1 : 0; previous = current; return stable >= 3; }, 10000)) throw new Error(`Control kept moving: ${selector}`);
    await wd.click(element);
  };
  try {
    const settings = (await api<{ settings: any }>("GET", "/api/office-ai/settings")).settings;
    settings.provider = "custom"; settings.subscriptionNoticeSeen = true; settings.customEndpoint = "cards-fixture";
    settings.customEndpoints = [{ id: "cards-fixture", name: "Local card fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", model: "cards-model", kind: "local", modelProfiles: { "cards-model": { tools: true, toolsSource: "user", contextLength: 1000000, contextSource: "user" } } }];
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(join(ctx.app.dataDir, "office/ai-settings.json"), JSON.stringify(settings));
    for (const format of chosen as (typeof formats)[number][]) {
      const S = `Office 카드 ${format}`; requests = []; operation = "propose"; targetId = undefined; name = `native-card-${format}`;
      try {
        const work = await api<Work>("POST", "/api/works", { title: `스킬 카드 ${format}`, cwd: null }), path = join(work.cwd, `원본.${format}`);
        if (format === "docx") copyFileSync(resolve("vendor/ieumoffice/apps/docs/tests/pagination-corpus/docx/simple.docx"), path); else await fixture(path, format);
        const sourceHash = hash(path), own = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path });
        const tab = { id: "card-source", workId: work.id, sessionId: null as string | null, view: { kind: "document", artifactId: own.id, proposalId: null }, ui: { mode: format === "html" || format === "md" ? "rich" : "edit" } };
        const layout = () => ({ version: 2, focus: "card-pane", panes: [{ ...tab, id: "card-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] });
        await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout() }); await wd.setWindowRect({ width: 1900, height: 1200 }); await wd.refresh(); await enter(own.id, format);
        await send("이 문서 작업을 재사용할 스킬로 제안해 줘");
        let session: Session | undefined;
        if (!await until(async () => { session = (await snapshot()).sessions.find((s) => s.workId === work.id); return !!session; }, 20000)) throw new Error("First card session missing");
        let ended = 1;
        const waitTurn = async () => { if (!await until(async () => (await items(session!.id)).filter((i) => i.kind === "turnEnd").length >= ended, 60000)) throw new Error("Card turn did not finish"); };
        await waitTurn(); await wd.waitFor(".ai-skill-card", 15000);
        const cardPath = join(ctx.app.dataDir, "user-skills", name, "SKILL.md");
        ctx.report.check(S, "원본 propose_skill 카드·저장 전 보관함에 쓰지 않음", !existsSync(cardPath), undefined, await shot(ctx, `cards-${format}-proposal.png`));
        const body = await wd.waitFor(".ai-skill-card-body"); await wd.click(body); await wd.sendKeys(body, " PERSON_EDITED_CARD");
        await wd.click(await wd.waitFor(".ai-skill-card .primary:not(:disabled)", 15000));
        if (!await savedLine(name)) throw new Error(`Saved card line missing: ${await wd.execute('return document.body.innerText.slice(-4000);')}`);
        const listed = await wd.execute<OfficeSkillView[]>("return window.aiOfficeUserSkills.list();"), saved = listed.find((s) => s.name === name)!; selectedId = saved.id;
        ctx.report.check(S, "사람이 수정한 본문·자동 호출 선택을 기존 보관함에 저장", existsSync(cardPath) && readFileSync(cardPath, "utf8").includes("PERSON_EDITED_CARD") && saved.enabled && saved.invoke === "auto" && saved.owned, undefined, await shot(ctx, `cards-${format}-saved.png`));
        ctx.report.check(S, "같은 대화에 저장 결과를 한 번만 기록·원본 문서 보존", (await items(session!.id)).filter((i) => i.office?.cardSaved).length === 1 && hash(path) === sourceHash);
        requests = []; operation = "auto"; ended++; await send("방금 저장한 스킬을 알아서 골라 적용해 줘"); await waitTurn();
        const afterUse = await items(session!.id);
        ctx.report.check(S, "원본 use_skill 도구로 저장한 최신 사용자 본문 읽기", afterUse.some((i) => i.kind === "tool" && i.detail?.startsWith("use_skill\n") && i.status === "completed" && i.output?.includes("PERSON_EDITED_CARD") === true) && JSON.stringify(requests).includes("PERSON_EDITED_CARD") && !JSON.stringify(requests).includes("skill-card-saved:"));
        const firstErrors = await pageErrors(wd);
        if (format === chosen[0]) {
          requests = []; operation = "propose"; targetId = selectedId; ended++; await send("이 스킬 본문을 다시 제안해 줘"); await waitTurn();
          await wd.waitFor('.ai-skill-card[data-skill-card-mode="edit-own"]', 15000);
          await clickSettled('.ai-skill-card input[value="manual"]');
          if (!await until(() => wd.execute<boolean>('return document.querySelector(".ai-skill-card input[value=manual]")?.checked === true;'))) throw new Error("Manual radio was not selected");
          const changed = await wd.waitFor(".ai-skill-card-body"); await wd.click(changed); await wd.sendKeys(changed, " OWN_EDITED_AGAIN");
          await wd.click(await wd.waitFor(".ai-skill-card .primary:not(:disabled)", 15000));
          if (!await until(() => wd.execute<boolean>('return !document.querySelector(".ai-skill-card");'))) throw new Error("Own edit did not close");
          const ownList = await wd.execute<OfficeSkillView[]>("return window.aiOfficeUserSkills.list();");
          ctx.report.check(S, "원본 내 스킬 수정 카드·수동 호출 선택·이전 폴더 백업", readFileSync(cardPath, "utf8").includes("OWN_EDITED_AGAIN") && ownList.find((s) => s.id === selectedId)?.invoke === "manual" && existsSync(join(ctx.app.dataDir, "skill-backups")));
          targetId = undefined; name = "native-cancelled-card"; ended++; await send("저장하지 않을 별도 스킬을 제안해 줘"); await waitTurn();
          await clickSettled(".ai-skill-card .ai-skill-card-actions > button:not(.primary)");
          const unsaved = await until(() => wd.execute<boolean>('return [...document.querySelectorAll("[data-skill-card-status=unsaved]")].some(e=>e.textContent.includes(arguments[0]));', name));
          const cancelled = { unsaved, exists: existsSync(join(ctx.app.dataDir, "user-skills", name)), hasSavedRecord: (await items(session!.id)).some((i) => i.office?.cardSaved?.label === name) };
          await wd.execute('document.querySelector("[data-skill-card-status=unsaved]")?.scrollIntoView({block:"center"});');
          ctx.report.check(S, "카드 취소는 보관함에 쓰지 않음", unsaved && !cancelled.exists && !cancelled.hasSavedRecord, JSON.stringify(cancelled), await shot(ctx, `cards-${format}-cancelled.png`));
          name = `native-card-${format}`;
        }
        tab.sessionId = session!.id; await wd.frame(null); await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: layout() });
        if (format === chosen[0]) { await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "cards-restarted" }); wd = ctx.app.wd; } else await wd.refresh();
        await wd.setWindowRect({ width: 1900, height: 1200 });
        await enter(own.id, format);
        const restored = await savedLine(name);
        await wd.execute('document.querySelector("[data-skill-card-status=saved]")?.scrollIntoView({block:"center"});');
        ctx.report.check(S, format === chosen[0] ? "실제 앱·host 재시작 뒤 저장된 카드 복원" : "문서 재열기 뒤 저장된 카드 복원", restored && !await wd.find(".ai-skill-card"), undefined, await shot(ctx, `cards-${format}-restored.png`));
        ctx.report.check(S, "카드·저장·자동 호출·복원 중 페이지 예외 없음", firstErrors.length === 0 && (await pageErrors(wd)).length === 0, JSON.stringify([...firstErrors, ...await pageErrors(wd)]));
        writeFileSync(ctx.report.path(`cards-${format}.json`), JSON.stringify({ items: await items(session!.id), requests, listed }, null, 2));
      } catch (error) {
        ctx.report.check(S, "카드 저장 진행", false, String(error), await shot(ctx, `cards-${format}-failed.png`).catch(() => null));
        writeFileSync(ctx.report.path(`cards-${format}-diagnostic.json`), JSON.stringify({ error: String(error), page: await wd.execute('return document.body.innerText.slice(-12000);').catch(() => null), errors: await pageErrors(wd).catch(() => []), requests }, null, 2)); break;
      } finally { await wd.frame(null); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
