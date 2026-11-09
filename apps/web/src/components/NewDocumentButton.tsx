import { useLayoutEffect, useRef, useState } from "react";
import { BLANK_OFFICE_DOCUMENTS, type Artifact, type BlankOfficeFormat, type Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "./new-document.css";

export const NEW_DOCUMENT_TYPES = [...BLANK_OFFICE_DOCUMENTS,
  { format: "design", extension: "design.json", label: "디자인 (doory)", name: "새 디자인" },
] as const;
export type NewDocumentFormat = BlankOfficeFormat | "design";
export type NewDocumentTarget = { workId?: string | null; workspaceId?: string; format?: NewDocumentFormat };

/** One creation dialog shared by tabs, project rows and empty project space. It never starts AI. */
export function NewDocumentDialog({ api, state, request, onOpen, onClose }: {
  api: Api; state: State; request: NewDocumentTarget;
  onOpen: (artifact: Artifact) => void; onClose: () => void;
}) {
  const { workId, workspaceId } = request;
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false), created = useRef<Work | null>(null);
  const opener = useRef(document.activeElement);
  const projects = Object.values(state.works).filter((work) => !work.archivedAt);
  const [target, setTarget] = useState(() => projects.some((entry) => entry.id === workId) ? workId! : projects[0]?.id ?? "");
  const [format, setFormat] = useState<NewDocumentFormat>(request.format ?? "docx");
  const [preset, setPreset] = useState("square");
  const [name, setName] = useState(""), [projectName, setProjectName] = useState("내 문서");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const kind = NEW_DOCUMENT_TYPES.find((entry) => entry.format === format)!;
  useLayoutEffect(() => {
    const surface = dialog.current;
    surface?.showModal();
    return () => restoreSurfaceFocus(opener.current, surface);
  }, []);
  const create = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const project = target ? state.works[target] : created.current ?? await api.createWork(projectName.trim() || "내 문서", null, null);
      if (!project) throw new Error("저장할 프로젝트를 다시 선택해 주세요.");
      if (!target) created.current = project;
      const into = target === workId ? workspaceId : undefined;
      const file = format === "design"
        ? await api.createDesign(project.id, name.trim() || kind.name, preset, into)
        : await api.createOfficeDocument(project.id, { format, name: name.trim() || kind.name, ...(into ? { workspaceId: into } : {}) });
      onOpen(file); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="new-document-dialog" aria-labelledby="new-document-title" aria-busy={busy} onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <header><h2 id="new-document-title">새 문서 만들기</h2><button type="button" className="icon-button" aria-label="새 문서 닫기" disabled={busy} onClick={onClose}><Icon name="x" size={18} /></button></header>
        <p className="muted">빈 파일을 만들고 바로 편집합니다. AI 연결 없이 사용할 수 있습니다.</p>
        <label>저장할 프로젝트<select value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
          {projects.map((work) => <option key={work.id} value={work.id}>{work.title}</option>)}<option value="">새 프로젝트 만들기…</option>
        </select></label>
        {!target ? <label>프로젝트 이름<input value={projectName} disabled={busy} onChange={(event) => setProjectName(event.target.value)} /></label> : null}
        <label>문서 종류<select value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as NewDocumentFormat)}>
          {NEW_DOCUMENT_TYPES.map((entry) => <option key={entry.format} value={entry.format}>{entry.label} (.{entry.extension})</option>)}
        </select></label>
        {format === "design" ? <label>캔버스 크기<select value={preset} disabled={busy} onChange={event => setPreset(event.target.value)}>
          <option value="square">정사각 (SNS) · 1080×1080</option><option value="portrait">카드뉴스 · 1080×1350</option>
          <option value="story">세로 (스토리) · 1080×1920</option><option value="wide">가로 (썸네일·화면) · 1920×1080</option><option value="a4">A4 문서 · 794×1123</option>
        </select></label> : null}
        <label>파일 이름<input autoFocus value={name} placeholder={kind.name} disabled={busy} onChange={(event) => setName(event.target.value)} /><small className="muted">.{kind.extension} · 같은 이름이 있으면 새 이름으로 만듭니다.</small></label>
        {target ? <small className="muted new-document-path">{target === workId && workspaceId ? <>{state.workspaces[workspaceId]?.label ?? "현재 작업공간"} · {state.workspaces[workspaceId]?.cwd}</> : state.works[target]?.cwd}</small> : null}
        {error ? <p role="alert">{error}</p> : null}
        <footer><button type="submit" className="button primary" disabled={busy}>{busy ? "만드는 중…" : "만들고 열기"}</button></footer>
      </form>
    </dialog>;
}
