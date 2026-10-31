import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Artifact, DocumentAccess, DesignPageMessage, DesignSaveState, DesignSelection } from "@workbench/contracts";
import { designToken } from "../../design.ts";

export type DesignHandle = {
  /** Save what is open now; resolves with the saved revision, or null when it could not be saved. */
  flush(): Promise<number | null>;
};

export type DesignStatus = { state: DesignSaveState; revision: number | null; message?: string };

/**
 * A design in the central area: the vendored doory editor in its own page (iframe, same origin).
 * Saves are revisions of the design file; a revision made elsewhere (an applied AI proposal) is
 * loaded when nothing is unsaved here, otherwise the editor shows its conflict banner.
 */
export const DesignView = forwardRef<
  DesignHandle,
  {
    artifact: Artifact;
    /** A fixed older revision, shown read only. */
    revision?: number | null;
    readOnly?: boolean;
    access?: DocumentAccess;
    onStatus(status: DesignStatus): void;
    onSelection(selection: DesignSelection | null): void;
    onCopied(artifactId: string): void;
    onExported(name: string, artifactId: string | null): void;
    onError(message: string): void;
  }
>(function DesignView({ artifact, revision = null, readOnly: requestedReadOnly = false, access, onStatus, onSelection, onCopied, onExported, onError }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [generation, setGeneration] = useState(0);
  const opened = useRef<number | null>(null);
  const status = useRef<DesignSaveState>("idle");
  const own = useRef(new Set<number>());
  const waiters = useRef(new Map<string, { resolve(value: number | null): void; timer: number }>());
  const readOnly = requestedReadOnly || revision !== null;
  const latestAccess = useRef(access); latestAccess.current = access;
  const handlers = useRef({ onStatus, onSelection, onCopied, onExported, onError });
  handlers.current = { onStatus, onSelection, onCopied, onExported, onError };

  const theme = () => (frame.current?.closest("[data-theme]")?.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const settle = (id: string, value: number | null) => {
    const pending = waiters.current.get(id);
    if (!pending) return;
    waiters.current.delete(id);
    window.clearTimeout(pending.timer);
    pending.resolve(value);
  };

  useEffect(() => {
    opened.current = null;
    status.current = "idle";
    return () => { for (const id of waiters.current.keys()) settle(id, null); };
  }, [artifact.id, revision, readOnly, generation]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as DesignPageMessage;
      const post = (value: unknown) => frame.current?.contentWindow?.postMessage(value, location.origin);
      switch (message.type) {
        case "design:ready":
          post({ type: "design:init", token: designToken() ?? "", artifactId: artifact.id, revision, readOnly, theme: theme(), access: latestAccess.current });
          break;
        case "design:opened":
          opened.current = message.revision;
          status.current = "saved";
          handlers.current.onStatus({ state: "saved", revision: message.revision });
          break;
        case "design:saved":
          own.current.add(message.revision);
          opened.current = message.revision;
          break;
        case "design:state":
          status.current = message.state;
          handlers.current.onStatus({ state: message.state, revision: opened.current, message: message.message });
          break;
        case "design:flushed":
          settle(message.requestId, message.revision);
          break;
        case "design:selection":
          handlers.current.onSelection(message.selection);
          break;
        case "design:reload":
          setGeneration((value) => value + 1);
          break;
        case "design:copied":
          handlers.current.onCopied(message.artifactId);
          break;
        case "design:exported":
          handlers.current.onExported(message.name, message.artifactId);
          break;
        case "design:error":
          handlers.current.onError(message.message);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifact.id, revision, readOnly]);
  useEffect(() => { if (access) frame.current?.contentWindow?.postMessage({ type: "design:access", access }, location.origin); }, [access?.viewId, access?.writeToken]);

  // Follow the app's light/dark switch.
  useEffect(() => {
    const scope = frame.current?.closest("[data-theme]");
    if (!scope) return;
    const observer = new MutationObserver(() => frame.current?.contentWindow?.postMessage({ type: "design:theme", theme: theme() }, location.origin));
    observer.observe(scope, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // A revision made elsewhere: open it when nothing here is unsaved.
  useEffect(() => {
    if (readOnly || opened.current === null || artifact.revision <= opened.current || own.current.has(artifact.revision)) return;
    frame.current?.contentWindow?.postMessage({ type: "design:check-reload", revision: artifact.revision }, location.origin);
  }, [artifact.revision, readOnly]);

  useImperativeHandle(ref, () => ({
    flush() {
      if (readOnly) return Promise.resolve(opened.current);
      if (!frame.current?.contentWindow || opened.current === null) return Promise.resolve(null);
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => settle(requestId, null), 30_000);
        waiters.current.set(requestId, { resolve, timer });
        frame.current?.contentWindow?.postMessage({ type: "design:flush", requestId }, location.origin);
      });
    },
  }));

  return <iframe key={`${artifact.id}:${revision ?? "latest"}:${readOnly}:${generation}`} ref={frame} className="design-frame" src={`/design/?a=${artifact.id}&g=${generation}`} title={`디자인 편집기 · ${artifact.name}`} />;
});
