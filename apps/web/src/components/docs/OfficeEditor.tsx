import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Artifact, DocumentAccess, EditorGrant, OfficePageMessage } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import type { RendererControlRequest, RendererControlReply } from "../../../../../packages/contracts/src/office-control.ts";
import type { BrowserResult, OfficeOutputFormat, OfficeOutputPlan, OfficeOutputRequest } from "../../../../../packages/contracts/src/office-output.ts";
import { OfficeOutputDialog } from "./OfficeOutputDialog.tsx";
import { OfficeReferencePicker } from "./OfficeReferencePicker.tsx";
import type { OfficeDocumentChoice, OfficeReferenceRequest, OfficeReferenceSnapshot } from "../../../../../packages/contracts/src/office-references.ts";
import { saveReferencedDocument } from "../../document-commands.ts";
import { pickOfficeFiles } from "./office-file-picker.ts";
import { SkillLibraryDialog } from "../SkillLibraryDialog.tsx";
import type { OfficeSkillRequest } from "../../../../../packages/contracts/src/office-skills.ts";

export type OfficeHandle = {
  control(request: RendererControlRequest): Promise<RendererControlReply>;
  /** Run the original renderer's PDF action on current, possibly unsaved content. */
  exportPdf(): void;
  exportDocx(): void;
  /** Save unsaved edits now; resolves with the saved revision, or null when they could not be saved. */
  flush(): Promise<number | null>;
  /** After a conflict: save my edits as the revision after `revision`; null when there was nothing to keep or it failed. */
  rebase(revision: number): Promise<number | null>;
  /** Open the latest revision; unsaved edits in the editor are dropped. */
  reload(): void;
  /** Before the view goes away: confirm saving. A failure/conflict keeps this editor mounted. */
  leave(): Promise<void>;
};

export type OfficeConflict = { code: string; message: string };
/** `revision`: what the editor's content is based on (null until it has opened). */
export type OfficeStatus = { dirty: boolean; revision: number | null; conflict: OfficeConflict | null };

/**
 * A Word, PowerPoint or Excel document in the central area, edited with IeumOffice's editor built
 * into Workbench (apps/office: /office/docs.html, slides.html, sheets.html, on the editors' own origin).
 * Saves become revisions; a save over a revision made elsewhere is refused and reported, and a
 * revision made elsewhere is opened when nothing here is unsaved.
 */
export const OfficeEditor = forwardRef<
  OfficeHandle,
  { api: Api; artifact: Artifact; access?: DocumentAccess; sessionId: string | null; hidden?: boolean; onStatus(status: OfficeStatus): void; onNotice(message: string): void; onCopied?(artifactId: string): void; onPrepareAi(revision: number): Promise<void>; onNewSession(revision: number): Promise<string>; onAiSettings(): void }
>(function OfficeEditor({ api, artifact, access, sessionId, hidden = false, onStatus, onNotice, onCopied, onPrepareAi, onNewSession, onAiSettings }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [generation, setGeneration] = useState(0);
  // Each opening of the page gets its own grant (a token for this document only).
  const [grant, setGrant] = useState<{ generation: number; value: EditorGrant } | { generation: number; error: string } | null>(null);
  const opened = useRef<EditorGrant | null>(null);
  const status = useRef<OfficeStatus>({ dirty: false, revision: null, conflict: null });
  const own = useRef(new Set<number>());
  // When the page last said a save of its own is on its way (0: none).
  const savingSince = useRef(0);
  const waiters = useRef<((revision: number | null) => void)[]>([]);
  // False only for the reload right after "open the latest revision": kept edits are dropped then.
  const recover = useRef(true);
  const handlers = useRef({ onStatus, onNotice, onCopied, onPrepareAi, onNewSession, onAiSettings });
  handlers.current = { onStatus, onNotice, onCopied, onPrepareAi, onNewSession, onAiSettings };
  const aiBusy = useRef(false);
  const referenceSnapshot = useRef<string | null>(null);
  const referenceSession = useRef<string | null>(null);
  const referencePickerClose = useRef<(() => void) | null>(null);
  const [referencePicker, setReferencePicker] = useState<{ items: OfficeDocumentChoice[]; choose(paths: string[] | null): void } | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const outputBusy = useRef(false);
  const outputClose = useRef<(() => void) | null>(null);
  const outputRequest = useRef<string | null>(null);
  const outputPlans = useRef(new Map<string, OfficeOutputPlan & { preparationId: string }>());
  const browserJobs = useRef(new Set<string>());
  const controlWaiters = useRef(new Map<string, (reply: RendererControlReply) => void>());
  const copied = useRef(new Map<string, string | null>());
  const [output, setOutput] = useState<{ revision: number; format: OfficeOutputFormat; choose(plan: OfficeOutputPlan | null): void } | null>(null);
  const latest = useRef(artifact);
  latest.current = artifact;

  const theme = () => (frame.current?.closest("[data-theme]")?.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const update = (patch: Partial<OfficeStatus>) => {
    status.current = { ...status.current, ...patch };
    if (frame.current) frame.current.dataset.revision = String(status.current.revision ?? "");
    handlers.current.onStatus(status.current);
  };
  const reconcile = () => {
    const shown = status.current.revision, revision = latest.current.revision;
    if (shown === null || revision <= shown || own.current.has(revision)) return;
    if (Date.now() - savingSince.current < 15_000) return;
    if (!status.current.dirty && !status.current.conflict) {
      update({ revision: null });
      setGeneration((value) => value + 1);
    } else if (!status.current.conflict) update({ conflict: { code: "revision_conflict", message: `다른 곳에서 r${revision}이 생겼습니다. 저장하지 않은 편집은 편집기에 그대로 있습니다.` } });
  };
  const send = (value: unknown) => {
    if (opened.current) frame.current?.contentWindow?.postMessage(value, opened.current.origin);
  };
  const waitFlushed = () =>
    new Promise<number | null>((resolve) => {
      const finish = (revision: number | null) => {
        window.clearTimeout(timer);
        waiters.current = waiters.current.filter((waiter) => waiter !== finish);
        resolve(revision);
      };
      const timer = window.setTimeout(() => finish(null), 16_000);
      waiters.current.push(finish);
    });

  const referenceCall = <T,>(action: string, input: Record<string, unknown> = {}) => {
    if (!opened.current) throw new Error("문서 창을 먼저 열어 주세요.");
    return api.officeReferences<T>(latest.current.id, opened.current.token, action, input);
  };
  const handleReference = async (message: OfficeReferenceRequest) => {
    const target = frame.current?.contentWindow, origin = opened.current?.origin;
    if (!target || !origin) return;
    const owner = latest.current.id, selectionSession = opened.current?.sessionId;
    const checkSelection = () => { if (target !== frame.current?.contentWindow || owner !== latest.current.id || selectionSession !== opened.current?.sessionId) throw new Error("첨부 중 문서 창이나 세션이 바뀌었습니다."); };
    const upload = async (file: File) => {
      checkSelection();
      if (!(file instanceof File) || file.size > 50 * 1024 * 1024) throw new Error("첨부는 파일당 50MB까지입니다.");
      return api.uploadOfficeReference(owner, opened.current!.token, file);
    };
    try {
      let value: unknown;
      if (message.action === "list") value = await referenceCall("list");
      else if (message.action === "add") value = await referenceCall("add", { paths: message.paths });
      else if (message.action === "read") value = await referenceCall("read", { snapshot: referenceSnapshot.current, path: message.path, offset: message.offset, length: message.length });
      else if (message.action === "read-image") {
        if (message.frozen && !referenceSnapshot.current) throw new Error("이번 요청의 첨부 판을 먼저 확인해 주세요.");
        value = await referenceCall("read-image", { snapshot: message.frozen ? referenceSnapshot.current : null, path: message.path });
      }
      else if (message.action === "upload") value = await upload(message.file);
      else if (message.action === "pick-files") {
        const picked = await pickOfficeFiles(); checkSelection();
        if (!picked) value = null;
        else if ("paths" in picked) value = await referenceCall("import", { paths: picked.paths });
        else {
          if (picked.files.length > 20) throw new Error("한 번에 20개까지 첨부해 주세요.");
          const combined: { accepted: unknown[]; rejected: string[] } = { accepted: [], rejected: [] };
          for (const file of picked.files) {
            try { const added = await upload(file); combined.accepted.push(...added.accepted); combined.rejected.push(...added.rejected); }
            catch (error) { combined.rejected.push(error instanceof Error ? error.message : String(error)); }
          }
          value = combined;
        }
      }
      else {
        if (referencePickerClose.current) value = { ok: false, reason: "busy" };
        else {
          const { items } = await referenceCall<{ items: OfficeDocumentChoice[] }>("list");
          checkSelection();
          if (referencePickerClose.current) throw new Error("다른 선택창이 열려 있습니다.");
          const paths = await new Promise<string[] | null>((resolve) => {
            const choose = (paths: string[] | null) => { referencePickerClose.current = null; setReferencePicker(null); resolve(paths); };
            referencePickerClose.current = () => choose(null);
            setReferencePicker({ items, choose });
          });
          value = paths ? { ok: true, paths } : { ok: false, reason: "cancelled" };
        }
      }
      checkSelection();
      target.postMessage({ type: "office:references-result", requestId: message.requestId, value }, origin);
    } catch (error) { target.postMessage({ type: "office:references-result", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }, origin); }
  };
  useEffect(() => {
    referenceSnapshot.current = null;
    referencePickerClose.current?.();
    return () => { referenceSnapshot.current = null; referencePickerClose.current?.(); };
  }, [artifact.id, generation]);
  useEffect(() => {
    if (referenceSession.current !== sessionId) referenceSnapshot.current = null;
    referencePickerClose.current?.();
  }, [sessionId]);

  const handleOutput = async (message: OfficeOutputRequest) => {
    const target = frame.current?.contentWindow, origin = opened.current?.origin;
    if (!target || !origin) return;
    const owner = latest.current.id, ownerSession = opened.current?.sessionId;
    const check = () => {
      if (target !== frame.current?.contentWindow || owner !== latest.current.id || ownerSession !== opened.current?.sessionId) throw new Error("저장 중 문서 창이나 연결된 대화가 바뀌었습니다. 저장한 사본은 문서 목록에서 확인해 주세요.");
    };
    const reply = (value: unknown, error?: string) => target.postMessage({ type: "office:output-result", requestId: message.requestId, value, error }, origin);
    if (message.action === "cancel") {
      if (message.preparationId && outputRequest.current === message.preparationId) outputClose.current?.();
      if (message.planId) outputPlans.current.delete(message.planId);
      if (message.preparationId) for (const [id, plan] of outputPlans.current) if (plan.preparationId === message.preparationId) outputPlans.current.delete(id);
      reply(null); return;
    }
    if (outputBusy.current) { reply(null, "다른 저장·출력 요청을 처리 중입니다."); return; }
    outputBusy.current = true;
    try {
      if (message.action === "commit") {
        const plan = outputPlans.current.get(message.planId);
        if (!plan || !(message.bytes instanceof ArrayBuffer)) throw new Error("저장 위치를 다시 선택하세요.");
        try {
          check();
          const result = await api.commitOfficeOutput(owner, plan.id, message.bytes, plan.replace);
          check();
          copied.current.set(result.artifact.id, ownerSession ?? null);
          reply({ path: result.path, artifactId: result.artifact.id });
          if (result.backupPath) handlers.current.onNotice(`이전 파일을 백업했습니다: ${result.backupPath}`);
        } finally { outputPlans.current.delete(plan.id); }
        return;
      }
      if (message.action === "browser") {
        if (!("__TAURI_INTERNALS__" in window)) throw new Error("문서 변환은 데스크톱 앱에서 실행해 주세요.");
        const { invoke } = await import("@tauri-apps/api/core");
        if (message.command.kind !== "create" && !browserJobs.current.has(message.command.id)) throw new Error("이 문서의 변환 창이 아닙니다.");
        const result = await invoke<BrowserResult | null>("office_browser", { command: message.command });
        if (result && "id" in result) {
          try { check(); } catch (error) { await invoke("office_browser", { command: { kind: "close", id: result.id } }).catch(() => {}); throw error; }
          browserJobs.current.add(result.id);
        }
        if (message.command.kind === "close") browserJobs.current.delete(message.command.id);
        check(); reply(result); return;
      }
      if (message.action === "html-render") {
        if (!("__TAURI_INTERNALS__" in window)) throw new Error("PDF 출력은 데스크톱 앱에서 실행해 주세요.");
        const { invoke } = await import("@tauri-apps/api/core");
        const bytes = await invoke<ArrayBuffer>("render_html_pdf", { job: message.job });
        check(); reply(bytes); return;
      }
      if (message.action === "print" || message.action === "html-print") {
        if (!("__TAURI_INTERNALS__" in window)) throw new Error("인쇄는 데스크톱 앱에서 실행해 주세요.");
        const { invoke } = await import("@tauri-apps/api/core"); await invoke(message.action === "print" ? "print_svg" : "print_html", { job: message.job });
        handlers.current.onNotice(message.action === "print" ? "인쇄 미리보기 창을 열었습니다." : "시스템 인쇄 창을 열었습니다."); reply({}); return;
      }
      const plan = await new Promise<OfficeOutputPlan | null>((resolve) => {
        const choose = (value: OfficeOutputPlan | null) => { outputClose.current = null; outputRequest.current = null; resolve(value); };
        outputRequest.current = message.requestId;
        outputClose.current = () => choose(null);
        setOutput({ revision: message.revision, format: message.action === "prepare" ? message.format : "pdf", choose });
      });
      setOutput(null);
      if (!plan) { reply(null); return; }
      check();
      if (message.action === "prepare") { outputPlans.current.set(plan.id, { ...plan, preparationId: message.requestId }); reply(plan); return; }
      if (!("__TAURI_INTERNALS__" in window)) throw new Error("PDF 출력은 데스크톱 앱에서 실행해 주세요.");
      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = await invoke<ArrayBuffer>(message.action === "html-pdf" ? "render_html_pdf" : "render_svg_pdf", { job: message.job });
      check();
      const result = await api.commitOfficeOutput(owner, plan.id, bytes, plan.replace);
      handlers.current.onNotice(`PDF를 저장했습니다: ${result.path}`);
      reply({ path: result.path, artifactId: result.artifact.id });
    } catch (error) { reply(null, error instanceof Error ? error.message : String(error)); }
    finally { outputBusy.current = false; }
  };
  useEffect(() => {
    return () => {
      outputClose.current?.(); setOutput(null); outputPlans.current.clear();
      const jobs = [...browserJobs.current]; browserJobs.current.clear();
      if (jobs.length) void import("@tauri-apps/api/core").then(({ invoke }) => Promise.all(jobs.map(id => invoke("office_browser", { command: { kind: "close", id } }).catch(() => {}))));
    };
  }, [artifact.id, generation, sessionId]);
  useEffect(() => () => { copied.current.clear(); }, [artifact.id, generation]);

  const handleAi = async (message: Extract<OfficePageMessage, { type: "office:ai-request" }>) => {
    const target = frame.current?.contentWindow, origin = opened.current?.origin;
    if (!target || !origin) return;
    const reply = (value?: unknown, error?: string) => target.postMessage({ type: "office:ai-result", requestId: message.requestId, value, error }, origin);
    if (message.action === "settings") { handlers.current.onAiSettings(); reply(); return; }
    if (message.action === "skills") {
      if (message.sessionId !== opened.current?.sessionId) { reply(undefined, "선택한 세션이 바뀌었습니다."); return; }
      setSkillsOpen(true); reply(); return;
    }
    if (aiBusy.current) { reply(undefined, "문서 저장과 세션 연결을 확인 중입니다."); return; }
    aiBusy.current = true;
    try {
      const checkSession = () => {
        if (target !== frame.current?.contentWindow || message.sessionId !== opened.current?.sessionId) throw new Error("선택한 세션이 바뀌었습니다. 새 대화에서 다시 요청해 주세요.");
      };
      checkSession();
      if (status.current.conflict) throw new Error(status.current.conflict.message);
      const flushed = waitFlushed(); send({ type: "office:flush" });
      const revision = await flushed;
      if (revision === null) throw new Error("문서를 저장하지 못했습니다. 편집 내용은 문서에 유지됩니다.");
      checkSession();
      const paths = message.freezeReferences;
      const revisions: (number | null)[] = [];
      if (paths?.length) {
        const selected = await referenceCall<{ path: string; artifactId: string | null }[]>("describe", { paths });
        for (const item of selected) { checkSession(); revisions.push(item.artifactId ? await saveReferencedDocument(item.artifactId) ?? null : null); }
        checkSession();
      }
      // Opening a document never creates a conversation. Its first admitted AI
      // request does, after saving, through the same Workbench session route.
      const createdSession = message.action === "new-session" || message.sessionId === null;
      let expectedSession = message.sessionId;
      if (createdSession) expectedSession = await handlers.current.onNewSession(revision);
      else await handlers.current.onPrepareAi(revision);
      const value = await api.editorGrant(latest.current.id);
      if (!value.sessionId || value.sessionId !== expectedSession) throw new Error("문서와 선택한 세션의 연결을 확인하지 못했습니다. 다시 요청해 주세요.");
      opened.current = value;
      setGrant({ generation, value });
      let snapshot: OfficeReferenceSnapshot | null = null;
      if (paths !== undefined) {
        if (paths.length) snapshot = await referenceCall<OfficeReferenceSnapshot>("freeze", { paths, revisions });
        if (target !== frame.current?.contentWindow || opened.current?.sessionId !== value.sessionId) throw new Error("참조 문서를 확인하는 동안 문서 창이나 세션이 바뀌었습니다.");
        referenceSnapshot.current = snapshot?.id ?? null;
        referenceSession.current = value.sessionId;
      }
      reply({ revision, token: value.token, sessionId: value.sessionId, ...(createdSession ? { createdSession: true } : {}), ...(snapshot ? { referenceSnapshot: snapshot.id } : {}) });
    } catch (error) { reply(undefined, error instanceof Error ? error.message : String(error)); }
    finally { aiBusy.current = false; }
  };

  const handleSkills = async (message: OfficeSkillRequest) => {
    const target = frame.current?.contentWindow, opening = opened.current;
    if (!target || !opening) return;
    const reply = (value?: unknown, error?: string) => target.postMessage({ type: "office:skills-result", requestId: message.requestId, value, error }, opening.origin);
    try {
      const result = await api.officeSkills<{ ok: boolean; tabId?: string }>(latest.current.id, opening.token, message.action, message.input);
      if (target !== frame.current?.contentWindow || opening.sessionId !== opened.current?.sessionId) throw new Error("양식을 준비하는 동안 문서 창이나 세션이 바뀌었습니다. 준비된 사본은 문서 목록에 보존했습니다.");
      reply(result);
      if (result.ok && result.tabId) handlers.current.onCopied?.(result.tabId);
    } catch (error) { reply(undefined, error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => {
    let cancelled = false;
    api
      .editorGrant(artifact.id)
      .then((value) => !cancelled && setGrant({ generation, value }))
      .catch((error: Error) => !cancelled && setGrant({ generation, error: error.message }));
    return () => {
      cancelled = true;
    };
    // A new grant for each opening of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.id, generation, access?.writeToken, sessionId]);
  const current = grant && grant.generation === generation ? grant : null;
  opened.current = current && "value" in current ? current.value : null;
  useEffect(() => { if (opened.current) send({ type: "office:grant", token: opened.current.token, sessionId: opened.current.sessionId }); }, [current]);
  const aiHandler = useRef(handleAi); aiHandler.current = handleAi;
  const referenceHandler = useRef(handleReference); referenceHandler.current = handleReference;
  const skillsHandler = useRef(handleSkills); skillsHandler.current = handleSkills;
  const outputHandler = useRef(handleOutput); outputHandler.current = handleOutput;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!opened.current || event.origin !== opened.current.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as OfficePageMessage;
      switch (message.type) {
        case "office:skills": void skillsHandler.current(message); break;
        case "office:references": void referenceHandler.current(message); break;
        case "office:ai-request": void aiHandler.current(message); break;
        case "office:output": void outputHandler.current(message); break;
        case "office:copied":
          if (copied.current.has(message.artifactId)) {
            const expectedSession = copied.current.get(message.artifactId); copied.current.delete(message.artifactId);
            if (expectedSession !== (opened.current.sessionId ?? null)) {
              if (message.keepSource && latest.current.format === "pdf") {
                send({ type: "office:copy-rejected", artifactId: message.artifactId });
                break;
              }
              // The receipt belongs to the previous conversation. Reopen this source's
              // retained draft instead of leaving its renderer bound to the copy's path.
              recover.current = true; update({ dirty: true, revision: null, conflict: null });
              setGeneration((value) => value + 1);
              handlers.current.onNotice("사본을 저장한 뒤 대화가 바뀌었습니다. 현재 탭의 편집 내용을 복원합니다. 사본은 문서 목록에 있습니다.");
              break;
            }
            if (message.keepSource && latest.current.format === "pdf") {
              // The original PDF Save As keeps its pending annotations/redaction
              // selections in this tab. The copy is available in the document list.
              send({ type: "office:copy-accepted", artifactId: message.artifactId });
              handlers.current.onNotice("PDF 사본을 문서 목록에 저장했습니다. 원본 탭의 편집 내용은 유지합니다.");
              break;
            }
            // The unsaved bytes now belong to the copy. Restore this old tab from its actual
            // original file, then open the copy in the same session.
            recover.current = false;
            update({ dirty: false, revision: null, conflict: null });
            setGeneration((value) => value + 1);
            handlers.current.onCopied?.(message.artifactId);
          } else send({ type: "office:copy-rejected", artifactId: message.artifactId });
          break;
        case "office:control-result":
          controlWaiters.current.get(message.requestId)?.(message.reply);
          break;
        case "office:ready": {
          const doc = latest.current;
          send({
            type: "office:init",
            token: opened.current.token,
            sessionId: opened.current.sessionId,
            artifact: { id: doc.id, name: doc.name, path: doc.path, revision: doc.revision, sha256: doc.sha256 },
            readOnly: false,
            theme: theme(),
            recover: recover.current,
          });
          recover.current = true;
          break;
        }
        case "office:opened":
          if (message.recovered && message.revision < latest.current.revision) {
            update({
              revision: message.revision,
              dirty: true,
              conflict: {
                code: "revision_conflict",
                message: `r${message.revision}에서 저장하지 않았던 편집을 되살렸습니다. 그사이 문서는 r${latest.current.revision}이 되었습니다.`,
              },
            });
          } else {
            update({ revision: message.revision, dirty: message.recovered, conflict: null });
            if (message.recovered) handlers.current.onNotice("저장하지 않았던 편집을 되살렸습니다.");
          }
          // The artifact may advance while this frame is opening. Its revision effect
          // already ran with shown=null; reconcile again with the actual opened revision.
          reconcile();
          break;
        case "office:saving":
          savingSince.current = Date.now();
          break;
        case "office:saved":
          savingSince.current = 0;
          own.current.add(message.revision);
          update({ revision: message.revision, dirty: false, conflict: null });
          reconcile();
          break;
        case "office:dirty":
          if (message.dirty !== status.current.dirty) update({ dirty: message.dirty });
          break;
        case "office:flushed":
          for (const resolve of waiters.current.splice(0)) resolve(message.revision);
          break;
        case "office:conflict":
          savingSince.current = 0;
          update({ conflict: { code: message.code, message: message.message } });
          break;
        case "office:error":
          savingSince.current = 0;
          handlers.current.onNotice(`저장하지 못했습니다: ${message.message}`);
          break;
        case "office:clipboard-picture":
          // Only for the editor the user is pasting into; the page cannot read the desktop clipboard itself.
          if (document.activeElement !== frame.current) return send({ type: "office:clipboard-picture", picture: null });
          void api
            .clipboardPicture()
            .then(async (file) => (file ? { bytes: await file.arrayBuffer(), type: file.type } : null))
            .catch(() => null)
            .then((picture) => {
              if (opened.current) frame.current?.contentWindow?.postMessage({ type: "office:clipboard-picture", picture }, opened.current.origin, picture ? [picture.bytes] : []);
            });
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the app's light/dark switch.
  useEffect(() => {
    const scope = frame.current?.closest("[data-theme]");
    if (!scope) return;
    const observer = new MutationObserver(() => send({ type: "office:theme", theme: theme() }));
    observer.observe(scope, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A revision made elsewhere (an applied AI proposal, a revert): open it when nothing here is unsaved.
  useEffect(() => {
    reconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.revision]);

  useEffect(() => () => {
    for (const resolve of [...controlWaiters.current.values()]) resolve({ status: "not_ready" });
  }, [artifact.id, generation]);

  useImperativeHandle(ref, () => ({
    control(request) {
      if (status.current.revision === null) return Promise.resolve({ status: "not_ready" });
      return new Promise(resolve => {
        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => finish({ status: "not_ready" }), 1500);
        const finish = (reply: RendererControlReply) => { window.clearTimeout(timer); controlWaiters.current.delete(requestId); resolve(reply); };
        controlWaiters.current.set(requestId, finish);
        send({ type: "office:control", requestId, request });
      });
    },
    exportPdf() {
      if (status.current.revision === null || outputBusy.current || outputPlans.current.size) {
        handlers.current.onNotice("문서를 여는 중이거나 다른 출력을 처리 중입니다."); return;
      }
      send({ type: "office:export-pdf" });
    },
    exportDocx() {
      if (status.current.revision === null || outputBusy.current || outputPlans.current.size) {
        handlers.current.onNotice("문서를 여는 중이거나 다른 출력을 처리 중입니다."); return;
      }
      send({ type: "office:export-docx" });
    },
    flush() {
      if (outputBusy.current || outputPlans.current.size || copied.current.size) return Promise.resolve(null);
      if (status.current.conflict) return Promise.resolve(null);
      // Not opened yet: nothing can have been edited.
      if (status.current.revision === null) return Promise.resolve(latest.current.revision);
      const flushed = waitFlushed();
      send({ type: "office:flush" });
      return flushed;
    },
    rebase(revision) {
      if (outputBusy.current || outputPlans.current.size || copied.current.size) return Promise.resolve(null);
      const flushed = waitFlushed();
      send({ type: "office:rebase", revision });
      return flushed;
    },
    async leave() {
      if (outputBusy.current || outputPlans.current.size || copied.current.size) throw new Error("사본 저장을 마치거나 취소한 뒤 이동해 주세요.");
      if (status.current.revision === null) return;
      if (status.current.conflict) throw new Error("문서의 저장 충돌을 해결한 뒤 이동해 주세요. 편집 내용은 현재 탭에 있습니다.");
      const done = waitFlushed();
      send({ type: "office:flush" });
      if (await done === null || status.current.dirty) throw new Error("문서 저장을 확인하지 못해 이동하지 않았습니다. 현재 탭에서 저장을 다시 시도해 주세요.");
    },
    reload() {
      recover.current = false;
      status.current = { dirty: false, revision: null, conflict: null };
      handlers.current.onStatus(status.current);
      setGeneration((value) => value + 1);
    },
  }));

  if (current && "error" in current) {
    return (
      <div className="column empty-hint office-frame-error">
        편집기를 열지 못했습니다: {current.error}{" "}
        <button type="button" className="link" onClick={() => setGeneration((value) => value + 1)}>
          다시 열기
        </button>
      </div>
    );
  }
  if (!opened.current) return hidden ? null : <div className="column empty-hint">편집기를 여는 중…</div>;
  return (<>
    {skillsOpen ? <SkillLibraryDialog api={api} scope={{ workId: artifact.workId, ...(artifact.workspaceId ? { workspaceId: artifact.workspaceId } : {}), ...(sessionId ? { sessionId } : {}) }} onClose={() => { setSkillsOpen(false); send({ type: "office:skills-changed" }); }} /> : null}
    {referencePicker ? <OfficeReferencePicker {...referencePicker} /> : null}
    {output ? <OfficeOutputDialog api={api} artifact={artifact} revision={output.revision} format={output.format} onChoose={output.choose} onCancel={() => output.choose(null)} /> : null}
    <iframe
      key={`${artifact.id}:${generation}`}
      ref={frame}
      className="design-frame office-frame"
      // Kept loaded (with its unsaved edits) while a comparison or an older revision is shown over it.
      style={hidden ? { display: "none" } : undefined}
      allow="fullscreen; clipboard-read; clipboard-write"
      src={`${opened.current.url}?a=${artifact.id}&g=${generation}&host=${encodeURIComponent(location.origin)}`}
      title={`${artifact.format === "pptx" ? "PPT" : artifact.format === "xlsx" ? "엑셀" : artifact.format === "hwp" || artifact.format === "hwpx" ? "한글" : artifact.format === "epub" ? "전자책" : artifact.format === "xmind" ? "마인드맵" : artifact.format === "pdf" ? "PDF" : artifact.format === "markdown" ? "Markdown" : artifact.format === "html" ? "HTML" : "워드"} 편집기 · ${artifact.name}`}
    />
  </>);
});
