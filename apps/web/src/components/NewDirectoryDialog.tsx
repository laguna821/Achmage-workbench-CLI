import { useLayoutEffect, useRef, useState } from "react";
import type { Workspace } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "./new-document.css";

export function NewDirectoryDialog({ api, workspace, onCreated, onClose }: {
  api: Api; workspace: Workspace; onCreated(value: { workspaceId: string; path: string; relativePath: string }): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement), pending = useRef(false);
  const [path, setPath] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useLayoutEffect(() => { const surface = dialog.current; surface?.showModal(); return () => restoreSurfaceFocus(opener.current, surface); }, []);
  const create = async () => {
    if (pending.current) return;
    const relative = path.trim().replaceAll("\\", "/");
    if (!relative || relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) {
      setError("작업공간 안의 상대 경로를 입력해 주세요. 예: 자료 또는 강의/자료"); return;
    }
    pending.current = true; setBusy(true); setError("");
    try { const created = await api.createWorkspaceDirectory(workspace.id, relative); onCreated(created); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="new-document-dialog" aria-labelledby="new-directory-title" aria-busy={busy} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <header><h2 id="new-directory-title">프로젝트 안 새 폴더</h2><button type="button" className="icon-button" aria-label="새 폴더 닫기" disabled={busy} onClick={onClose}><Icon name="x" size={18} /></button></header>
      <p className="muted">이 작업공간에 실제 폴더를 만듭니다.</p>
      <div className="new-document-path"><strong>{workspace.label}</strong><div>{workspace.cwd}</div></div>
      <label>폴더 상대 경로<input autoFocus value={path} disabled={busy} placeholder="자료" onChange={event => setPath(event.target.value)} /><small className="muted">상위 폴더는 이미 있어야 합니다. 같은 경로는 덮어쓰지 않습니다.</small></label>
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" className="ghost-button" disabled={busy} onClick={onClose}>취소</button><button type="submit" className="button primary" disabled={busy || !path.trim()}>{busy ? "만드는 중…" : "폴더 만들기"}</button></footer>
    </form>
  </dialog>;
}
