import { useState } from "react";
import type { Work } from "@workbench/contracts";

export function ProjectDeleteDialog({ work, sessions, onDelete, onClose }: { work: Work; sessions: number; onDelete(): Promise<void>; onClose(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <div className="modal-backdrop" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()} onKeyDown={event => !busy && event.key === "Escape" && onClose()}>
    <div className="nav-dialog" role="dialog" aria-modal="true" aria-label="프로젝트 삭제">
      <h2>「{work.title}」 프로젝트를 삭제할까요?</h2>
      <p>이 앱의 프로젝트와 대화 {sessions}개를 삭제합니다. 삭제한 대화 기록은 되돌릴 수 없습니다.</p>
      <p>문서 파일과 작업 폴더는 그대로 보존합니다.</p>
      <p className="muted" style={{ overflowWrap: "anywhere" }}>{work.cwd}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="nav-dialog-foot">
        <button type="button" className="button" disabled={busy} onClick={onClose} autoFocus>취소</button>
        <button type="button" className="button danger" disabled={busy} onClick={() => {
          setBusy(true); setError("");
          void onDelete().then(onClose, reason => { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); });
        }}>{busy ? "삭제 중…" : "프로젝트 삭제"}</button>
      </div>
    </div>
  </div>;
}
