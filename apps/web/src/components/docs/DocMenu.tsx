import { useRef, useState } from "react";
import { BLANK_OFFICE_DOCUMENTS, type ArtifactRevision, type Provider } from "@workbench/contracts";
import { EngineMark } from "../EngineMark.tsx";
import { ago } from "../../format.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { useOfficeFiles, type OfficeFileTarget } from "../OfficeFileMenu.tsx";
import { AnchoredLayer } from "../ui/AnchoredLayer.tsx";
import { ListLayer, MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "../ui/Menu.tsx";
import { revisionWord } from "./doc-notices.ts";

export type DocMenuAction = { key: string; label: string; icon: IconName; shortcut?: string; onSelect: () => void; disabled?: boolean; reason?: string };
export type DocView = { value: string; label: string };

type View = "main" | "history" | "new" | "export";

/**
 * The document head's ⋯: everything the head held besides its title, save state, 문서 AI and the
 * view switch — each with its name and shortcut. Drill-ins: 판 기록 (revisions), 내보내기 and 새 문서.
 */
export function DocMenu({ readers = [], views, view, onView, actions, exports, revision, loadHistory, historyLabel, onRevision, files }: {
  /** Conversations that read the current revision (provenance, said here rather than as a standing line). */
  readers?: Array<{ id: string; provider: Provider; name: string }>;
  /** The kind's views (also on the head's switch; here as well so a narrow head can fold it). */
  views: DocView[];
  view: string;
  onView: (value: string) => void;
  actions: DocMenuAction[];
  exports: Array<{ key: string; label: string; onSelect: () => void }>;
  revision: number;
  loadHistory: () => Promise<ArtifactRevision[]>;
  historyLabel: (entry: ArtifactRevision) => string;
  onRevision: (entry: ArtifactRevision) => void;
  files: OfficeFileTarget;
}) {
  const [open, setOpen] = useState(false);
  const [menuView, setMenuView] = useState<View>("main");
  const [history, setHistory] = useState<ArtifactRevision[] | null>(null);
  const [pathOpen, setPathOpen] = useState(false);
  const [path, setPath] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const office = useOfficeFiles(files, anchor, () => setOpen(false));
  const close = () => { setOpen(false); setMenuView("main"); };
  const back = <MenuItem icon="arrowLeft" keepOpen onSelect={() => setMenuView("main")}>뒤로</MenuItem>;
  const showHistory = () => {
    setMenuView("history");
    setHistory(null);
    void loadHistory().then(setHistory).catch(() => setHistory([]));
  };
  return (
    <>
      <button ref={anchor} type="button" className="icon-button small doc-more" aria-label="문서 메뉴" title="보기, 판 기록, 내보내기와 파일" aria-haspopup="menu" aria-expanded={open}
        aria-busy={office.busy || undefined}
        onClick={() => { setMenuView("main"); setOpen(!open); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault(); setMenuView("main"); setOpen(true);
        }}>
        <Icon name="dots" size={16} />
      </button>
      <ListLayer role="menu" open={open} anchor={anchor} onClose={close} label="문서 메뉴" className="doc-menu" align="end" resetKey={menuView}>
        {menuView === "main" ? (
          <>
            {views.length > 1 ? (
              <MenuGroup label="보기">
                {views.map((entry) => (
                  <MenuItem key={entry.value} type="radio" checked={entry.value === view} value={entry.value} onSelect={() => onView(entry.value)}>{entry.label}</MenuItem>
                ))}
              </MenuGroup>
            ) : null}
            {views.length > 1 ? <MenuSeparator /> : null}
            {actions.map((action) => (
              <MenuItem key={action.key} icon={action.icon} shortcut={action.shortcut} disabled={action.disabled} disabledReason={action.reason} value={action.key} onSelect={action.onSelect}>{action.label}</MenuItem>
            ))}
            <MenuItem icon="clock" more keepOpen hint={revisionWord(revision)} value="history" onSelect={showHistory}>판 기록</MenuItem>
            {readers.length ? (
              <MenuGroup label={`이 판을 읽은 대화 ${readers.length}`}>
                {readers.map((reader) => <div key={reader.id} className="ui-menu-heading doc-menu-reader reader-chip current" role="presentation"><EngineMark provider={reader.provider} size={14} /><span>{reader.name}</span></div>)}
              </MenuGroup>
            ) : null}
            <MenuSeparator />
            {exports.length ? <MenuItem icon="download" more keepOpen value="export" onSelect={() => setMenuView("export")}>내보내기</MenuItem> : null}
            <MenuItem icon="plus" more keepOpen value="new" onSelect={() => setMenuView("new")}>새 문서</MenuItem>
            <MenuItem icon="folderOpen" disabled={office.busy} value="open" onSelect={() => (office.canPick ? office.pick() : setPathOpen(true))}>{office.busy ? "준비 중…" : "파일 열기…"}</MenuItem>
          </>
        ) : menuView === "export" ? (
          <>
            {back}
            <MenuSeparator />
            {exports.map((entry) => <MenuItem key={entry.key} value={entry.key} onSelect={entry.onSelect}>{entry.label}</MenuItem>)}
          </>
        ) : menuView === "history" ? (
          <>
            {back}
            <MenuSeparator />
            <MenuLabel>되돌리기도 새 판으로 남습니다</MenuLabel>
            {history === null ? <MenuLabel>판 기록을 읽는 중</MenuLabel> : null}
            {[...(history ?? [])].reverse().map((entry) => (
              <MenuItem key={entry.revision} type="radio" checked={entry.revision === revision} hint={ago(entry.at)} value={`r${entry.revision}`} onSelect={() => onRevision(entry)}>
                {historyLabel(entry)}
              </MenuItem>
            ))}
          </>
        ) : (
          <>
            {back}
            <MenuSeparator />
            {BLANK_OFFICE_DOCUMENTS.map((kind) => <MenuItem key={kind.format} hint={`.${kind.extension}`} onSelect={() => office.create(kind.format)}>{kind.label}</MenuItem>)}
          </>
        )}
      </ListLayer>
      <AnchoredLayer open={pathOpen} onClose={() => setPathOpen(false)} anchor={anchor} align="end" label="파일 열기" className="note-path-layer">
        <form className="note-path-form" onSubmit={(event) => {
          event.preventDefault();
          if (!path.trim()) return;
          office.openPath(path.trim());
          setPath("");
          setPathOpen(false);
        }}>
          <input aria-label="열 문서 경로" value={path} onChange={(event) => setPath(event.target.value)} placeholder="작업 폴더 기준 파일 경로" />
          <button type="submit" className="button small" disabled={!path.trim()}>열기</button>
        </form>
      </AnchoredLayer>
    </>
  );
}
