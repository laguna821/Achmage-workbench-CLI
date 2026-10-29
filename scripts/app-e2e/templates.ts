import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, CreateTarget, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

export async function templatesScenario(ctx: Ctx) {
  const S = "10 사용자 양식", { api, wd } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "개인 양식 검사", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const tab = { id: "template-chat", workId: work.id, sessionId: session.id, view: { kind: "work" as const } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "template-pane", panes: [{ ...tab, id: "template-pane", tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] }] } });
  await wd.setWindowRect({ width: 1600, height: 1100 }); await wd.refresh(); await installProbe(wd);
  const original = join(ctx.stage.root, "Meeting Form.md"), body = "# MEETING FORM\n\n## Participants\n\n## Decisions\n";
  writeFileSync(original, body);
  const originalHash = createHash("sha256").update(body).digest("hex");
  const clickText = async (selector: string, text: string) => {
    for (const el of await wd.findAll(selector)) if ((await wd.execute<string>('return arguments[0].textContent.trim();', el)).includes(text)) {
      await wd.execute('arguments[0].scrollIntoView({block:"center",inline:"nearest"});', el); await wd.click(el); return;
    }
    throw new Error(`Missing command: ${text}`);
  };
  const chat = '.pane:not([hidden]) .work-view';
  await wd.click(await wd.waitFor(`${chat} [aria-label="새 문서로 만들기"]`));
  await clickText('[role="menuitem"]', "내 양식·스킬에서 만들기");
  await wd.waitFor('[aria-label="양식·스킬 보관함"]');
  await clickText('.skill-toolbar button', "내 양식 등록");
  const fields = await wd.findAll('.skill-form label > input');
  await wd.sendKeys(fields[0]!, "Native Meeting Form"); await wd.sendKeys(fields[1]!, "A personal meeting form");
  await wd.sendKeys(await wd.waitFor('.skill-form .skill-path input'), original);
  await wd.sendKeys(await wd.waitFor('.skill-form textarea'), "Keep the form headings and fill the meeting content.");
  await clickText('.skill-form > button', "등록 내용 확인");
  await wd.waitFor('[aria-label="가져오기 확인"]');
  ctx.report.check(S, "개인 문서를 등록하기 전 파일·양식 포함 정보 확인", await wd.execute<boolean>('return document.querySelector(".skill-candidate")?.textContent.includes("양식 포함") === true;') && readFileSync(original, "utf8") === body, undefined, await shot(ctx, "10-template-import-preview.png"));
  await clickText('.skill-import-overlay button', "보관함에 가져오기");
  if (!await until(async () => !await wd.find('.skill-import-overlay'))) throw new Error("Template import did not finish");
  const toggle = await wd.waitFor('.skill-toggle input');
  ctx.report.check(S, "가져온 스킬은 꺼진 상태이며 원본 문서 보존", await wd.execute<boolean>('return !arguments[0].checked;', toggle) && readFileSync(original, "utf8") === body);
  await wd.click(toggle);
  if (!await until(async () => await wd.execute<boolean>('return arguments[0].checked && !arguments[0].disabled;', toggle))) throw new Error("Template was not enabled");
  await clickText('.skill-actions button', "양식 미리보기");
  await wd.waitFor('.skill-preview pre');
  ctx.report.check(S, "앱 안에서 선택한 원본 판의 내용과 해시 미리보기", await wd.execute<boolean>('const e=document.querySelector(".skill-preview"); return e?.textContent.includes("MEETING FORM") && e.textContent.includes(arguments[0]);', originalHash.slice(0, 12)), undefined, await shot(ctx, "10-template-preview.png"));
  await clickText('.skill-preview button', "이 양식으로 새 문서");
  ctx.report.check(S, "같은 대화 입력창에 양식과 새 문서 이름 연결", await wd.execute<boolean>('return document.querySelector(arguments[0])?.textContent.includes("Native Meeting Form") === true;', `${chat} .create-chip`));
  const input = await wd.waitFor(`${chat} .composer-input`), request = "Fill this meeting. [[template-fill]]";
  await wd.sendKeys(input, request); await wd.click(await wd.waitFor(`${chat} [aria-label="보내기"]`));
  const messages = async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
  const sent = await until(async () => (await messages()).some((item) => item.kind === "user" && item.text === request));
  const user = (await messages()).find((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user" && item.text === request);
  if (!sent || !user?.create?.template) throw new Error("Template metadata was not sent");
  await until(async () => (await snapshot()).sessions.find((item) => item.id === session.id)?.status === "idle");
  ctx.report.check(S, "양식 사본만 편집하고 같은 세션에 요청 한 번 전달", readFileSync(user.create.path, "utf8").includes("NATIVE TEMPLATE FILLED") && readFileSync(original, "utf8") === body && user.create.template.sha256 === originalHash && (await snapshot()).sessions.filter((item) => item.workId === work.id).length === 1, undefined, await shot(ctx, "10-template-result.png"));
  const create: CreateTarget = { format: "markdown", name: "Meeting Form", template: user.create.template };
  const duplicate = await api<{ duplicate: boolean }>("POST", `/api/sessions/${session.id}/messages`, { requestId: user.id.replace(/^user:/, ""), text: request, create });
  ctx.report.check(S, "같은 요청 재전송은 두 번째 문서나 메시지를 만들지 않음", duplicate.duplicate && readdirSync(work.cwd).filter((name) => name.startsWith("Meeting Form")).length === 1 && (await messages()).filter((item) => item.kind === "user" && item.text === request).length === 1);
  const artifact = (await snapshot()).artifacts.find((item) => item.path === user.create!.path) as Artifact | undefined;
  if (!artifact) throw new Error("Template result was not tracked");
  const opened = await until(async () => await wd.execute<boolean>('return document.querySelector(".pane:not([hidden]) .document-view") !== null;'));
  ctx.report.check(S, "완성한 문서는 기존 대화를 유지하며 새 내부 탭으로 한 번 열림", opened && await wd.execute<boolean>('return document.querySelectorAll(".pane:not([hidden]) .document-view").length === 1 && document.querySelectorAll(".pane[hidden] .work-view").length === 1;'));
  const doc = { ...tab, id: "template-result", view: { kind: "document", artifactId: artifact.id, proposalId: null } };
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "template-pane", panes: [{ ...doc, id: "template-pane", tabs: [doc], activeTabId: doc.id, recentTabIds: [doc.id] }] } });
  await wd.refresh(); await installProbe(wd);
  const editor = await wd.waitFor('.pane:not([hidden]) .cm-content[contenteditable="true"]');
  ctx.report.check(S, "생성한 사본을 기존 내부 편집기에서 다시 열기", await wd.execute<boolean>('return arguments[0].textContent.includes("NATIVE TEMPLATE FILLED");', editor), undefined, await shot(ctx, "10-template-reopened.png"));
  ctx.report.check(S, "사용자 양식 흐름 중 페이지 예외 없음", !(await pageErrors(wd)).length);
}
