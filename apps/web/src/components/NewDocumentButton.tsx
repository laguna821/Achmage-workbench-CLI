import { useRef, useState } from "react";
import { BLANK_OFFICE_DOCUMENTS, type Artifact, type BlankOfficeFormat, type Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import "./new-document.css";

/** Creates an actual blank file without starting a provider or requiring a conversation. */
export function NewDocumentButton({ api, state, workId, workspaceId, onOpen }: {
  api: Api; state: State; workId?: string | null; workspaceId?: string;
  onOpen: (artifact: Artifact) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false), created = useRef<Work | null>(null);
  const [target, setTarget] = useState(""), [format, setFormat] = useState<BlankOfficeFormat>("docx");
  const [name, setName] = useState(""), [projectName, setProjectName] = useState("내 문서");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const projects = Object.values(state.works).filter((work) => !work.archivedAt);
  const kind = BLANK_OFFICE_DOCUMENTS.find((entry) => entry.format === format)!;
  const open = () => {
    created.current = null; setError(""); setName("");
    setTarget(projects.some((entry) => entry.id === workId) ? workId! : projects[0]?.id ?? "");
    dialog.current?.showModal();
  };
  const create = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const project = target ? state.works[target] : created.current ?? await api.createWork(projectName.trim() || "내 문서", null, null);
      if (!project) throw new Error("저장할 프로젝트를 다시 선택해 주세요.");
      if (!target) created.current = project;
      const file = await api.createOfficeDocument(project.id, { format, name: name.trim() || kind.name,
        ...(target === workId && workspaceId ? { workspaceId } : {}) });
      dialog.current?.close(); onOpen(file);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <>
    <button type="button" className="ghost-button small" onClick={open}><Icon name="file" size={15} /> 새 문서</button>
    <dialog ref={dialog} className="new-document-dialog" aria-labelledby="new-document-title" onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <header><h2 id="new-document-title">새 문서 만들기</h2><button type="button" className="icon-button" aria-label="새 문서 닫기" disabled={busy} onClick={() => dialog.current?.close()}><Icon name="x" size={18} /></button></header>
        <p className="muted">빈 파일을 만들고 바로 편집합니다. AI 연결 없이 사용할 수 있습니다.</p>
        <label>저장할 프로젝트<select value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
          {projects.map((work) => <option key={work.id} value={work.id}>{work.title}</option>)}<option value="">새 프로젝트 만들기…</option>
        </select></label>
        {!target ? <label>프로젝트 이름<input value={projectName} disabled={busy} onChange={(event) => setProjectName(event.target.value)} /></label> : null}
        <label>문서 종류<select value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as BlankOfficeFormat)}>
          {BLANK_OFFICE_DOCUMENTS.map((entry) => <option key={entry.format} value={entry.format}>{entry.label} (.{entry.extension})</option>)}
        </select></label>
        <label>파일 이름<input autoFocus value={name} placeholder={kind.name} disabled={busy} onChange={(event) => setName(event.target.value)} /><small className="muted">.{kind.extension} · 같은 이름이 있으면 새 이름으로 만듭니다.</small></label>
        {target ? <small className="muted new-document-path">{target === workId && workspaceId ? state.workspaces[workspaceId]?.cwd : state.works[target]?.cwd}</small> : null}
        {error ? <p role="alert">{error}</p> : null}
        <footer><button type="submit" className="button primary" disabled={busy}>{busy ? "만드는 중…" : "만들고 열기"}</button></footer>
      </form>
    </dialog>
  </>;
}
