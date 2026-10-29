import { useCallback, useEffect, useState } from "react";
import type { Session, WorktreeChanges, WorktreeFile } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import "../styles/worktrees.css";

const STATUS_LABEL: Record<WorktreeFile["status"], string> = { added: "추가", modified: "수정", deleted: "삭제", renamed: "이름 바꿈" };

/** A diff line's look: added, removed, a hunk or file header, or context. */
const lineKind = (line: string) =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
    ? "head"
    : line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : "ctx";

/**
 * "변경 검토" of a session working in a git worktree: the files it changed against where it
 * started and the diff, then "원래 폴더에 적용" (the original checkout's files change; the copy
 * stays) or "버리기" (the copy and its branch go, the session is archived).
 */
export function WorktreeReview({ api, session, onClose, onToast, onError }: { api: Api; session: Session; onClose: () => void; onToast: (text: string) => void; onError: (error: unknown) => void }) {
  const [changes, setChanges] = useState<WorktreeChanges | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.worktreeChanges(session.id).then(setChanges).catch(onError);
  }, [api, session.id, onError]);
  useEffect(load, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const act = async (what: "apply" | "discard") => {
    setBusy(true);
    try {
      if (what === "apply") {
        await api.applyWorktree(session.id);
        onToast("격리 사본의 변경을 원래 폴더에 적용했습니다.");
        load();
      } else {
        await api.discardWorktree(session.id);
        onToast("격리 사본을 버렸습니다. 세션은 보관함에 있습니다.");
        onClose();
      }
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const worktree = session.worktree!;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="worktree-review" role="dialog" aria-label="변경 검토">
        <header className="worktree-head">
          <h2>변경 검토</h2>
          <p className="muted">
            격리 사본 <code>{worktree.branch}</code>에서 바뀐 것입니다. 시작할 때의 커밋 <code>{worktree.base.slice(0, 8)}</code>과 비교합니다. 원래 폴더 <code>{worktree.root}</code>는 적용하기 전까지 그대로입니다.
          </p>
        </header>
        {changes === null ? <div className="worktree-empty">불러오는 중…</div> : null}
        {changes && !changes.files.length ? <div className="worktree-empty">아직 바뀐 파일이 없습니다.</div> : null}
        {changes?.files.length ? (
          <>
            <ul className="worktree-files">
              {changes.files.map((file) => (
                <li key={file.path}>
                  <span className={`worktree-status ${file.status}`}>{STATUS_LABEL[file.status]}</span>
                  <span className="worktree-path">{file.path}</span>
                </li>
              ))}
            </ul>
            <pre className="worktree-diff">
              {changes.diff.split("\n").map((line, index) => (
                <span key={index} className={`diff-${lineKind(line)}`}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          </>
        ) : null}
        <footer className="worktree-foot">
          <button type="button" className="button danger" onClick={() => void act("discard")} disabled={busy} title="격리 사본의 파일을 버리고 세션을 보관합니다. 미병합 커밋은 브랜치에 남습니다.">
            <Icon name="x" size={14} /> 버리기
          </button>
          <span className="worktree-spacer" />
          <button type="button" className="button" onClick={onClose}>
            닫기
          </button>
          <button type="button" className="button primary" onClick={() => void act("apply")} disabled={busy || !changes?.files.length} title="원래 폴더의 파일에 이 변경을 그대로 적용합니다(커밋은 하지 않음)">
            원래 폴더에 적용
          </button>
        </footer>
      </div>
    </div>
  );
}
