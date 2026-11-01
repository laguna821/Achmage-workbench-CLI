import { useEffect, useRef, useState } from "react";
import type { DropboxListing, DropboxOpened, DropboxState } from "../../../../packages/contracts/src/dropbox.ts";
import type { Api } from "../api.ts";
import "../styles/dropbox.css";

export function DropboxDialog({ api, pickFolder, openExternal, onOpened, onClose }: {
  api: Api; pickFolder: ((start?: string) => Promise<string | null>) | null; openExternal(url: string): Promise<void>; onOpened(value: DropboxOpened): void; onClose(): void;
}) {
  const [state, setState] = useState<DropboxState | null>(null), [files, setFiles] = useState<DropboxListing | null>(null);
  const [path, setPath] = useState(""), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const run = async (task: () => Promise<void>) => { setBusy(true); setError(null); try { await task(); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); } finally { if (alive.current) setBusy(false); } };
  const browse = async (target = "") => { const result = await api.request<DropboxListing>("GET", `/api/dropbox/files?${new URLSearchParams({ path: target })}`); if (alive.current) setFiles(result); };
  const accept = async (next: DropboxState) => { if (!alive.current) return; setState(next); setPath(next.selected?.path ?? ""); setFiles(null); if (next.selected?.available) await browse(); };
  const refresh = () => run(async () => accept(await api.request<DropboxState>("GET", "/api/dropbox")));
  const connect = (target: string) => run(async () => accept(await api.request<DropboxState>("PUT", "/api/dropbox", { path: target })));
  const open = (target: string, kind: "folder" | "document") => run(async () => { const value = await api.request<DropboxOpened>("POST", "/api/dropbox/open", { path: target, kind }); if (alive.current) onOpened(value); });
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [api]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [busy, onClose]);
  return <div className="modal-backdrop">
    <section className="dropbox-dialog" role="dialog" aria-modal="true" aria-label="Dropbox 연결">
      <header><h2>Dropbox</h2><button className="icon-button" aria-label="Dropbox 닫기" disabled={busy} onClick={onClose}>×</button></header>
      <p>Dropbox 앱의 동기화 폴더를 연결합니다. 문서를 원래 위치에서 열고 저장하며, 이음오피스 앱에서도 같은 파일을 이어서 씁니다.</p>
      <div className="dropbox-actions">
        <button className="text-button" disabled={busy} onClick={() => void run(() => openExternal("https://www.dropbox.com/install"))}>Dropbox 앱 설치·로그인 안내</button>
        <button className="text-button" disabled={busy} onClick={() => void refresh()}>폴더 다시 찾기</button>
      </div>
      {state?.candidates.filter(candidate => candidate.path !== state.selected?.path).map(candidate => <div className="dropbox-candidate" key={candidate.path}>
        <span><strong>{candidate.label}</strong><small className="mono">{candidate.path}</small>{!candidate.available && <small>현재 이 컴퓨터에서 폴더를 찾을 수 없습니다.</small>}</span>
        <button className="button small" disabled={busy || !candidate.available} onClick={() => void connect(candidate.path)}>이 폴더 연결</button>
      </div>)}
      <form onSubmit={event => { event.preventDefault(); void connect(path); }}>
        <label htmlFor="dropbox-folder-path">Dropbox 폴더 또는 그 안의 작업 폴더</label>
        <div className="dropbox-actions"><input id="dropbox-folder-path" value={path} onChange={event => setPath(event.target.value)} className="sheet-input mono" placeholder="Dropbox 폴더 경로" spellCheck={false} />
          {pickFolder && <button type="button" className="button small" disabled={busy} onClick={() => void run(async () => { const selected = await pickFolder(path || undefined); if (selected && alive.current) setPath(selected); })}>고르기…</button>}
          <button className="button primary small" type="submit" disabled={busy || !path.trim()}>연결</button>
        </div>
      </form>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {state?.selected && <div className="dropbox-status" role="status">
        <strong>{state.selected.available ? "연결한 폴더를 사용할 수 있습니다." : "연결한 폴더를 현재 찾을 수 없습니다. 연결 정보와 문서 기록은 보존됩니다."}</strong>
        {state.selected.source !== "registered" && <p>직접 고른 폴더입니다. Dropbox 앱에서 실제 동기화 위치인지 확인해 주세요.</p>}
        <p>클라우드 업로드·다운로드 상태는 Dropbox 앱에서 확인하세요. 자주 쓰는 문서는 ‘오프라인 사용 가능’으로 설정하면 인터넷 없이 편집할 수 있습니다.</p>
        <button className="text-button" disabled={busy} onClick={() => void run(async () => accept(await api.request<DropboxState>("DELETE", "/api/dropbox")))}>연결 해제 · 파일은 유지</button>
      </div>}
      {files && <section className="dropbox-files" aria-label="Dropbox 문서와 폴더">
        <div className="dropbox-actions"><strong className="mono dropbox-current-path">{files.path}</strong><button className="button small" data-dropbox-project disabled={busy} onClick={() => void open(files.path, "folder")}>이 폴더를 프로젝트로 열기</button></div>
        <div className="dropbox-actions"><button className="text-button" disabled={busy || !files.parent} onClick={() => void run(() => browse(files.parent!))}>상위 폴더</button><button className="text-button" disabled={busy} onClick={() => void run(() => browse(files.path))}>목록 새로 고침</button></div>
        <ul>{files.entries.map(entry => <li key={entry.path}><button className="dropbox-entry" data-dropbox-kind={entry.kind} disabled={busy} onClick={() => entry.kind === "folder" ? void run(() => browse(entry.path)) : void open(entry.path, "document")}><span className="dropbox-entry-kind">{entry.kind === "folder" ? "폴더" : "문서"}</span><span>{entry.name}</span>{entry.conflictedCopy && <span className="warn">충돌 사본 · 별도 보존</span>}</button></li>)}</ul>
        {!files.entries.length && <p className="muted">폴더나 지원하는 문서가 없습니다. 이 폴더를 프로젝트로 열면 새 문서를 만들 수 있습니다.</p>}
        {files.truncated && <p className="muted">앞의500개를 표시했습니다. 필요한 하위 폴더를 직접 선택할 수 있습니다.</p>}
      </section>}
      <footer className="muted">연결은 파일을 옮기거나 지우지 않습니다. 대화 기록·앱 설정·로그인 정보는 이 컴퓨터에 보관합니다.</footer>
    </section>
  </div>;
}
