import { useRef, useState } from "react";
import { BLANK_OFFICE_DOCUMENTS, type Artifact, type BlankOfficeFormat } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";

/** Common shell file actions, outside the original editors' independent ribbons. */
export function OfficeFileMenu({ api, workId, workspaceId, sessionId, cwd, sourceKey, pickFile, beforeOpen, onOpenArtifact, onToast }: {
  api: Api;
  workId: string;
  workspaceId?: string;
  sessionId?: string;
  cwd: string;
  sourceKey: string;
  pickFile?: ((folder: string) => Promise<string | null>) | null;
  beforeOpen?: () => Promise<boolean>;
  onOpenArtifact: (id: string) => void;
  onToast: (message: string) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [path, setPath] = useState("");
  const anchor = useRef<HTMLDivElement>(null), pending = useRef(false);
  const context = useRef("");
  context.current = JSON.stringify([sourceKey, workId, workspaceId, sessionId]);
  const run = async (choose: () => Promise<(() => Promise<Artifact>) | null>) => {
    if (pending.current) return;
    const origin = context.current;
    const current = () => {
      const node = anchor.current, pane = node?.closest<HTMLElement>(".pane");
      return context.current === origin && Boolean(node?.isConnected && node.getClientRects().length) && (!pane || pane.dataset.paneActive === "true");
    };
    pending.current = true; setBusy(true); setOpen(false);
    try {
      const action = await choose();
      if (!action || !current()) return;
      if (beforeOpen && !await beforeOpen()) return;
      if (!current()) return;
      const artifact = await action();
      if (current()) onOpenArtifact(artifact.id);
      else onToast(`「${artifact.name}」을 프로젝트 문서에 추가했습니다.`);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  const create = (format: BlankOfficeFormat) => void run(async () => () => api.createOfficeDocument(workId, { format, workspaceId, sessionId }));
  const openPath = (value: string) => void run(async () => () => api.openFile(workId, value, workspaceId, sessionId));
  return <div className="anchor office-file-menu" ref={anchor}>
    <button type="button" className="ghost-button" aria-label="문서 파일 메뉴" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
      <Icon name="file" size={15} /> {busy ? "준비 중…" : "파일"}
    </button>
    <Popover open={open} onClose={() => setOpen(false)} align="left">
      <div className="menu-label">새 문서</div>
      {BLANK_OFFICE_DOCUMENTS.map((kind) => <MenuItem key={kind.format} hint={`.${kind.extension}`} onSelect={() => create(kind.format)}>{kind.label}</MenuItem>)}
      <div className="menu-divider" />
      {pickFile ? <MenuItem onSelect={() => void run(async () => {
        const value = await pickFile(cwd);
        return value ? () => api.openFile(workId, value, workspaceId, sessionId) : null;
      })}>파일 열기…</MenuItem> : <form className="menu-form" onSubmit={(event) => {
        event.preventDefault(); if (path.trim()) { openPath(path.trim()); setPath(""); }
      }}>
        <input aria-label="열 문서 경로" value={path} onChange={(event) => setPath(event.target.value)} placeholder="작업 폴더 기준 파일 경로" />
        <button type="submit" className="ghost-button" disabled={!path.trim()}>열기</button>
      </form>}
    </Popover>
  </div>;
}
