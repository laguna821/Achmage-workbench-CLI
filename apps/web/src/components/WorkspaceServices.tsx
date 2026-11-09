import { safeRandomId } from "@workbench/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalSession, Workspace, WorkspaceService, WorkspaceServiceList, WorkspaceServiceStart } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "../styles/workspace-services.css";
import { WorkspaceServiceInspect } from "./WorkspaceServiceInspect.tsx";

type Draft = { label: string; command: string; port: string };
type SavedDraft = { draft: Draft; pending: WorkspaceServiceStart | null };
const emptyDraft: Draft = { label: "개발 서버", command: "", port: "" };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const active = (entry: WorkspaceService) => ["starting", "running", "stopping"].includes(entry.status);
const statusText = (entry: WorkspaceService) => ({ starting: "시작 중", running: "실행 중", stopping: "종료 중", exited: `종료 (${entry.exitCode ?? "—"})`, interrupted: "이전 실행 중단", error: "오류" })[entry.status];
function readDraft(key: string): SavedDraft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as SavedDraft | null;
    if (saved && typeof saved.draft?.label === "string" && typeof saved.draft.command === "string" && typeof saved.draft.port === "string") {
      const pending = saved.pending;
      return { draft: saved.draft, pending: pending && typeof pending.requestId === "string" && typeof pending.label === "string" && typeof pending.command === "string" && (pending.port === undefined || Number.isInteger(pending.port)) ? pending : null };
    }
  } catch { /* A blocked storage area still leaves the current dialog usable. */ }
  return { draft: { ...emptyDraft }, pending: null };
}

export function WorkspaceServices({ api, workspace, onOpen, onClose, openExternal }: {
  api: Api; workspace: Workspace; onOpen: (terminal: TerminalSession) => void; onClose: () => void; openExternal: (url: string) => Promise<void>;
}) {
  const storageKey = `workbench.serviceDraft:${workspace.hostId}:${workspace.id}`;
  const [saved] = useState(() => readDraft(storageKey));
  const [draft, setDraft] = useState(saved.draft), [pending, setPending] = useState(saved.pending);
  const draftRef = useRef(draft), pendingRef = useRef(pending);
  const [result, setResult] = useState<WorkspaceServiceList | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [readError, setReadError] = useState(""), [notice, setNotice] = useState("");
  const [inspect, setInspect] = useState<{ id: string; mode: "logs" | "proxy" } | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement), mounted = useRef(true), acting = useRef(false);
  const listVersion = useRef(0), readQueue = useRef<Promise<unknown>>(Promise.resolve());
  const persist = useCallback(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify({ draft: draftRef.current, pending: pendingRef.current })); } catch { /* Keep the live draft. */ }
  }, [storageKey]);
  const rememberPending = useCallback((value: WorkspaceServiceStart | null) => {
    pendingRef.current = value; persist(); if (mounted.current) setPending(value);
  }, [persist]);
  const change = (patch: Partial<Draft>) => {
    draftRef.current = { ...draftRef.current, ...patch }; setDraft(draftRef.current); persist();
  };
  // Reads are serialized. A response begun before a mutation cannot replace its newer result.
  const readList = useCallback(async () => {
    const version = listVersion.current;
    const reading = readQueue.current.then(() => api.workspaceServices(workspace.id));
    readQueue.current = reading.catch(() => undefined);
    const next = await reading;
    if (mounted.current && version === listVersion.current) {
      setResult(next); setReadError("");
      // The host uses requestId as the service id, including after a lost start response.
      const accepted = next.services.find(entry => entry.id === pendingRef.current?.requestId);
      if (accepted) { rememberPending(null); setNotice(`${accepted.label} 실행 요청을 확인했습니다.`); }
    }
    return next;
  }, [api, workspace.id, rememberPending]);
  useLayoutEffect(() => {
    const surface = dialog.current; surface?.showModal();
    return () => restoreSurfaceFocus(opener.current, surface);
  }, []);
  useEffect(() => {
    mounted.current = true; let gone = false, timer: number | undefined;
    const refresh = async () => {
      if (!acting.current) try { await readList(); } catch (reason) { if (!gone) setReadError(message(reason)); }
      if (!gone) timer = window.setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => { gone = true; mounted.current = false; clearTimeout(timer); };
  }, [readList]);
  const run = async (action: () => Promise<void>) => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (reason) { if (mounted.current) setError(message(reason)); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  };
  const upsert = (entry: WorkspaceService) => {
    if (mounted.current) setResult(before => ({ available: before?.available ?? true, services: [entry, ...(before?.services ?? []).filter(row => row.id !== entry.id)].sort((a, b) => b.startedAt - a.startedAt) }));
  };
  const post = async (request: WorkspaceServiceStart) => {
    listVersion.current++;
    try {
      const entry = await api.startWorkspaceService(workspace.id, request);
      if (entry.id !== request.requestId || entry.workspaceId !== workspace.id) throw new Error("실행 응답의 작업공간을 확인할 수 없습니다.");
      upsert(entry); rememberPending(null); if (mounted.current) setNotice(`${entry.label} 실행 요청을 접수했습니다.`);
    } catch (reason) {
      if (mounted.current) setError(message(reason));
      // Never turn a lost response into a fresh command. Observe first, then keep the same receipt.
      let found = false;
      try { const next = await readList(); found = next.services.some(entry => entry.id === request.requestId); }
      catch (readReason) { if (mounted.current) setReadError(message(readReason)); }
      if (!found && reason instanceof ApiRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) rememberPending(null);
    }
  };
  const start = () => run(async () => {
    if (pendingRef.current || !result?.available || workspace.archivedAt !== null || workspace.removedAt !== null) return;
    const port = draft.port.trim() ? Number(draft.port) : undefined;
    if (!draft.label.trim() || !draft.command.trim() || (port !== undefined && (!/^\d+$/.test(draft.port.trim()) || !Number.isInteger(port) || port < 1 || port > 65535))) throw new Error("이름·실행 명령과 1~65535 범위의 포트를 확인해 주세요.");
    const request: WorkspaceServiceStart = { requestId: safeRandomId(), label: draft.label.trim(), command: draft.command, ...(port === undefined ? {} : { port }) };
    rememberPending(request); await post(request);
  });
  const retry = () => run(async () => {
    const request = pendingRef.current; if (!request) return;
    const next = await readList();
    if (next.services.some(entry => entry.id === request.requestId)) return;
    if (!next.available || workspace.archivedAt !== null || workspace.removedAt !== null) throw new Error("현재 작업공간에서는 실행 요청을 다시 보낼 수 없습니다. 기록 확인은 계속됩니다.");
    await post(request);
  });
  const unavailable = workspace.archivedAt !== null || workspace.removedAt !== null;
  return <dialog ref={dialog} className="workspace-services-dialog" aria-labelledby="workspace-services-title" aria-busy={busy} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <header><h2 id="workspace-services-title">{workspace.label} · 서버·실행 관리</h2><button type="button" className="button small" disabled={busy} onClick={onClose}>닫기</button></header>
    <dl className="workspace-service-location"><dt>호스트</dt><dd>{workspace.hostId}</dd><dt>실행 폴더</dt><dd>{workspace.cwd}</dd></dl>
    <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <label>실행 이름<input autoFocus value={draft.label} maxLength={80} disabled={busy || !!pending} onChange={event => change({ label: event.target.value })} /></label>
      <label>실행 명령<textarea value={draft.command} maxLength={8192} rows={3} disabled={busy || !!pending} placeholder="실행할 명령을 입력하세요" onChange={event => change({ command: event.target.value })} /></label>
      <label>포트 · 선택<input inputMode="numeric" value={draft.port} disabled={busy || !!pending} placeholder="예: 3000" onChange={event => change({ port: event.target.value })} /></label>
      <p className="muted">지정한 포트를 PORT 환경 변수로 전달합니다. 도구에 포트 옵션이 필요하면 실행 명령에도 넣어 주세요.</p>
      {!pending ? <button className="button primary" type="submit" disabled={busy || !result?.available || unavailable || !draft.label.trim() || !draft.command.trim()}>{busy ? "요청 처리 중…" : "명령 실행"}</button> : null}
    </form>
    {pending ? <div className="workspace-service-pending" role="status"><strong>{busy ? "실행 요청 확인 중…" : "실행 결과 확인 필요"}</strong><p>응답이 확인되기 전까지 입력한 명령을 유지합니다. 기록을 확인한 뒤 같은 요청만 다시 보낼 수 있습니다.</p><div className="workspace-service-actions"><button type="button" className="button small" disabled={busy} onClick={() => void run(async () => { await readList(); })}>실행 기록 확인</button><button type="button" className="button small" disabled={busy || unavailable} onClick={() => void retry()}>같은 요청 다시 보내기</button></div></div> : null}
    {unavailable ? <p className="muted">보관되거나 제거된 작업공간입니다. 기존 출력 확인과 실행 종료를 할 수 있습니다.</p> : null}
    {result && !result.available ? <p className="muted">이 호스트에는 터미널 실행기가 없습니다. 이전 실행 기록은 확인할 수 있습니다.</p> : null}
    {error ? <p className="workspace-service-error" role="alert">{error}</p> : null}
    {readError ? <p className="workspace-service-error" role="alert">실행 기록을 읽지 못했습니다. {readError}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="workspace-service-heading"><h3>실행 기록</h3><button type="button" className="button small" disabled={busy} onClick={() => void run(async () => { await readList(); })}>새로고침</button></div>
    {!result ? <p className="muted">실행 기록을 읽는 중…</p> : !result.services.length ? <p className="muted">이 작업공간에서 실행한 서버가 없습니다.</p> : <div className="workspace-service-list">{result.services.map(entry => {
      const url = entry.status === "running" && Number.isInteger(entry.port) && entry.port! >= 1 && entry.port! <= 65535 ? `http://127.0.0.1:${entry.port}` : null;
      return <article className="workspace-service-row" key={entry.id} aria-label={`${entry.label} 실행 기록`} data-status={entry.status}>
        <header><strong>{entry.label}</strong><span>{statusText(entry)}</span></header>
        <small>{new Date(entry.startedAt).toLocaleString()} · 호스트 {entry.hostId}</small><div className="workspace-service-cwd">{entry.cwd}</div><pre>{entry.command}</pre>
        {entry.port ? <p className="workspace-service-port">포트 {entry.port}{url ? <> · <a href={url} onClick={event => { event.preventDefault(); if (!busy) { if (api.isRemote) setInspect({ id: entry.id, mode: "proxy" }); else void run(() => openExternal(url)); } }}>{url} 열기</a></> : null}</p> : null}
        {entry.error ? <p className="workspace-service-error">{entry.error}</p> : null}
        <div className="workspace-service-actions">
          <button type="button" className="button small" onClick={() => setInspect({ id: entry.id, mode: "logs" })}>로그 검색</button>
          {url ? <button type="button" className="button small" onClick={() => setInspect({ id: entry.id, mode: "proxy" })}>서비스 포트 요청</button> : null}
          <button type="button" className="button small" disabled={busy} onClick={() => void run(async () => {
            const { terminal } = await api.terminalOutput(entry.terminalId);
            if (terminal.id !== entry.terminalId || terminal.workspaceId !== entry.workspaceId || terminal.createdAt !== entry.startedAt) throw new Error("이 실행의 터미널을 확인할 수 없습니다. 실행 기록을 다시 불러와 주세요.");
            onOpen(terminal); onClose();
          })}>출력·터미널 열기</button>
          {active(entry) ? <button type="button" className="button small" disabled={busy || entry.status === "stopping"} onClick={() => void run(async () => {
            listVersion.current++; upsert(await api.stopWorkspaceService(entry.id, { ownerId: entry.ownerId, terminalId: entry.terminalId, startedAt: entry.startedAt }));
          })}>{entry.status === "stopping" ? "종료 중…" : "실행 종료"}</button> : removeId !== entry.id ? <button type="button" className="text-button" disabled={busy} onClick={() => setRemoveId(entry.id)}>기록 지우기…</button> : <><span>터미널 출력은 남습니다.</span><button type="button" className="button small" disabled={busy} onClick={() => void run(async () => { listVersion.current++; await api.deleteWorkspaceService(entry.id); setResult(before => before && { ...before, services: before.services.filter(row => row.id !== entry.id) }); setRemoveId(null); })}>기록만 지우기</button><button type="button" className="text-button" disabled={busy} onClick={() => setRemoveId(null)}>취소</button></>}
        </div>
        {inspect?.id === entry.id ? <WorkspaceServiceInspect key={entry.id + inspect.mode} api={api} service={entry} mode={inspect.mode} onClose={() => setInspect(null)} /> : null}
      </article>;
    })}</div>}
    <p className="muted workspace-service-footnote">창을 닫아도 실행은 유지됩니다. 실행 기록에서 명령을 자동으로 다시 시작하지 않습니다.</p>
  </dialog>;
}
