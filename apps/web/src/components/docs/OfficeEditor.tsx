import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { takeDiscarded } from "../../discarded-edits.ts";
import { failure, type Notify } from "../../top-notice.ts";
import type { Artifact, DocumentAccess, EditorGrant, OfficePageMessage } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import type { RendererControlRequest, RendererControlReply } from "../../../../../packages/contracts/src/office-control.ts";
import type { OfficeMcpRequest, OfficeMcpReply } from "../../../../../packages/contracts/src/office-mcp.ts";
import type { BrowserResult, OfficeOutputFormat, OfficeOutputPlan, OfficeOutputRequest, OfficePresentation } from "../../../../../packages/contracts/src/office-output.ts";
import { OfficeOutputDialog } from "./OfficeOutputDialog.tsx";
import { OfficeImageOutputDialog } from "./OfficeImageOutputDialog.tsx";
import type { OfficeMarkdownRequest, OfficeMarkdownSnapshot } from "../../../../../packages/contracts/src/office-markdown.ts";
import { OfficeReferencePicker } from "./OfficeReferencePicker.tsx";
import type { OfficeDocumentChoice, OfficeReferenceRequest, OfficeReferenceSnapshot } from "../../../../../packages/contracts/src/office-references.ts";
import { pickOfficeDrive } from "../OfficeDrive.tsx";
import { saveReferencedDocument } from "../../document-commands.ts";
import { pickOfficeFiles } from "./office-file-picker.ts";
import { SkillLibraryDialog } from "../SkillLibraryDialog.tsx";
import type { OfficeSkillRequest } from "../../../../../packages/contracts/src/office-skills.ts";
import type { OfficeWikiRequest } from "../../../../../packages/contracts/src/office-wiki.ts";
import type { KnowledgeOpenRequest } from "../../../../../packages/contracts/src/office-knowledge.ts";
import type { PdfNoteRequest, PdfNoteResult } from "../../../../../packages/contracts/src/pdf-notes.ts";
import { PdfNoteDialog } from "./PdfNoteDialog.tsx";

const BUSY = failure("문서를 여는 중이거나 다른 출력을 처리 중입니다.");

export type OfficeHandle = {
  /** Find and execute the mounted renderer's original menu/ribbon commands. */
  showCommands(): void;
  /** Open or close the editor's own AI dock (the Hangul editor's, which is the document's 문서 AI). */
  setAiPanel(open: boolean, draft?: string): void;
  /** The document's one unsent AI draft, put in the editor's own AI input in place of what it holds. */
  setAiDraft(draft: string): void;
  mcp(request: OfficeMcpRequest): Promise<OfficeMcpReply>;
  control(request: RendererControlRequest): Promise<RendererControlReply>;
  /** Run the original renderer's PDF action on current, possibly unsaved content. */
  exportPdf(): void;
  exportDocx(open?: boolean): void;
  exportOdt(): void;
  exportHtml(): void;
  exportImages(): void;
  /** Save unsaved edits now; resolves with the saved revision, or null when they could not be saved. */
  flush(): Promise<number | null>;
  /** After a conflict: save my edits as the revision after `revision`; null when there was nothing to keep or it failed. */
  rebase(revision: number): Promise<number | null>;
  /** Open the latest revision; unsaved edits in the editor are dropped. */
  reload(): void;
  /** Before the view goes away: confirm saving (the saved revision; null: never opened). A failure/conflict keeps this editor mounted. */
  leave(): Promise<number | null>;
};

export type OfficeConflict = { code: string; message: string };
/** `revision`: what the editor's content is based on (null until it has opened). */
/**
 * `dirty` is the editor's own report: closing, removing and navigating rely on it, exactly.
 * The label reads the other two. `changed`: show "저장 안 됨" — the editor says dirty and its text
 * is not known to equal the saved revision. `same`: the editor says dirty but its text was read and
 * found equal (the Markdown editor reports dirty as it opens, see below): no unsaved mark, and no
 * "저장됨" either — that word waits for the editor's own clean report.
 */
export type OfficeStatus = { dirty: boolean; revision: number | null; conflict: OfficeConflict | null; changed: boolean; same: boolean };
/**
 * A Hangul save that went on without its save check (the gateway answered `text`/`structure`
 * "unchecked": an engine call it could not count with) is said to the person once per document per
 * session, through the same notice as the Save As warning (T3, m3-1).
 */
export const HWP_UNCHECKED_NOTICE = "저장했습니다. 이 문서는 저장 검사를 하지 못했습니다.";
const uncheckedNoticed = new Set<string>();
/** A burst of hints that the text may have changed is one question to the editor. */
const COMPARE_DELAY_MS = 400;

/**
 * A Word, PowerPoint or Excel document in the central area, edited with IeumOffice's editor built
 * into Workbench (apps/office: /office/docs.html, slides.html, sheets.html, on the editors' own origin).
 * Saves become revisions; a save over a revision made elsewhere is refused and reported, and a
 * revision made elsewhere is opened when nothing here is unsaved.
 */
export const OfficeEditor = forwardRef<
  OfficeHandle,
  { api: Api; artifact: Artifact; access?: DocumentAccess; sessionId: string | null; hidden?: boolean; onStatus(status: OfficeStatus): void; onAiPanel?(open: boolean, draft?: string, dock?: { ready: boolean; person: boolean; shown?: boolean }): void;
    /** The editor's page is opened again in place (a new frame: its own AI dock, if any, is drawn afresh). */
    onReload?(): void; onNotice: Notify; onCopied?(artifactId: string, scope?: Pick<Artifact, "workId" | "workspaceId"> & { preserveSource?: boolean }): void; onPresent?(value: OfficePresentation): void; onPrepareAi(revision: number): Promise<void>; onNewSession(revision: number): Promise<string>; onAiSettings(): void }
>(function OfficeEditor({ api, artifact, access, sessionId, hidden = false, onStatus, onAiPanel, onReload, onNotice, onCopied, onPresent, onPrepareAi, onNewSession, onAiSettings }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [generation, setGeneration] = useState(0);
  // Each opening of the page gets its own grant (a token for this document only).
  const [grant, setGrant] = useState<{ generation: number; value: EditorGrant } | { generation: number; error: string } | null>(null);
  const opened = useRef<EditorGrant | null>(null);
  const status = useRef<OfficeStatus>({ dirty: false, revision: null, conflict: null, changed: false, same: false });
  // The Markdown editor says "dirty" the moment it opens: registering its AI executor unlocks the
  // editor (apps/office/execution-patch.ts → setEditable), TipTap emits an update for that, and the
  // renderer counts every update as an edit. It then stays dirty, so a real edit sends nothing new.
  // For the label its text is compared with the saved revision; other editors' reports are taken
  // as they are.
  const verifies = artifact.format === "markdown";
  /** The last comparison of this dirty spell: "none" (not made, or the read failed: the report stands), equal, or different. */
  const compared = useRef<"none" | "equal" | "different">("none");
  const savedText = useRef<{ revision: number; text: string } | null>(null);
  const comparing = useRef(false), compareAgain = useRef(false), compareTimer = useRef<number | undefined>(undefined);
  const own = useRef(new Set<number>());
  // When the page last said a save of its own is on its way (0: none).
  const savingSince = useRef(0);
  const waiters = useRef<((revision: number | null) => void)[]>([]);
  // False only for the reload right after "open the latest revision": kept edits are dropped then.
  const recover = useRef(true);
  const handlers = useRef({ onStatus, onAiPanel, onReload, onNotice, onCopied, onPresent, onPrepareAi, onNewSession, onAiSettings });
  const noticeUnchecked = () => {
    if (uncheckedNoticed.has(artifact.id)) return;
    uncheckedNoticed.add(artifact.id); handlers.current.onNotice(HWP_UNCHECKED_NOTICE);
  };
  handlers.current = { onStatus, onAiPanel, onReload, onNotice, onCopied, onPresent, onPrepareAi, onNewSession, onAiSettings };
  // The page opened again in place: whoever follows its AI dock must not take the new one for the old.
  const firstGeneration = useRef(generation);
  useEffect(() => { if (generation !== firstGeneration.current) handlers.current.onReload?.(); }, [generation]);
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
  const exported = useRef(new Map<string, Artifact>());
  const imageJobs = useRef(new Map<string, { owner: string; api: Api }>());
  const pdfImageJobs = useRef(new Map<string, { owner: string; api: Api }>());
  const exportedImages = useRef(new Set<string>());
  const blockingOutputs = () => imageJobs.current.size > 0 || pdfImageJobs.current.size > 0 || [...outputPlans.current.values()].some(plan => !plan.longJob);
  const browserJobs = useRef(new Set<string>());
  const controlWaiters = useRef(new Map<string, (reply: RendererControlReply) => void>());
  const mcpWaiters = useRef(new Map<string, (reply: OfficeMcpReply) => void>());
  const copied = useRef(new Map<string, string | null>());
  const [output, setOutput] = useState<{ revision: number; format: OfficeOutputFormat; defaultName?: string; longJob?: boolean; choose(plan: OfficeOutputPlan | null): void } | null>(null);
  const [imageOutput, setImageOutput] = useState<{ embedded?: boolean; choose(path: string | null): void } | null>(null);
  const [notePath, setNotePath] = useState<{ initialPath: string; choose(path: string | null): void } | null>(null);
  const noteClose = useRef<(() => void) | null>(null), noteBusy = useRef(false);
  const latest = useRef(artifact);
  latest.current = artifact;

  const theme = () => (frame.current?.closest("[data-theme]")?.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const update = (patch: Partial<Omit<OfficeStatus, "changed" | "same">>) => {
    const next = { ...status.current, ...patch };
    if (!next.dirty) compared.current = "none";
    else if (next.conflict) compared.current = "different";
    const same = next.dirty && verifies && compared.current === "equal";
    status.current = { ...next, changed: next.dirty && !same, same };
    if (frame.current) frame.current.dataset.revision = String(status.current.revision ?? "");
    handlers.current.onStatus(status.current);
  };
  // The editor's text against the saved revision's, asked after a hint that it may have changed
  // (never on a clock). Equal takes the unsaved mark back; anything else — different, busy, not
  // ready, no answer, a saved text that cannot be read — leaves or puts back the editor's report.
  const settle = (result: "none" | "equal" | "different") => {
    if (compared.current === result) return;
    compared.current = result;
    update({});
  };
  const compareNow = useRef(async () => {});
  compareNow.current = async () => {
    const now = status.current, revision = now.revision;
    if (!verifies || !now.dirty || compared.current === "different" || revision === null || !opened.current) return;
    if (comparing.current) { compareAgain.current = true; return; }
    comparing.current = true;
    const owner = latest.current.id, target = frame.current?.contentWindow;
    const current = () => target === frame.current?.contentWindow && latest.current.id === owner && status.current.revision === revision && status.current.dirty;
    try {
      if (savedText.current?.revision !== revision) {
        try { savedText.current = { revision, text: (await api.artifactText(owner, revision)).text }; }
        catch { if (current()) settle("none"); return; }
      }
      const reply = await new Promise<OfficeMcpReply>((resolve) => {
        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => finish({ status: "not_ready" }), 1500);
        const finish = (value: OfficeMcpReply) => { window.clearTimeout(timer); mcpWaiters.current.delete(requestId); resolve(value); };
        mcpWaiters.current.set(requestId, finish);
        send({ type: "office:mcp", requestId, request: { kind: "read" } });
      });
      if (!current()) return;
      settle(reply.status !== "ok" ? "none" : reply.result.value === savedText.current.text ? "equal" : "different");
    } finally {
      comparing.current = false;
      if (compareAgain.current) { compareAgain.current = false; hint.current(); }
    }
  };
  /** Something that may have changed the editor's text, or shows the person leaving it: compare once things rest. */
  const hint = useRef((_delay?: number) => {});
  hint.current = (delay = COMPARE_DELAY_MS) => {
    if (!verifies || !status.current.dirty || compared.current === "different") return;
    window.clearTimeout(compareTimer.current);
    compareTimer.current = window.setTimeout(() => void compareNow.current(), delay);
  };
  // The editor says nothing when a later edit is typed. The moments the app can see: the focus
  // coming back from the frame, the page shown again (and the pointer leaving the frame, below).
  useEffect(() => {
    if (!verifies) return;
    const onHint = () => hint.current();
    const onVisible = () => { if (document.visibilityState === "visible") hint.current(); };
    window.addEventListener("focus", onHint);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("focus", onHint); document.removeEventListener("visibilitychange", onVisible); window.clearTimeout(compareTimer.current); };
  }, [verifies, artifact.id]);
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
      else if (message.action === "pick-drive") {
        if (referencePickerClose.current) value = { ok: false, reason: "busy" };
        else {
          const controller = new AbortController(); referencePickerClose.current = () => controller.abort();
          try {
            value = await pickOfficeDrive(controller.signal, { artifactId: owner, editorToken: opened.current!.token }); checkSelection();
          } finally { referencePickerClose.current = null; }
        }
      }
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

  const handleMarkdown = async (message: OfficeMarkdownRequest) => {
    const target = frame.current?.contentWindow, opening = opened.current, owner = latest.current.id;
    if (!target || !opening) return;
    try {
      if (latest.current.format !== "markdown" || !["read", "host", "theme"].includes(message.action)) throw new Error("Markdown 문서의 설정만 변경할 수 있습니다.");
      const value = await api.request<OfficeMarkdownSnapshot>("POST", "/api/office-markdown", { action: message.action, value: message.value, revision: message.revision });
      if (target !== frame.current?.contentWindow || owner !== latest.current.id) return;
      target.postMessage({ type: "office:markdown-result", requestId: message.requestId, value }, opening.origin);
    } catch (error) { target.postMessage({ type: "office:markdown-result", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }, opening.origin); }
  };

  const handleOutput = async (message: OfficeOutputRequest) => {
    const target = frame.current?.contentWindow, origin = opened.current?.origin;
    if (!target || !origin) return;
    const owner = latest.current.id, ownerSession = opened.current?.sessionId;
    const check = () => {
      if (target !== frame.current?.contentWindow || owner !== latest.current.id || ownerSession !== opened.current?.sessionId) throw new Error("저장 중 문서 창이나 연결된 대화가 바뀌었습니다. 저장한 사본은 문서 목록에서 확인해 주세요.");
    };
    const reply = (value: unknown, error?: string) => target.postMessage({ type: "office:output-result", requestId: message.requestId, value, error }, origin);
    if (message.action === "present") {
      try {
        check();
        if (latest.current.format !== "html" || !handlers.current.onPresent || typeof message.title !== "string" || !/^\/preview\/[A-Za-z0-9_-]{32}\/document\.html$/.test(message.url)) throw new Error("발표할 HTML 문서를 다시 확인해 주세요.");
        const url = new URL("/office/html.html", origin);
        url.search = new URLSearchParams({ present: "1", preview: message.url, title: message.title.slice(0, 160), theme: document.documentElement.dataset.theme ?? "system" }).toString();
        handlers.current.onPresent({ url: url.href, title: message.title.slice(0, 160) }); reply(null);
      } catch (error) { reply(null, error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (message.action === "open-export" || message.action === "reveal-export") {
      try {
        check(); const result = exported.current.get(message.path);
        if (message.action === "reveal-export" ? !result && !exportedImages.current.has(message.path) : !result || !handlers.current.onCopied) throw new Error("이 문서에서 내보낸 결과 파일을 선택해 주세요.");
        if (message.action === "reveal-export") {
          const { revealItemInDir } = await import("@tauri-apps/plugin-opener"); await revealItemInDir(message.path);
        } else if (result) handlers.current.onCopied!(result.id, { ...result, preserveSource: true });
        reply(null);
      } catch (error) { reply(null, error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (message.action === "cancel") {
      if (message.preparationId && outputRequest.current === message.preparationId) outputClose.current?.();
      if (message.planId) outputPlans.current.delete(message.planId);
      if (message.preparationId) for (const [id, plan] of outputPlans.current) if (plan.preparationId === message.preparationId) outputPlans.current.delete(id);
      reply(null); return;
    }
    if (outputBusy.current || imageJobs.current.size && message.action !== "images-write" && message.action !== "images-finish" || pdfImageJobs.current.size && message.action !== "pdf-images-write" && message.action !== "pdf-images-finish") { reply(null, "다른 저장·출력 요청을 처리 중입니다."); return; }
    outputBusy.current = true;
    try {
      if (message.action === "pdf-images-prepare") {
        if (latest.current.format !== "pdf") throw new Error("PDF 문서를 먼저 열어 주세요.");
        const path = await new Promise<string | null>((resolve) => {
          const choose = (value: string | null) => { outputClose.current = null; outputRequest.current = null; setImageOutput(null); resolve(value); };
          outputRequest.current = message.requestId; outputClose.current = () => choose(null); setImageOutput({ choose, embedded: message.embedded });
        });
        if (!path) { reply(null); return; }
        check(); const bound = access ? { ...access } : null, outputApi = bound ? api.forDocument(() => bound) : api;
        const plan = await outputApi.preparePdfImages(owner, message.revision, path, message.name);
        try { check(); pdfImageJobs.current.set(plan.id, { owner, api: outputApi }); reply(plan); }
        catch (error) { await outputApi.finishPdfImages(owner, plan.id, false).catch(() => {}); throw error; }
        return;
      }
      if (message.action === "pdf-images-write" || message.action === "pdf-images-finish") {
        const job = pdfImageJobs.current.get(message.id);
        if (!job || job.owner !== owner) throw new Error("이 문서에서 시작한 그림 출력을 선택해 주세요.");
        check();
        if (message.action === "pdf-images-write") { const result = await job.api.writePdfImages(owner, message.id, message); check(); reply(result); return; }
        try {
          const result = await job.api.finishPdfImages(owner, message.id, message.success);
          for (const path of result.files ?? []) exportedImages.current.add(path);
          if (result.path) handlers.current.onNotice(`그림을 내보냈습니다: ${result.path}`);
          reply(result);
        } finally { pdfImageJobs.current.delete(message.id); }
        return;
      }
      if (message.action === "images-prepare") {
        if (latest.current.format !== "markdown" || !("__TAURI_INTERNALS__" in window)) throw new Error("Markdown 그림 출력은 데스크톱 앱에서 실행해 주세요.");
        const path = await new Promise<string | null>((resolve) => {
          const choose = (value: string | null) => { outputClose.current = null; outputRequest.current = null; setImageOutput(null); resolve(value); };
          outputRequest.current = message.requestId; outputClose.current = () => choose(null); setImageOutput({ choose });
        });
        if (!path) { reply(null); return; }
        check(); const bound = access ? { ...access } : null, outputApi = bound ? api.forDocument(() => bound) : api;
        const plan = await outputApi.prepareOfficeImages(owner, message.revision, path, message.name);
        imageJobs.current.set(plan.id, { owner, api: outputApi });
        try {
          check(); const { invoke } = await import("@tauri-apps/api/core");
          const bytes = await invoke<ArrayBuffer>("render_html_pdf", { job: message.job }); check();
          const pdfBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = () => reject(reader.error); reader.readAsDataURL(new Blob([bytes], { type: "application/pdf" }));
          });
          check(); reply({ id: plan.id, pdfBase64 });
        } catch (error) { await outputApi.finishOfficeImages(owner, plan.id, false).catch(() => {}); imageJobs.current.delete(plan.id); throw error; }
        return;
      }
      if (message.action === "images-write" || message.action === "images-finish") {
        check(); const job = imageJobs.current.get(message.id);
        if (!job || job.owner !== owner) throw new Error("이 문서에서 시작한 그림 출력을 선택해 주세요.");
        if (message.action === "images-write") { const result = await job.api.writeOfficeImage(owner, message.id, message.page, message.base64); check(); reply(result); return; }
        try {
          const result = await job.api.finishOfficeImages(owner, message.id, message.success);
          if (result.path) {
            handlers.current.onNotice(`그림을 내보냈습니다: ${result.path}`);
            const path = `${result.path}/page-01.png`;
            void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) => revealItemInDir(path)).catch(() => {});
          }
          reply(result);
        } finally { imageJobs.current.delete(message.id); }
        return;
      }
      if (message.action === "commit") {
        const plan = outputPlans.current.get(message.planId);
        if (!plan || !(message.bytes instanceof ArrayBuffer)) throw new Error("저장 위치를 다시 선택하세요.");
        try {
          check();
          const result = await api.commitOfficeOutput(owner, plan.id, message.bytes, plan.replace, plan.longJob || message.generatedId ? message.sourceRevision : undefined, message.generatedId);
          check();
          if (result.artifact) exported.current.set(result.path, result.artifact);
          if (result.artifact && (!message.intent || message.intent === "copy")) copied.current.set(result.artifact.id, ownerSession ?? null);
          reply({ path: result.path, artifactId: result.artifact?.id ?? null });
          if (result.backupPath) handlers.current.onNotice(`이전 파일을 백업했습니다: ${result.backupPath}`);
          // The loss warning is what the person must read: the unchecked line never replaces it
          // (the top bar shows the last notice) and waits for the next unchecked save.
          if (result.warning) handlers.current.onNotice(result.warning);
          else if (result.text === "unchecked" || result.structure === "unchecked") noticeUnchecked();
          if (message.intent === "open" && result.artifact) handlers.current.onCopied?.(result.artifact.id, { ...result.artifact, preserveSource: true });
          // Exporting does not change the source renderer or its unsaved recovery buffer.
          if (message.intent === "export") handlers.current.onNotice(`파일을 내보냈습니다: ${result.path}`);
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
        setOutput({ revision: message.revision, format: message.action === "prepare" ? message.format : "pdf", ...(message.action === "prepare" ? { defaultName: message.defaultName, longJob: message.longJob === true && (latest.current.format === "epub" && message.format === "epub" || latest.current.format === "pdf" && ["md", "epub", "pdf", "docx", "pptx", "xlsx"].includes(message.format)) } : {}), choose });
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
      reply({ path: result.path, artifactId: result.artifact?.id ?? null });
    } catch (error) { reply(null, error instanceof Error ? error.message : String(error)); }
    finally { outputBusy.current = false; }
  };
  useEffect(() => {
    return () => {
      outputClose.current?.(); setOutput(null); setImageOutput(null); outputPlans.current.clear(); exported.current.clear();
      for (const [id, job] of imageJobs.current) void job.api.finishOfficeImages(job.owner, id, false).catch(() => {});
      imageJobs.current.clear();
      for (const [id, job] of pdfImageJobs.current) void job.api.finishPdfImages(job.owner, id, false).catch(() => {});
      pdfImageJobs.current.clear(); exportedImages.current.clear();
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
      const result = await api.officeSkills<{ ok: boolean; tabId?: string; artifact?: Artifact }>(latest.current.id, opening.token, message.action, message.input);
      if (target !== frame.current?.contentWindow || opening.sessionId !== opened.current?.sessionId) throw new Error("양식을 준비하는 동안 문서 창이나 세션이 바뀌었습니다. 준비된 사본은 문서 목록에 보존했습니다.");
      reply(result);
      if (result.ok && result.tabId) handlers.current.onCopied?.(result.tabId, result.artifact);
    } catch (error) { reply(undefined, error instanceof Error ? error.message : String(error)); }
  };

  const handleWiki = async (message: OfficeWikiRequest) => {
    const target = frame.current?.contentWindow, opening = opened.current, owner = latest.current.id;
    if (!target || !opening) return;
    const reply = (value?: unknown, error?: string) => target.postMessage({ type: "office:wiki-result", requestId: message.requestId, value, error }, opening.origin);
    const check = () => { if (target !== frame.current?.contentWindow || latest.current.id !== owner || opened.current?.sessionId !== opening.sessionId) throw new Error("위키를 읽는 동안 문서 창이나 대화가 바뀌었습니다."); };
    try {
      if (message.action === "open") {
        if (!handlers.current.onCopied) throw new Error("연결된 문서를 열 수 있는 화면이 아닙니다.");
        const pending = waitFlushed(); send({ type: "office:flush" });
        if (await pending === null) throw new Error("현재 문서를 저장하지 못했습니다. 편집 내용을 보존한 뒤 링크를 다시 열어 주세요.");
      }
      check();
      const value = await api.officeWiki<{ artifactId?: string }>(owner, opening.token, message.action, message.input);
      check(); reply(value);
      if (message.action === "open" && value.artifactId) {
        handlers.current.onCopied?.(value.artifactId);
        window.dispatchEvent(new CustomEvent("workbench:wiki-open", { detail: { artifactId: value.artifactId, sessionId: opening.sessionId } }));
      }
    } catch (error) { reply(undefined, error instanceof Error ? error.message : String(error)); }
  };
  const wikiHandler = useRef(handleWiki);
  wikiHandler.current = handleWiki;

  const handleKnowledge = async (message: KnowledgeOpenRequest) => {
    const target = frame.current?.contentWindow, opening = opened.current, owner = latest.current.id;
    if (!target || !opening) return;
    const reply = (error?: string) => target.postMessage({ type: "office:knowledge-result", requestId: message.requestId, error }, opening.origin);
    const check = () => { if (target !== frame.current?.contentWindow || latest.current.id !== owner || opened.current?.sessionId !== opening.sessionId) throw new Error("인용 문서를 여는 동안 문서 창이나 대화가 바뀌었습니다."); };
    try {
      if (!handlers.current.onCopied) throw new Error("이 화면에서 인용 문서를 열 수 없습니다.");
      const pending = waitFlushed(); send({ type: "office:flush" });
      if (await pending === null) throw new Error("현재 편집을 저장한 뒤 인용 문서를 열어 주세요.");
      check(); const result = await api.openKnowledge(owner, opening.token, message.path); check();
      reply(); handlers.current.onCopied(result.artifactId, result);
    } catch (error) { reply(error instanceof Error ? error.message : String(error)); }
  };
  const knowledgeHandler = useRef(handleKnowledge); knowledgeHandler.current = handleKnowledge;

  const handleNote = async (message: PdfNoteRequest) => {
    const target = frame.current?.contentWindow, opening = opened.current, owner = latest.current.id;
    if (!target || !opening) return;
    const reply = (value?: unknown, error?: string) => target.postMessage({ type: "office:pdf-note-result", requestId: message.requestId, value, error }, opening.origin);
    const check = () => { if (target !== frame.current?.contentWindow || latest.current.id !== owner || opened.current?.sessionId !== opening.sessionId) throw new Error("노트를 여는 동안 문서 창이나 대화가 바뀌었습니다."); };
    const input: Record<string, unknown> = { requestId: message.requestId, request: message.request };
    const call = <T,>() => api.request<T>("POST", `/api/artifacts/${owner}/pdf-note`, { token: opening.token, action: message.action, input });
    if (message.action === "take") {
      try { check(); reply(await call<string[]>()); } catch (error) { reply(undefined, error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (noteBusy.current) { reply({ ok: false, reason: "busy" }); return; }
    noteBusy.current = true;
    try {
      if (latest.current.format !== "pdf" || !handlers.current.onCopied) throw new Error("PDF 탭에서 노트를 열어 주세요.");
      check(); let value = await call<PdfNoteResult>(); check();
      if (value.choosePath) {
        const selected = await new Promise<string | null>(resolve => {
          const choose = (path: string | null) => { noteClose.current = null; setNotePath(null); resolve(path); };
          noteClose.current = () => choose(null); setNotePath({ initialPath: value.choosePath!, choose });
        });
        check(); if (selected === null) { reply({ ok: false, reason: "cancelled" }); return; }
        input.selectedPath = selected; value = await call<PdfNoteResult>(); check();
      }
      reply({ ok: value.ok, reason: value.reason, message: value.message });
      if (value.ok && value.artifact) handlers.current.onCopied(value.artifact.id, { ...value.artifact, preserveSource: true });
    } catch (error) { reply(undefined, error instanceof Error ? error.message : String(error)); }
    finally { noteBusy.current = false; }
  };
  const noteHandler = useRef(handleNote); noteHandler.current = handleNote;
  useEffect(() => {
    const ready = (event: Event) => { if ((event as CustomEvent<string>).detail === latest.current.id) send({ type: "office:note-ready" }); };
    window.addEventListener("workbench:note-ready", ready);
    return () => { window.removeEventListener("workbench:note-ready", ready); noteClose.current?.(); };
  }, []);
  useEffect(() => () => noteClose.current?.(), [artifact.id, generation, sessionId]);

  useEffect(() => {
    const activate = (event: Event) => {
      const target = (event as CustomEvent<{ artifactId: string; sessionId: string | null }>).detail;
      if (target.artifactId === latest.current.id && target.sessionId === opened.current?.sessionId) send({ type: "office:wiki-activate" });
    };
    window.addEventListener("workbench:wiki-open", activate);
    return () => window.removeEventListener("workbench:wiki-open", activate);
  }, []);

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
  const markdownHandler = useRef(handleMarkdown); markdownHandler.current = handleMarkdown;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!opened.current || event.origin !== opened.current.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as OfficePageMessage;
      // Whatever else the editor does (its AI, an output, a note) may have changed its text.
      if (!["office:mcp-result", "office:control-result", "office:dirty", "office:saved", "office:opened", "office:ready"].includes(message.type)) hint.current();
      switch (message.type) {
        case "office:skills": void skillsHandler.current(message); break;
        case "office:wiki": void wikiHandler.current(message); break;
        case "office:pdf-note": void noteHandler.current(message); break;
        case "office:knowledge-open": void knowledgeHandler.current(message); break;
        case "office:references": void referenceHandler.current(message); break;
        case "office:ai-request": void aiHandler.current(message); break;
        case "office:output": void outputHandler.current(message); break;
        case "office:markdown": void markdownHandler.current(message); break;
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
        case "office:mcp-result":
          mcpWaiters.current.get(message.requestId)?.(message.reply);
          break;
        case "office:ready": {
          const doc = latest.current;
          // Its unsaved edits were dropped by the person (저장하지 않고 옮기기): the editor must not
          // restore its own recovery copy of them; recover: false makes it drop that copy.
          const dropped = takeDiscarded(doc.id);
          send({
            type: "office:init",
            token: opened.current.token,
            sessionId: opened.current.sessionId,
            artifact: { id: doc.id, name: doc.name, path: doc.path, revision: doc.revision, sha256: doc.sha256 },
            readOnly: false,
            theme: theme(),
            recover: recover.current && !dropped,
          });
          recover.current = true;
          break;
        }
        case "office:opened":
          // A theme can change while the renderer is fetching its document and preferences.
          send({ type: "office:theme", theme: theme() });
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
            // Edits recovered on opening are unsaved work: nothing to compare.
            compared.current = message.recovered ? "different" : "none";
            update({ revision: message.revision, dirty: message.recovered, conflict: null });
            if (message.recovered) handlers.current.onNotice("저장하지 않았던 편집을 되살렸습니다.");
          }
          // The artifact may advance while this frame is opening. Its revision effect
          // already ran with shown=null; reconcile again with the actual opened revision.
          reconcile();
          break;
        case "office:ai-panel":
          handlers.current.onAiPanel?.(message.open, message.draft, message.ready === undefined ? undefined : { ready: message.ready, person: Boolean(message.person), shown: message.shown ?? message.open });
          break;
        case "office:saving":
          savingSince.current = Date.now();
          break;
        case "office:saved":
          savingSince.current = 0;
          own.current.add(message.revision);
          if (message.unchecked) noticeUnchecked();
          update({ revision: message.revision, dirty: false, conflict: null });
          reconcile();
          break;
        case "office:dirty":
          // An update shows as unsaved at once; the comparison may take the mark back.
          if (message.dirty && compared.current === "equal") compared.current = "none";
          if (message.dirty !== status.current.dirty) update({ dirty: message.dirty });
          else if (message.dirty) update({});
          if (message.dirty) hint.current(status.current.changed && !savedText.current ? 0 : COMPARE_DELAY_MS);
          break;
        case "office:execution-refresh":
          if (!status.current.dirty) { recover.current = false; update({ revision: null }); setGeneration(value => value + 1); }
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
          handlers.current.onNotice(failure(message.message, "저장하지 못했습니다: "));
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

  // The initial render waits for a grant and has no iframe. Attach after it mounts, and keep
  // the same frame/lease when the pane's theme changes or an overlay temporarily hides it.
  useEffect(() => {
    if (!frame.current || !opened.current) return;
    const notify = () => send({ type: "office:theme", theme: theme() });
    const observer = new MutationObserver(notify);
    for (let scope: HTMLElement | null = frame.current.parentElement; scope; scope = scope.parentElement) observer.observe(scope, { attributes: true, attributeFilter: ["data-theme"] });
    notify();
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.id, generation, Boolean(opened.current)]);

  // A revision made elsewhere (an applied AI proposal, a revert): open it when nothing here is unsaved.
  useEffect(() => {
    reconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.revision]);

  useEffect(() => () => {
    for (const resolve of [...controlWaiters.current.values()]) resolve({ status: "not_ready" });
    for (const resolve of [...mcpWaiters.current.values()]) resolve({ status: "error", error: { reason: "closed", message: "문서 창이 바뀌어 명령의 완료를 확인하지 못했습니다." } });
  }, [artifact.id, generation]);

  useImperativeHandle(ref, () => ({
    showCommands() {
      if (status.current.revision !== null) send({ type: "office:show-commands" });
    },
    setAiPanel(open, draft) {
      send(draft ? { type: "office:ai-panel-set", open, draft } : { type: "office:ai-panel-set", open });
    },
    setAiDraft(draft) {
      send({ type: "office:ai-draft-set", draft });
    },
    mcp(request) {
      if (status.current.revision === null) return Promise.resolve({ status: "not_ready" });
      if (request.kind !== "status" && (aiBusy.current || outputBusy.current || blockingOutputs())) return Promise.resolve({ status: "error", error: { reason: "busy", message: "이 문서에서 실행 중인 AI·저장 작업을 마친 뒤 다시 요청해 주세요." } });
      return new Promise(resolve => {
        const requestId = crypto.randomUUID();
        const plan = request.kind === "save" ? request.plan : undefined;
        if (plan) outputPlans.current.set(plan.id, { ...plan, preparationId: requestId });
        const timer = window.setTimeout(() => finish({ status: "error", error: { reason: "timeout", message: "문서 명령 응답을 확인하지 못했습니다. 현재 내용을 확인해 주세요." } }), request.kind === "status" ? 1500 : 120_000);
        const finish = (reply: OfficeMcpReply) => {
          window.clearTimeout(timer); mcpWaiters.current.delete(requestId); if (plan) outputPlans.current.delete(plan.id);
          if (request.kind === "status" && reply.status === "ok") {
            const pane = frame.current?.closest(".pane");
            reply = { ...reply, result: { value: { ...(reply.result.value as object), active: pane?.getAttribute("data-tab-active") === "true" && pane?.getAttribute("data-pane-active") === "true" } } };
          }
          resolve(reply);
        };
        mcpWaiters.current.set(requestId, finish);
        send({ type: "office:mcp", requestId, request });
      });
    },
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
        handlers.current.onNotice(BUSY); return;
      }
      send({ type: "office:export-pdf" });
    },
    exportDocx(open = false) {
      if (status.current.revision === null || outputBusy.current || outputPlans.current.size) {
        handlers.current.onNotice(BUSY); return;
      }
      send({ type: "office:export-docx", open });
    },
    exportOdt() {
      if (status.current.revision === null || outputBusy.current || outputPlans.current.size) {
        handlers.current.onNotice(BUSY); return;
      }
      send({ type: "office:export-odt" });
    },
    exportHtml() {
      if (status.current.revision === null || outputBusy.current || outputPlans.current.size) {
        handlers.current.onNotice(BUSY); return;
      }
      send({ type: "office:export-html" });
    },
    exportImages() {
      if (status.current.revision === null || outputBusy.current || outputPlans.current.size || imageJobs.current.size) {
        handlers.current.onNotice(BUSY); return;
      }
      send({ type: "office:export-images" });
    },
    flush() {
      if (outputBusy.current || blockingOutputs() || copied.current.size) return Promise.resolve(null);
      if (status.current.conflict) return Promise.resolve(null);
      // Not opened yet: nothing can have been edited.
      if (status.current.revision === null) return Promise.resolve(latest.current.revision);
      const flushed = waitFlushed();
      send({ type: "office:flush" });
      return flushed;
    },
    rebase(revision) {
      if (outputBusy.current || blockingOutputs() || copied.current.size) return Promise.resolve(null);
      const flushed = waitFlushed();
      send({ type: "office:rebase", revision });
      return flushed;
    },
    async leave() {
      if (outputBusy.current || blockingOutputs() || copied.current.size) throw new Error("사본 저장을 마치거나 취소한 뒤 이동해 주세요.");
      if (status.current.revision === null) return null;
      if (status.current.conflict) throw new Error("문서의 저장 충돌을 해결한 뒤 이동해 주세요. 편집 내용은 현재 탭에 있습니다.");
      const done = waitFlushed();
      send({ type: "office:flush" });
      const revision = await done;
      if (revision === null || status.current.dirty) throw new Error("문서 저장을 확인하지 못해 이동하지 않았습니다. 현재 탭에서 저장을 다시 시도해 주세요.");
      return revision;
    },
    reload() {
      recover.current = false;
      compared.current = "none";
      status.current = { dirty: false, revision: null, conflict: null, changed: false, same: false };
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
    {notePath ? <PdfNoteDialog initialPath={notePath.initialPath} onChoose={notePath.choose} /> : null}
    {skillsOpen ? <SkillLibraryDialog api={api} scope={{ workId: artifact.workId, ...(artifact.workspaceId ? { workspaceId: artifact.workspaceId } : {}), ...(sessionId ? { sessionId } : {}) }} onClose={() => { setSkillsOpen(false); send({ type: "office:skills-changed" }); }} /> : null}
    {referencePicker ? <OfficeReferencePicker {...referencePicker} /> : null}
    {output ? <OfficeOutputDialog key={outputRequest.current} api={api} artifact={artifact} revision={output.revision} format={output.format} defaultName={output.defaultName} longJob={output.longJob} onChoose={output.choose} onCancel={() => output.choose(null)} /> : null}
    {imageOutput ? <OfficeImageOutputDialog initialPath={artifact.path.replace(/[^\\/]+$/, "")} embedded={imageOutput.embedded} onChoose={imageOutput.choose} /> : null}
    <iframe
      key={`${artifact.id}:${generation}`}
      ref={frame}
      className="design-frame office-frame"
      // The pointer leaving the editor: the person is done there for now, so its text is compared.
      onPointerLeave={() => hint.current()}
      // Kept loaded (with its unsaved edits) while a comparison or an older revision is shown over it.
      style={hidden ? { display: "none" } : undefined}
      allow="fullscreen; clipboard-read; clipboard-write"
      src={`${opened.current.url}?a=${artifact.id}&g=${generation}&host=${encodeURIComponent(location.origin)}`}
      title={`${artifact.format === "pptx" ? "PPT" : artifact.format === "xlsx" ? "엑셀" : artifact.format === "hwp" || artifact.format === "hwpx" ? "한글" : artifact.format === "epub" ? "전자책" : artifact.format === "xmind" ? "마인드맵" : artifact.format === "pdf" ? "PDF" : artifact.format === "markdown" ? "Markdown" : artifact.format === "html" ? "HTML" : "워드"} 편집기 · ${artifact.name}`}
    />
  </>);
});
