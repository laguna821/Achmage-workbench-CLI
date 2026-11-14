import { useRef, useState, type RefObject } from "react";
import { failure, type Notify } from "../top-notice.ts";
import { BLANK_OFFICE_DOCUMENTS, type Artifact, type BlankOfficeFormat } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";

export type OfficeFileTarget = {
  api: Api;
  workId: string;
  workspaceId?: string;
  sessionId?: string;
  cwd: string;
  sourceKey: string;
  pickFile?: ((folder: string) => Promise<string | null>) | null;
  beforeOpen?: () => Promise<boolean>;
  onOpenArtifact: (id: string) => void;
  onToast: Notify;
};

/**
 * New blank documents and "파일 열기" for a work. A result opens only if the menu's place
 * (`anchor`) is still the one on screen; otherwise it is added to the project quietly.
 */
export function useOfficeFiles({ api, workId, workspaceId, sessionId, cwd, sourceKey, pickFile, beforeOpen, onOpenArtifact, onToast }: OfficeFileTarget, anchor: RefObject<HTMLElement | null>, onStart?: () => void) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const context = useRef("");
  context.current = JSON.stringify([sourceKey, workId, workspaceId, sessionId]);
  const run = async (choose: () => Promise<(() => Promise<Artifact>) | null>) => {
    if (pending.current) return;
    const origin = context.current;
    const current = () => {
      const node = anchor.current, pane = node?.closest<HTMLElement>(".pane");
      return context.current === origin && Boolean(node?.isConnected && node.getClientRects().length) && (!pane || pane.dataset.paneActive === "true");
    };
    pending.current = true; setBusy(true); onStart?.();
    try {
      const action = await choose();
      if (!action || !current()) return;
      if (beforeOpen && !await beforeOpen()) return;
      if (!current()) return;
      const artifact = await action();
      if (current()) onOpenArtifact(artifact.id);
      else onToast(`「${artifact.name}」을 프로젝트 문서에 추가했습니다.`);
    } catch (error) { onToast(failure(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  return {
    busy,
    canPick: Boolean(pickFile),
    create: (format: BlankOfficeFormat) => void run(async () => () => api.createOfficeDocument(workId, { format, workspaceId, sessionId })),
    openPath: (value: string) => void run(async () => () => api.openFile(workId, value, workspaceId, sessionId)),
    pick: () => void run(async () => {
      const value = pickFile ? await pickFile(cwd) : null;
      return value ? () => api.openFile(workId, value, workspaceId, sessionId) : null;
    }),
  };
}

/** Common shell file actions, outside the original editors' independent ribbons. */
export function OfficeFileMenu({ onExportPdf, onExportDocx, onExportOdt, onExportHtml, onExportImages, onOpenWord, ...target }: OfficeFileTarget & {
  onExportPdf?: () => void;
  onExportDocx?: () => void;
  onExportOdt?: () => void;
  onExportHtml?: () => void;
  onExportImages?: () => void;
  onOpenWord?: () => void;
}) {
  const [open, setOpen] = useState(false), [path, setPath] = useState("");
  const anchor = useRef<HTMLDivElement>(null);
  const files = useOfficeFiles(target, anchor, () => setOpen(false));
  const { busy, create, openPath } = files;
  const pickFile = target.pickFile;
  return <div className="anchor office-file-menu" ref={anchor}>
    <button type="button" className="ghost-button" aria-label="문서 파일 메뉴" aria-haspopup={pickFile ? "menu" : "dialog"} aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
      <Icon name="file" size={15} /> {busy ? "준비 중…" : "파일"}
    </button>
    <Popover open={open} onClose={() => setOpen(false)} align="left">
      {onExportPdf ? <MenuItem onSelect={() => { setOpen(false); onExportPdf(); }}>PDF로 내보내기</MenuItem> : null}
      {onExportDocx ? <MenuItem onSelect={() => { setOpen(false); onExportDocx(); }}>Word로 내보내기</MenuItem> : null}
      {onExportOdt ? <MenuItem onSelect={() => { setOpen(false); onExportOdt(); }}>ODT로 내보내기</MenuItem> : null}
      {onExportHtml ? <MenuItem onSelect={() => { setOpen(false); onExportHtml(); }}>HTML로 내보내기</MenuItem> : null}
      {onExportImages ? <MenuItem onSelect={() => { setOpen(false); onExportImages(); }}>PNG 그림으로 내보내기</MenuItem> : null}
      {onOpenWord ? <MenuItem onSelect={() => { setOpen(false); onOpenWord(); }}>Word로 변환해 열기</MenuItem> : null}
      {onExportPdf || onExportDocx || onExportOdt || onExportHtml || onExportImages ? <div className="menu-sep" /> : null}
      <div className="menu-label">새 문서</div>
      {BLANK_OFFICE_DOCUMENTS.map((kind) => <MenuItem key={kind.format} hint={`.${kind.extension}`} onSelect={() => create(kind.format)}>{kind.label}</MenuItem>)}
      <div className="menu-divider" />
      {pickFile ? <MenuItem onSelect={files.pick}>파일 열기…</MenuItem> : <form className="menu-form" onSubmit={(event) => {
        event.preventDefault(); if (path.trim()) { openPath(path.trim()); setPath(""); }
      }}>
        <input aria-label="열 문서 경로" value={path} onChange={(event) => setPath(event.target.value)} placeholder="작업 폴더 기준 파일 경로" />
        <button type="submit" className="ghost-button" disabled={!path.trim()}>열기</button>
      </form>}
    </Popover>
  </div>;
}
