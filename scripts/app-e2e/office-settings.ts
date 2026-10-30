import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installProbe, pageErrors, shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";
import type { LaunchOptions } from "./launch.ts";
import type { Snapshot } from "@workbench/contracts";

/** The original settings UI, real Rust vault and original HTTP model adapter on a local fixture. */
export async function officeSettingsScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "Office AI 설정", requests: { path: string; auth: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += String(chunk);
    const body = text ? JSON.parse(text) : null;
    requests.push({ path: req.url ?? "", auth: req.headers.authorization ?? "", body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "fixture-settings-model" }, { id: "fixture-other-model" }] }));
    else if (req.url === "/v1/chat/completions") res.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local model fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`, path = join(ctx.app.dataDir, "office/ai-settings.json");
  let wd = ctx.app.wd;
  const click = async (css: string) => wd.click(await wd.waitFor(css));
  const replace = async (css: string, value: string) => {
    const el = await wd.waitFor(css); await wd.click(el);
    await wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value: "a" }, { type: "keyUp", value: "a" }, { type: "keyUp", value: KEY.control }]);
    await wd.sendKeys(el, value);
  };
  const saved = () => JSON.parse(readFileSync(path, "utf8"));
  const snapshot = () => ctx.app.api<{ revision: string; settings: any }>("GET", "/api/office-ai/settings");
  const open = async () => {
    await click('button[aria-label="연결과 설정"]');
    const button = await wd.execute<Record<string, string>>('return [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "문서 AI 설정…");');
    if (!button) throw new Error("Office settings menu missing");
    await wd.click(button);
    const frame = await wd.waitFor('iframe[title="문서 AI 설정 화면"]');
    await wd.frame(frame); await wd.waitFor(".set-adv-toggle", 15000); await installProbe(wd);
  };
  const advanced = async () => { await click(".set-adv-toggle"); await wd.waitFor("#set-ai-key"); };
  const close = async () => { await wd.frame(null); await click('button[aria-label="문서 AI 설정 닫기"]'); };
  try {
    const initial = (await snapshot()).settings;
    const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
    initial.providers.codex.cliPath = join(fixtures, "fake-codex.mjs");
    initial.providers["claude-code"].cliPath = join(fixtures, "fake-claude.mjs");
    initial.provider = "custom"; initial.customEndpoint = "settings-fixture";
    initial.customEndpoints = [{ id: "settings-fixture", name: "로컬 검사", kind: "api", baseUrl, apiKey: "", model: "fixture-settings-model" }];
    initial.search.provider = "tavily";
    mkdirSync(join(ctx.app.dataDir, "office"), { recursive: true }); writeFileSync(path, JSON.stringify(initial));
    const untouched = readFileSync(path);
    await open();
    ctx.report.check(S, "메뉴에서 원본 구독·무료 연결·고급 설정 화면 열기", await wd.execute<boolean>('return !!document.querySelector("#set-free-ai") && !!window.aiOffice && !!window.aiOfficeSubscription && !window.homeApi;'), undefined, await shot(ctx, "office-settings-open.png"));
    ctx.report.check(S, "설정 열기는 저장 파일과 키를 변경하지 않음", readFileSync(path).equals(untouched));
    await wd.frame(null);
    const settingsFrame = await wd.waitFor('iframe[title="문서 AI 설정 화면"]');
    const settingsUrl = await wd.attribute(settingsFrame, "src");
    const editorOrigin = `http://127.0.0.1:${readFileSync(join(ctx.app.dataDir, "editors-port"), "utf8").trim()}`;
    await wd.execute('const f=document.createElement("iframe");f.id="office-origin-probe";f.src=arguments[0]+"/office/docs.html";document.body.append(f);return true;', editorOrigin);
    await wd.frame(await wd.waitFor("#office-origin-probe"));
    await until(() => wd.execute<boolean>('return location.protocol === "http:";'));
    const isolated = await wd.execute<boolean>('try { void window.parent.frames[0].aiOffice; return false; } catch (e) { return e.name === "SecurityError"; }');
    ctx.report.check(S, "문서 프레임에서 설정 프레임 접근 차단·별도 origin", isolated && !!settingsUrl && new URL(settingsUrl).origin !== editorOrigin && new URL(settingsUrl).origin !== ctx.app.gateway.url);
    await wd.frame(null); await wd.execute('document.getElementById("office-origin-probe").remove();return true;'); await wd.frame(settingsFrame);
    await advanced();
    const catalog = await until(async () => await wd.execute<boolean>('return !!document.querySelector(".gs-dd-btn[data-value=fixture-settings-model]");'));
    ctx.report.check(S, "원본 사용자 서버 모델 목록이 호스트를 통해 표시", catalog && requests.some((r) => r.path === "/v1/models"));
    await replace("#set-ai-key", "private-ui-fixture-key");
    await click(".set-pane-actions > button:nth-last-child(2)");
    const pinged = await until(async () => requests.some((r) => r.path === "/v1/chat/completions"));
    const ping = requests.find((r) => r.path === "/v1/chat/completions");
    ctx.report.check(S, "저장 전 키로 선택한 제공자만 고정 연결 시험", pinged && ping?.auth === "Bearer private-ui-fixture-key" && JSON.stringify(ping.body.messages).includes("ping") && readFileSync(path).equals(untouched));
    await click(".set-pane-actions > button.primary");
    const encrypted = await until(async () => saved().customEndpoints[0]?.apiKey?.startsWith("sealed:v1:workbench:"));
    ctx.report.check(S, "원본 저장 버튼이 실제 OS 키링으로 암호화 저장", encrypted && !readFileSync(path, "utf8").includes("private-ui-fixture-key"));
    await until(async () => await wd.execute<boolean>('return document.querySelector(".set-pane-actions > button.primary").disabled;'));
    await replace("#set-ai-endpoint-name", "다시 저장");
    const nameDraft = await wd.execute<string>('return document.querySelector("#set-ai-endpoint-name").value;');
    await click(".set-pane-actions > button.primary");
    const renamed = await until(async () => saved().customEndpoints[0]?.name === "다시 저장");
    ctx.report.check(S, "한글·띄어쓰기와 연속 저장의 갱신된 키 참조 보존", nameDraft === "다시 저장" && renamed, JSON.stringify({ typed: nameDraft, saved: saved().customEndpoints[0]?.name }));
    await click(".set-adv-tab:last-child"); await wd.waitFor("#set-ai-search-key");
    await replace("#set-ai-search-key", "private-search-fixture-key"); await click(".set-pane-actions > button.primary");
    ctx.report.check(S, "원본 미디어·검색 설정의 키도 암호화 저장", await until(async () => saved().search.providers.tavily.apiKey.startsWith("sealed:v1:workbench:")) && !readFileSync(path, "utf8").includes("private-search-fixture-key"));
    const prefs = (await ctx.app.api<Snapshot>("GET", "/api/snapshot")).prefs;
    await ctx.app.api("PUT", "/api/prefs", { prefs: { ...prefs, theme: "dark" } });
    const dark = await until(() => wd.execute<boolean>('return document.documentElement.dataset.theme === "dark" && getComputedStyle(document.body).backgroundColor !== "rgb(255, 255, 255)";'));
    await wd.frame(null);
    const darkShell = await wd.execute<boolean>('return getComputedStyle(document.querySelector(".office-settings-dialog")).backgroundColor !== "rgb(255, 255, 255)";');
    await wd.frame(await wd.waitFor('iframe[title="문서 AI 설정 화면"]'));
    ctx.report.check(S, "앱 테마와 원본 설정·대화상자 테마 동기화", dark && darkShell, undefined, await shot(ctx, "office-settings-dark.png"));
    const firstErrors = await pageErrors(wd); await close();
    await ctx.app.close(); ctx.app = await ctx.stage.launch({ ...launch, name: "office-settings-reopened", freshPort: true }); wd = ctx.app.wd;
    await wd.waitFor('button[aria-label="연결과 설정"]'); await open(); await advanced();
    const masked = await wd.execute<string>('return document.querySelector("#set-ai-key").value;');
    const count = requests.filter((r) => r.path === "/v1/chat/completions").length;
    await click(".set-pane-actions > button:nth-last-child(2)");
    ctx.report.check(S, "앱·독립 키링 재시작 후 키 노출 없이 다시 연결", masked.startsWith("__workbench_secret_ref_") && await until(async () => requests.filter((r) => r.path === "/v1/chat/completions").length > count) && requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.auth === "Bearer private-ui-fixture-key", undefined, await shot(ctx, "office-settings-reopened.png"));
    const old = await snapshot(); await ctx.app.api("PUT", "/api/office-ai/settings", { settings: { ...old.settings, maxOutputTokens: 7777 }, expectedRevision: old.revision });
    let rejected = false;
    try { await ctx.app.api("PUT", "/api/office-ai/settings", { settings: old.settings, expectedRevision: old.revision }); }
    catch (error) { rejected = String(error).includes("office_settings_changed"); }
    ctx.report.check(S, "오래된 설정 저장은 거절하고 외부 변경 보존", rejected && saved().maxOutputTokens === 7777);
    const errors = [...firstErrors, ...await pageErrors(wd)];
    ctx.report.check(S, "원본 화면 JavaScript 오류 없음", errors.length === 0, errors.join("\n"));
    await close();
  } finally { await wd.frame(null).catch(() => {}); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
