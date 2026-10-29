import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Artifact, DocumentAccess, EditorGrant, OfficePageMessage } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import type { OfficeOutputPlan, OfficeOutputRequest } from "../../../../../packages/contracts/src/office-output.ts";
import { OfficeOutputDialog } from "./OfficeOutputDialog.tsx";

export type OfficeHandle = {
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
  { api: Api; artifact: Artifact; access?: DocumentAccess; hidden?: boolean; onStatus(status: OfficeStatus): void; onNotice(message: string): void; onCopied?(artifactId: string): void }
>(function OfficeEditor({ api, artifact, access, hidden = false, onStatus, onNotice, onCopied }, ref) {
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
  const handlers = useRef({ onStatus, onNotice, onCopied });
  handlers.current = { onStatus, onNotice, onCopied };
  const outputBusy = useRef(false);
  const outputPlans = useRef(new Map<string, OfficeOutputPlan>());
  const copied = useRef(new Set<string>());
  const [output, setOutput] = useState<{ revision: number; format: "pdf" | "hwp" | "hwpx"; choose(plan: OfficeOutputPlan | null): void } | null>(null);
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

  const handleOutput = async (message: OfficeOutputRequest) => {
    const target = frame.current?.contentWindow, origin = opened.current?.origin;
    if (!target || !origin) return;
    const reply = (value: unknown, error?: string) => target.postMessage({ type: "office:output-result", requestId: message.requestId, value, error }, origin);
    if (outputBusy.current) { reply(null, "다른 저장·출력 요청을 처리 중입니다."); return; }
    outputBusy.current = true;
    try {
      if (message.action === "commit") {
        const plan = outputPlans.current.get(message.planId);
        if (!plan || !(message.bytes instanceof ArrayBuffer)) throw new Error("저장 위치를 다시 선택하세요.");
        const result = await api.commitOfficeOutput(latest.current.id, plan.id, message.bytes, plan.replace);
        outputPlans.current.delete(plan.id); copied.current.add(result.artifact.id);
        reply({ path: result.path, artifactId: result.artifact.id });
        if (result.backupPath) handlers.current.onNotice(`이전 파일을 백업했습니다: ${result.backupPath}`);
        return;
      }
      if (message.action === "print") {
        if (!("__TAURI_INTERNALS__" in window)) throw new Error("인쇄는 데스크톱 앱에서 실행해 주세요.");
        const { invoke } = await import("@tauri-apps/api/core"); await invoke("print_svg", { job: message.job });
        handlers.current.onNotice("인쇄 미리보기 창을 열었습니다."); reply({}); return;
      }
      const plan = await new Promise<OfficeOutputPlan | null>((resolve) => setOutput({ revision: message.revision, format: message.action === "prepare" ? message.format : "pdf", choose: resolve }));
      setOutput(null);
      if (!plan) { reply(null); return; }
      if (message.action === "prepare") { outputPlans.current.set(plan.id, plan); reply(plan); return; }
      if (!("__TAURI_INTERNALS__" in window)) throw new Error("PDF 출력은 데스크톱 앱에서 실행해 주세요.");
      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = await invoke<ArrayBuffer>("render_svg_pdf", { job: message.job });
      const result = await api.commitOfficeOutput(latest.current.id, plan.id, bytes, plan.replace);
      handlers.current.onNotice(`PDF를 저장했습니다: ${result.path}`);
      reply({ path: result.path, artifactId: result.artifact.id });
    } catch (error) { reply(null, error instanceof Error ? error.message : String(error)); }
    finally { outputBusy.current = false; }
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
  }, [artifact.id, generation, access?.writeToken]);
  const current = grant && grant.generation === generation ? grant : null;
  opened.current = current && "value" in current ? current.value : null;
  useEffect(() => { if (opened.current) send({ type: "office:grant", token: opened.current.token }); }, [current]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!opened.current || event.origin !== opened.current.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as OfficePageMessage;
      switch (message.type) {
        case "office:output": void handleOutput(message); break;
        case "office:copied":
          if (copied.current.delete(message.artifactId)) {
            // The unsaved bytes now belong to the copy. Restore this old tab from its actual
            // original file, then open the copy in the same session.
            recover.current = false;
            update({ dirty: false, revision: null, conflict: null });
            setGeneration((value) => value + 1);
            handlers.current.onCopied?.(message.artifactId);
          }
          break;
        case "office:ready": {
          const doc = latest.current;
          send({
            type: "office:init",
            token: opened.current.token,
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

  useImperativeHandle(ref, () => ({
    flush() {
      if (status.current.conflict) return Promise.resolve(null);
      // Not opened yet: nothing can have been edited.
      if (status.current.revision === null) return Promise.resolve(latest.current.revision);
      const flushed = waitFlushed();
      send({ type: "office:flush" });
      return flushed;
    },
    rebase(revision) {
      const flushed = waitFlushed();
      send({ type: "office:rebase", revision });
      return flushed;
    },
    async leave() {
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
    {output ? <OfficeOutputDialog api={api} artifact={artifact} revision={output.revision} format={output.format} onChoose={output.choose} onCancel={() => output.choose(null)} /> : null}
    <iframe
      key={`${artifact.id}:${generation}`}
      ref={frame}
      className="design-frame office-frame"
      // Kept loaded (with its unsaved edits) while a comparison or an older revision is shown over it.
      style={hidden ? { display: "none" } : undefined}
      allow="fullscreen; clipboard-read; clipboard-write"
      src={`${opened.current.url}?a=${artifact.id}&g=${generation}&host=${encodeURIComponent(location.origin)}`}
      title={`${artifact.format === "pptx" ? "PPT" : artifact.format === "xlsx" ? "엑셀" : artifact.format === "hwp" || artifact.format === "hwpx" ? "한글" : "워드"} 편집기 · ${artifact.name}`}
    />
  </>);
});
