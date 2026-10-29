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
  const waiters = useRef<((revision: number | null) => void)[]>([]);
  const readOnly = requestedReadOnly || revision !== null;
  const latestAccess = useRef(access); latestAccess.current = access;
  const handlers = useRef({ onStatus, onSelection, onCopied, onExported, onError });
  handlers.current = { onStatus, onSelection, onCopied, onExported, onError };

  const theme = () => (frame.current?.closest("[data-theme]")?.getAttribute("data-theme") === "dark" ? "dark" : "light");
  const settle = (value: number | null) => {
    for (const resolve of waiters.current.splice(0)) resolve(value);
  };

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
          if (message.state === "saved" || message.state === "idle") settle(opened.current);
          if (message.state === "conflict" || message.state === "error") settle(null);
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
    if (status.current === "saved" || status.current === "idle") setGeneration((value) => value + 1);
  }, [artifact.revision, readOnly]);

  useImperativeHandle(ref, () => ({
    flush() {
      if (readOnly || status.current === "saved" || status.current === "idle") return Promise.resolve(opened.current);
      if (status.current === "conflict" || status.current === "error") return Promise.resolve(null);
      return new Promise((resolve) => {
        waiters.current.push(resolve);
        frame.current?.contentWindow?.postMessage({ type: "design:flush" }, location.origin);
        window.setTimeout(() => settle(status.current === "saved" ? opened.current : null), 8000);
      });
    },
  }));

  return <iframe key={`${artifact.id}:${revision ?? "latest"}:${readOnly}:${generation}`} ref={frame} className="design-frame" src={`/design/?a=${artifact.id}&g=${generation}`} title={`디자인 편집기 · ${artifact.name}`} />;
});
