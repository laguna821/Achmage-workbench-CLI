import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Artifact, EditorGrant, OfficePageMessage } from "@workbench/contracts";
import type { Api } from "../../api.ts";

export type OfficeHandle = {
  /** Save unsaved edits now; resolves with the saved revision, or null when they could not be saved. */
  flush(): Promise<number | null>;
  /** After a conflict: save my edits as the revision after `revision`; null when there was nothing to keep or it failed. */
  rebase(revision: number): Promise<number | null>;
  /** Open the latest revision; unsaved edits in the editor are dropped. */
  reload(): void;
  /** Before the document view goes away: save, or keep the edits for the next visit. Never takes long. */
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
  { api: Api; artifact: Artifact; hidden?: boolean; onStatus(status: OfficeStatus): void; onNotice(message: string): void }
>(function OfficeEditor({ api, artifact, hidden = false, onStatus, onNotice }, ref) {
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
  const handlers = useRef({ onStatus, onNotice });
  handlers.current = { onStatus, onNotice };
  const latest = useRef(artifact);
  latest.current = artifact;

  const theme = () => (frame.current?.closest("[data-theme]")?.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const update = (patch: Partial<OfficeStatus>) => {
    status.current = { ...status.current, ...patch };
    handlers.current.onStatus(status.current);
  };
  const send = (value: unknown) => {
    if (opened.current) frame.current?.contentWindow?.postMessage(value, opened.current.origin);
  };
  const waitFlushed = () =>
    new Promise<number | null>((resolve) => {
      waiters.current.push(resolve);
      window.setTimeout(() => resolve(status.current.dirty ? null : latest.current.revision), 16_000);
    });

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
  }, [artifact.id, generation]);
  const current = grant && grant.generation === generation ? grant : null;
  opened.current = current && "value" in current ? current.value : null;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!opened.current || event.origin !== opened.current.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as OfficePageMessage;
      switch (message.type) {
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
          break;
        case "office:saving":
          savingSince.current = Date.now();
          break;
        case "office:saved":
          savingSince.current = 0;
          own.current.add(message.revision);
          update({ revision: message.revision, dirty: false, conflict: null });
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
    const shown = status.current.revision;
    if (shown === null || artifact.revision <= shown || own.current.has(artifact.revision)) return;
    // The page's own save, heard of from the gateway before its "office:saved".
    if (Date.now() - savingSince.current < 15_000) return;
    if (!status.current.dirty && !status.current.conflict) setGeneration((value) => value + 1);
    else if (!status.current.conflict) {
      update({ conflict: { code: "revision_conflict", message: `다른 곳에서 r${artifact.revision}이 생겼습니다. 저장하지 않은 편집은 편집기에 그대로 있습니다.` } });
    }
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
      const done = waitFlushed();
      send({ type: status.current.conflict ? "office:keep" : "office:flush" });
      await Promise.race([done, new Promise((resolve) => window.setTimeout(resolve, 4000))]);
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
  return (
    <iframe
      key={`${artifact.id}:${generation}`}
      ref={frame}
      className="design-frame office-frame"
      // Kept loaded (with its unsaved edits) while a comparison or an older revision is shown over it.
      style={hidden ? { display: "none" } : undefined}
      allow="fullscreen; clipboard-read; clipboard-write"
      src={`${opened.current.url}?a=${artifact.id}&g=${generation}&host=${encodeURIComponent(location.origin)}`}
      title={`${artifact.format === "pptx" ? "PPT" : artifact.format === "xlsx" ? "엑셀" : "워드"} 편집기 · ${artifact.name}`}
    />
  );
});
