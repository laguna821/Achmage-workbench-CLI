import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentRegistration } from "@workbench/contracts";
import type { Api } from "./api.ts";

// Each webview gets a fresh identity. A copied sessionStorage must not clone edit ownership.
export const windowId = `window-${crypto.randomUUID()}`;

export function useDocumentSession(rootApi: Api, artifactId: string | null, sessionId: string | null, wantsWrite = true) {
  const [viewId] = useState(() => `view-${crypto.randomUUID()}`);
  const [registration, setRegistration] = useState<DocumentRegistration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const confirmed = useRef<DocumentRegistration | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const progress = useRef({ dirty: false, revision: undefined as number | undefined, sessionId });
  progress.current.sessionId = sessionId;
  const update = useRef<(claim?: boolean) => Promise<void>>(async () => {});
  const api = useMemo(() => rootApi.forDocument(() => ({ viewId, writeToken: token.current })), [rootApi, viewId]);
  useEffect(() => {
    let stopped = false;
    let hiddenPage = false;
    token.current = null; setRegistration(null); setError(null);
    if (!artifactId) return;
    const run = (claim = false) => {
      const next = queue.current.catch(() => undefined).then(async () => {
        if (stopped || hiddenPage) return;
        try {
          const result = await rootApi.registerDocument(artifactId, { viewId, windowId, claim, ...progress.current });
          // A pending registration can reach the server after pagehide's keepalive close.
          // Close it again when its response arrives; unmount has its own queued cleanup.
          if (hiddenPage) { await rootApi.closeDocument(viewId, windowId); return; }
          if (stopped) return;
          token.current = result.writeToken; confirmed.current = result; setRegistration(result); setError(null);
        } catch (error) {
          if (stopped) return;
          token.current = null;
          confirmed.current = null;
          setError(error instanceof Error ? error.message : String(error));
        }
      });
      queue.current = next;
      return next;
    };
    update.current = run;
    void run(wantsWrite);
    const timer = window.setInterval(() => void run(), 10_000);
    const wake = () => { if (!document.hidden) void run(); };
    const pageHide = () => { hiddenPage = true; token.current = null; void rootApi.closeDocument(viewId, windowId).catch(() => undefined); };
    const pageShow = () => { if (hiddenPage) { hiddenPage = false; setError("편집 권한을 다시 확인해 주세요."); void run(); } };
    window.addEventListener("focus", wake); document.addEventListener("visibilitychange", wake);
    window.addEventListener("pagehide", pageHide); window.addEventListener("pageshow", pageShow);
    return () => {
      stopped = true; token.current = null; update.current = async () => {};
      window.clearInterval(timer); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pagehide", pageHide); window.removeEventListener("pageshow", pageShow);
      queue.current = queue.current.catch(() => undefined).then(() => rootApi.closeDocument(viewId, windowId)).catch(() => undefined);
    };
  }, [rootApi, artifactId, viewId, wantsWrite]);
  // Switching conversations changes the editor's AI capability immediately, even if
  // the document is clean. Waiting for the heartbeat leaves the old session bound.
  useEffect(() => { void update.current(); }, [sessionId]);
  useEffect(() => {
    if (!registration) return;
    const timer = window.setTimeout(() => { token.current = null; setError("편집 권한 확인이 만료되었습니다. 입력은 유지했습니다."); }, Math.max(0, registration.view.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [registration]);
  const report = useCallback((dirty: boolean, revision: number | undefined) => {
    const previous = progress.current;
    progress.current = { ...previous, dirty, revision };
    if (previous.dirty !== dirty || previous.revision !== revision) return update.current();
    return Promise.resolve();
  }, []);
  const claim = useCallback(() => update.current(true), []);
  const sync = useCallback(async (dirty: boolean, revision: number, expectedSession?: string | null) => {
    progress.current = { ...progress.current, dirty, revision, ...(expectedSession !== undefined ? { sessionId: expectedSession } : {}) };
    const expected = { ...progress.current };
    await update.current();
    const actual = confirmed.current?.view;
    if (!token.current || !actual || actual.sessionId !== expected.sessionId || actual.revision !== revision || actual.dirty !== dirty) {
      throw new Error("문서와 선택한 세션의 연결을 확인하지 못했습니다. 다시 시도해 주세요.");
    }
  }, []);
  const access = useCallback(() => ({ viewId, writeToken: token.current }), [viewId]);
  return { api, viewId, registration, error, ready: Boolean(registration), canWrite: !error && registration?.view.mode === "write", claim, report, sync, access };
}
