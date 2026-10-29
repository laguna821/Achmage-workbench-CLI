import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { installProbe, pageErrors, seedLayout, shot, until, type Ctx } from "./scenarios.ts";

export async function referencesScenario(ctx: Ctx) {
  const S = "9 문서 참조";
  const { wd, api } = ctx.app;
  const work = await api<Work>("POST", "/api/works", { title: "참조 전달 검사", cwd: null });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex" });
  const source = await api<Artifact>("POST", `/api/works/${work.id}/pages`, { name: "참조 원문" });
  const target = await api<Artifact>("POST", `/api/works/${work.id}/pages`, { name: "요청 대상" });
  const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
  const original = readFileSync(source.path, "utf8");
  const panes = [source, target].map((doc, index) => {
    const tab = { id: `reference-${index}`, workId: work.id, sessionId: session.id, view: { kind: "document", artifactId: doc.id, proposalId: null } };
    return { ...tab, id: `ref-${index}`, tabs: [tab], activeTabId: tab.id, recentTabIds: [tab.id] };
  });
  await seedLayout(ctx, { ...(await snapshot()).prefs, paneLayout: { version: 2, focus: "ref-1", panes } });
  await wd.setWindowRect({ width: 1800, height: 1100 }); await wd.refresh(); await installProbe(wd);
  const left = '.pane[data-tab="reference-0"]', right = '.pane[data-tab="reference-1"]';
  const editor = await wd.waitFor(`${left} .cm-content[contenteditable="true"]`);
  const composer = await wd.waitFor(`${right} .composer-input`);
  const clickText = async (selector: string, label: string) => {
    for (const element of await wd.findAll(selector)) {
      if ((await wd.execute<string>('return arguments[0].textContent.trim();', element)).includes(label)) {
        await wd.execute('arguments[0].scrollIntoView({block:"center",inline:"nearest"});', element);
        await wd.click(element); return;
      }
    }
    throw new Error(`Missing visible command: ${label}`);
  };
  const messages = async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items.filter((item): item is Extract<TranscriptItem, { kind: "user" }> => item.kind === "user");
  await wd.click(composer); await wd.sendKeys(composer, "@");
  await wd.waitFor(`${right} .mention-row`);
  await clickText(`${right} .mention-row`, source.name);
  await wd.sendKeys(composer, "COMPARE SAVED SOURCE");
  await clickText(`${right} [aria-label="요청 종류"] button`, "검토 요청");
  ctx.report.check(S, "@ 목록에서 열린 다른 문서를 골라 같은 세션의 문서 채팅에 첨부", await wd.execute<boolean>('return arguments[0].closest(".document-view").textContent.includes("보낼 때 저장");', composer), undefined, await shot(ctx, "9-reference-attached.png"));

  // The user's draft conflicts with a real external file; it must not silently become old context.
  await wd.click(editor); await wd.sendKeys(editor, " UNSAVED REFERENCE DRAFT");
  writeFileSync(source.path, "EXTERNAL REFERENCE\n");
  await api("POST", `/api/artifacts/${source.id}/adopt-disk`);
  await wd.waitFor(`${left} .doc-conflict`);
  await wd.click(await wd.waitFor(`${right} [aria-label="보내기"]`));
  await until(async () => await wd.execute<boolean>('return !arguments[0].disabled;', await wd.waitFor(`${right} [aria-label="보내기"]`)));
  ctx.report.check(S, "미저장 참조의 저장 충돌이면 요청과 파일 덮어쓰기를 보류", !(await messages()).length && readFileSync(source.path, "utf8") === "EXTERNAL REFERENCE\n" && await wd.execute<boolean>('return arguments[0].textContent.includes("UNSAVED REFERENCE DRAFT");', editor));

  await clickText(`${right} .ref-chip button`, "저장된 판만");
  await until(async () => await wd.execute<boolean>('return arguments[0].closest(".document-view").textContent.includes("고정 · 미저장 제외");', composer));
  const fixed = (await snapshot()).artifacts.find((doc) => doc.id === source.id)!;
  writeFileSync(source.path, "AFTER PIN EXTERNAL\n");
  await api("POST", `/api/artifacts/${source.id}/adopt-disk`);
  await wd.click(await wd.waitFor(`${right} [aria-label="보내기"]`));
  const delivered = await until(async () => (await messages()).length === 1);
  const first = (await messages())[0];
  ctx.report.check(S, "저장된 판 명시 선택은 이후 변경과 분리된 판·해시로 같은 세션에 한 번 전달", delivered && first?.refs?.some((ref) => ref.artifactId === source.id && ref.revision === fixed.revision && ref.sha256 === fixed.sha256 && ref.savedSnapshot) === true && (await snapshot()).sessions.filter((row) => row.workId === work.id).length === 1, undefined, await shot(ctx, "9-pinned-snapshot-sent.png"));
  ctx.report.check(S, "읽기 참조 전송 뒤에도 원문의 외부 수정과 미저장 편집을 보존", readFileSync(source.path, "utf8") === "AFTER PIN EXTERNAL\n" && await wd.execute<boolean>('return arguments[0].textContent.includes("UNSAVED REFERENCE DRAFT");', editor));

  await clickText(`${left} .doc-conflict button`, "내 편집을 새 판으로");
  if (!await until(async () => readFileSync(source.path, "utf8").includes("UNSAVED REFERENCE DRAFT"))) throw new Error("Reference draft did not save after explicit conflict resolution");
  await until(async () => (snapshot().then((state) => state.sessions.find((row) => row.id === session.id)?.status === "idle")));
  await wd.click(await wd.waitFor(`${right} [aria-label="참조 문서 붙이기"]`));
  await clickText(`${right} [role="menuitem"]`, source.name);
  await wd.click(composer); await wd.sendKeys(composer, "READ LATEST REFERENCE");
  await wd.click(await wd.waitFor(`${right} [aria-label="보내기"]`));
  const again = await until(async () => (await messages()).length === 2);
  const second = (await messages())[1];
  const latestHash = createHash("sha256").update(readFileSync(source.path)).digest("hex");
  ctx.report.check(S, "+로 다시 붙인 후속 요청은 저장한 최신 판을 읽고 이전 요청은 고정 유지", again && second?.refs?.some((ref) => ref.artifactId === source.id && ref.revision > fixed.revision && ref.sha256 === latestHash && !ref.savedSnapshot) === true && (await messages())[0]?.refs?.some((ref) => ref.artifactId === source.id && ref.sha256 === fixed.sha256) === true && original !== readFileSync(source.path, "utf8"));
  await until(async () => (await snapshot()).sessions.find((row) => row.id === session.id)?.status === "idle");
  await clickText(`${right} .doc-header > button`, "대화");
  const chat = '.pane:not([hidden]) .work-view';
  await wd.click(await wd.waitFor(`${chat} [aria-label="문서·파일 붙이기"]`));
  await clickText(`${chat} [role="menuitem"]`, source.name);
  const chatInput = await wd.waitFor(`${chat} .composer-input`);
  const chatTab = await wd.execute<string>('return arguments[0].closest(".pane").dataset.tab;', chatInput);
  await wd.execute('arguments[0].dataset.referenceComposer = "kept";', chatInput);
  if (!await wd.execute<boolean>('return arguments[0].closest(".work-view").querySelector(".composer-header")?.textContent.includes(arguments[1]) === true;', chatInput, source.name)) throw new Error("Reference was not attached in the normal conversation");
  await wd.click(chatInput); await wd.sendKeys(chatInput, "CHAT FOLLOWUP");
  await wd.click(editor); await wd.sendKeys(editor, " WORKVIEW EDIT");
  const retained = await wd.execute<boolean>('const input = document.querySelector(arguments[0]); return input?.dataset.referenceComposer === "kept" && input.closest(".pane").dataset.tab === arguments[1] && input.closest(".work-view").querySelector(".composer-header")?.textContent.includes(arguments[2]) === true;', `${chat} .composer-input`, chatTab, source.name);
  ctx.report.check(S, "옆 칸 편집 후에도 대화 탭·입력창 DOM·첨부 선택 유지", retained);
  if (!retained) throw new Error("Conversation identity or its reference selection changed during pane focus");
  await wd.click(await wd.waitFor(`${chat} [aria-label="보내기"]`));
  const inChat = await until(async () => (await messages()).length === 3);
  const third = (await messages())[2];
  const chatHash = createHash("sha256").update(readFileSync(source.path)).digest("hex");
  ctx.report.check(S, "일반 대화창도 열린 문서의 편집을 저장한 뒤 같은 세션에 최신 판 전달", inChat && readFileSync(source.path, "utf8").includes("WORKVIEW EDIT") && third?.refs?.some((ref) => ref.artifactId === source.id && ref.sha256 === chatHash) === true && (await snapshot()).sessions.filter((row) => row.workId === work.id).length === 1, undefined, await shot(ctx, "9-chat-latest-reference.png"));
  ctx.report.check(S, "참조 선택·저장·전송 중 페이지 예외 없음", !(await pageErrors(wd)).length);
}
