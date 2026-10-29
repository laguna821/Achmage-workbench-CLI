import { useEffect, useState } from "react";
import type { TerminalList, TerminalSession, Workspace } from "@workbench/contracts";
import type { Api } from "../api.ts";
import "../styles/terminal.css";

export const terminalStatus = (entry: TerminalSession) => ({ starting: "시작 중", running: "실행 중", stopping: "종료 중", exited: `종료 (${entry.exitCode ?? "—"})`, interrupted: "이전 실행 중단", error: "오류" })[entry.status];

export function TerminalDialog({ api, workspace, onOpen, onClose }: { api: Api; workspace: Workspace; onOpen: (entry: TerminalSession) => void; onClose: () => void }) {
  const [result, setResult] = useState<TerminalList | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [label, setLabel] = useState("터미널"), [shell, setShell] = useState(""), [args, setArgs] = useState("");
  useEffect(() => {
    let gone = false;
    const refresh = () => { void api.terminals(workspace.id).then((result) => { if (!gone) setResult(result); }).catch((error) => { if (!gone) setError(String(error)); }); };
    refresh(); const timer = window.setInterval(refresh, 1500);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => { gone = true; clearInterval(timer); window.removeEventListener("keydown", key); };
  }, [api, workspace.id, onClose]);
  const open = (entry: TerminalSession) => { onOpen(entry); onClose(); };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="terminal-dialog" role="dialog" aria-modal="true" aria-label="작업공간 터미널">
      <header><h2>{workspace.label} · 터미널</h2><button className="button small" onClick={onClose}>닫기</button></header>
      <p className="terminal-path">{workspace.cwd}</p>
      <form onSubmit={async (event) => {
        event.preventDefault(); if (busy) return; setBusy(true); setError("");
        try { open(await api.createTerminal(workspace.id, { requestId: crypto.randomUUID(), label, ...(shell.trim() ? { shell: shell.trim(), args: args ? args.split("\n") : [] } : {}) })); }
        catch (error) { setError(String(error)); } finally { setBusy(false); }
      }}>
        <label>터미널 이름<input aria-label="터미널 이름" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} /></label>
        <details><summary>셸 직접 지정</summary>
          <label>실행 파일<input aria-label="터미널 셸" value={shell} onChange={(event) => setShell(event.target.value)} placeholder="비워 두면 기본 셸" /></label>
          <label>인자 · 한 줄에 하나<textarea aria-label="터미널 셸 인자" value={args} onChange={(event) => setArgs(event.target.value)} rows={3} /></label>
        </details>
        <button className="button primary terminal-create" type="submit" disabled={busy || !result?.available || workspace.archivedAt !== null || workspace.removedAt !== null}>새 터미널 열기</button>
      </form>
      {result && !result.available ? <p>이 실행 환경에는 터미널 실행기가 없습니다. 데스크톱 앱에서 열어 주세요.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <p className="muted">탭을 닫아도 실행은 유지됩니다. 실행 종료는 터미널 안에서 선택합니다.</p>
      <div className="terminal-history">{result?.terminals.map((entry) => <button className="terminal-history-row" key={entry.id} data-terminal-id={entry.id} onClick={() => open(entry)}>
        <strong>{entry.label}</strong><span>{terminalStatus(entry)}</span><small>{new Date(entry.createdAt).toLocaleString()}</small>
      </button>)}</div>
    </section>
  </div>;
}
