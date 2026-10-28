import { Fragment, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { BorderStyle, VaultFolder } from "@workbench/contracts";
import { countLabel, groupRuns, obsidianUrl, openObsidian } from "../../pkm.ts";
import { Icon, iconName } from "../Icon.tsx";
import type { MenuEntry, MenuRequest } from "../ContextMenu.tsx";
import { usePkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

// "볼트" in the sidebar: the attached Obsidian vault as a read-only mirror. Folders wear the colours
// and icons the user gave them in Notebook Navigator; blocks of grouped folders get one border, as
// the user's border add-on draws them; counts read "현재 · 하위". Nothing here writes to the vault.

type Theme = "light" | "dark";

/** CSS variables for a gradient border in one theme (a plain border when there is no end colour). */
function borderVars(style: BorderStyle, theme: Theme): CSSProperties {
  const start = style.start[theme] ?? style.start.light ?? "transparent";
  const end = style.end[theme] ?? start;
  return { "--vb-start": start, "--vb-end": end, ...(style.radius !== null ? { "--vb-radius": `${style.radius}px` } : {}) } as CSSProperties;
}

export function VaultSection({ theme, openMenu }: { theme: Theme; openMenu: (request: MenuRequest) => void }) {
  const pkm = usePkm();
  // A folder picked shows its notes as cards in the centre; where the app cannot, it only folds.
  const show = pkm.open;
  const onOpenFolder = show ? (path: string) => show({ kind: "vault", path }) : undefined;
  const onOpenNote = show ? (path: string) => show({ kind: "note", path }) : undefined;
  const selected = pkm.target?.kind === "vault" || pkm.target?.kind === "note" ? pkm.target.path : null;
  const tree = pkm.tree;
  const [pinsOpen, setPinsOpen] = useState(false);
  if (!tree) return null;
  const status = tree.status;
  const root = tree.root;
  const vaultPath = status.path;

  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => pkm.onToast("경로를 복사했습니다."));
  const sectionMenu = (x: number, y: number) => {
    const items: MenuEntry[] = vaultPath
      ? [
          { kind: "item", label: "Obsidian에서 열기", icon: "external", onSelect: () => void openObsidian(obsidianUrl(vaultPath)).catch(() => undefined) },
          { kind: "item", label: "다시 읽기", icon: "refresh", onSelect: pkm.rescan },
          { kind: "item", label: "볼트 바꾸기…", icon: "folderOpen", onSelect: () => pkm.setDialog({ kind: "vault" }) },
          { kind: "item", label: "볼트 경로 복사", icon: "copy", onSelect: () => copy(vaultPath) },
          { kind: "separator" },
          { kind: "item", label: "연결 끊기", icon: "x", onSelect: pkm.detach },
        ]
      : [{ kind: "item", label: "볼트 연결…", icon: "folderOpen", onSelect: () => pkm.setDialog({ kind: "vault" }) }];
    openMenu({ x, y, title: status.name ?? "볼트", items });
  };

  const folderMenu = (folder: VaultFolder, x: number, y: number) => {
    if (!vaultPath) return;
    const items: MenuEntry[] = [
      ...(onOpenFolder ? [{ kind: "item" as const, label: "카드로 보기", icon: "grid" as const, onSelect: () => onOpenFolder(folder.path) }] : []),
      { kind: "item", label: "Obsidian에서 열기", icon: "external", onSelect: () => void openObsidian(obsidianUrl(vaultPath, folder.path)).catch(() => undefined) },
      { kind: "item", label: "경로 복사", icon: "copy", onSelect: () => copy(folder.path ? `${vaultPath}/${folder.path}` : vaultPath) },
    ];
    openMenu({ x, y, title: folder.name, items });
  };

  const head = (
    <div className="side-section-title with-tools">
      <span>볼트</span>
      {status.name ? <span className="vault-name">{status.name}</span> : null}
      <span className="side-tools">
        {status.path ? (
          <span className="vault-readonly" title="볼트는 읽기만 합니다. Workbench는 볼트에 쓰지 않습니다.">
            읽기 전용
          </span>
        ) : null}
        <button type="button" className="icon-button small" title="볼트 메뉴" aria-haspopup="menu" onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          sectionMenu(box.left, box.bottom + 4);
        }}>
          <Icon name="dots" size={13} />
        </button>
      </span>
    </div>
  );

  if (!vaultPath) {
    return (
      <section className="side-section vault-section" aria-label="볼트">
        {head}
        <button type="button" className="side-row vault-connect" onClick={() => pkm.setDialog({ kind: "vault" })} title="옵시디언 볼트를 읽기 전용으로 붙입니다">
          <Icon name="book" size={15} className="side-row-icon" />
          <span className="side-row-label">옵시디언 볼트 연결{status.suggested ? ` · ${status.suggested.split("/").pop()}` : ""}</span>
        </button>
      </section>
    );
  }

  if (status.problem || !root) {
    return (
      <section className="side-section vault-section" aria-label="볼트">
        {head}
        <div className="vault-problem">{status.problem ?? "볼트를 읽는 중…"}</div>
      </section>
    );
  }

  const borders = tree.borders;
  const activate = (folder: VaultFolder) => {
    if (onOpenFolder) onOpenFolder(folder.path);
    else if (folder.children.length) pkm.toggle(folder.path);
  };

  // Rows move focus with the arrow keys (in document order), fold with ←/→ and open with Enter.
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>, folder: VaultFolder) => {
    const rows = [...(event.currentTarget.closest(".vault-tree")?.querySelectorAll<HTMLElement>(".vault-row") ?? [])];
    const index = rows.indexOf(event.currentTarget);
    const isOpen = pkm.unfolded.has(folder.path);
    if (event.key === "ArrowDown") rows[index + 1]?.focus();
    else if (event.key === "ArrowUp") rows[index - 1]?.focus();
    else if (event.key === "ArrowRight" && folder.children.length && !isOpen) pkm.toggle(folder.path);
    else if (event.key === "ArrowLeft" && isOpen) pkm.toggle(folder.path);
    else if (event.key === "Enter") activate(folder);
    else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      const box = event.currentTarget.getBoundingClientRect();
      folderMenu(folder, box.left + 24, box.bottom - 4);
    } else return;
    event.preventDefault();
  };

  const row = (folder: VaultFolder, depth: number, isRoot = false) => {
    const isOpen = !isRoot && pkm.unfolded.has(folder.path);
    const expandable = !isRoot && folder.children.length > 0;
    const color = folder.color[theme];
    const background = folder.background[theme];
    const icon = isRoot ? "book" : (iconName(folder.icon) ?? (isOpen ? "folderOpen" : "folder"));
    return (
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={expandable ? isOpen : undefined}
        aria-selected={selected === folder.path}
        tabIndex={isRoot ? 0 : -1}
        className={`side-row vault-row${isRoot ? " vault-root" : ""}${selected === folder.path ? " current" : ""}${color ? " colored" : ""}`}
        style={{ paddingLeft: 8 + depth * 14, ...(background ? { background: `color-mix(in srgb, ${background} 22%, transparent)` } : {}) }}
        data-vault-path={folder.path}
        title={`${folder.path || folder.name} · 이 폴더 ${folder.own}개${folder.below ? ` · 하위 ${folder.below}개` : ""}`}
        onClick={() => activate(folder)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          folderMenu(folder, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => onKey(event, folder)}
      >
        <span
          className={`row-chevron${expandable ? "" : " blank"}`}
          onClick={(event) => {
            if (!expandable) return;
            event.stopPropagation();
            pkm.toggle(folder.path);
          }}
          aria-hidden
        >
          {expandable ? <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={13} /> : null}
        </span>
        <span className="side-row-icon vault-icon" style={color ? { color } : undefined}>
          <Icon name={icon} size={15} />
        </span>
        <span className="side-row-label" style={color ? { color } : undefined}>
          {folder.name}
        </span>
        {folder.pinned ? <Icon name="pin" size={11} className="vault-pin" /> : null}
        <span className="side-row-trail muted vault-count">{countLabel(folder)}</span>
      </div>
    );
  };

  /** A folder and, when unfolded, its children; its own border unless an outer one already draws it. */
  const block = (folder: VaultFolder, depth: number, insideBorder: boolean): ReactNode => {
    const style = borders?.showFolders ? borders.folders[folder.path] : undefined;
    const bordered = Boolean(style) && !(borders?.suppressNested && insideBorder);
    const content = (
      <>
        {row(folder, depth)}
        {pkm.unfolded.has(folder.path) ? folder.children.map((child) => <Fragment key={child.path}>{block(child, depth + 1, insideBorder || bordered)}</Fragment>) : null}
      </>
    );
    return bordered && style ? (
      <div className="vault-border" style={borderVars(style, theme)}>
        {content}
      </div>
    ) : (
      content
    );
  };

  const rootStyle = borders?.showFolders ? borders.folders["/"] : undefined;
  const runs = groupRuns(
    root.children.map((folder) => ({ folder })),
    borders?.showGroups ? borders.groups : [],
  );
  const body = (
    <>
      {row(root, 0, true)}
      {runs.map((run, index) => {
        const group = run.groupId ? borders?.groups.find((entry) => entry.id === run.groupId) : undefined;
        const blocks = run.blocks.map(({ folder }) => <Fragment key={folder.path}>{block(folder, 0, Boolean(rootStyle))}</Fragment>);
        return group ? (
          <div key={`${run.groupId}:${index}`} className="vault-border vault-group" style={borderVars(group.style, theme)} title={group.name}>
            {blocks}
          </div>
        ) : (
          <Fragment key={`loose:${index}`}>{blocks}</Fragment>
        );
      })}
    </>
  );

  const pins = [...tree.shortcuts.filter((entry) => entry.kind === "note"), ...tree.pinned.filter((pin) => !tree.shortcuts.some((entry) => entry.path === pin.path))];
  return (
    <section className="side-section vault-section" aria-label="볼트">
      {head}
      {pins.length ? (
        <>
          <button type="button" className="side-row vault-pins" onClick={() => setPinsOpen(!pinsOpen)} aria-expanded={pinsOpen} title="Notebook Navigator의 고정 노트와 바로가기">
            <span className="row-chevron">
              <Icon name={pinsOpen ? "chevronDown" : "chevronRight"} size={13} />
            </span>
            <Icon name="pin" size={14} className="side-row-icon" />
            <span className="side-row-label">고정 노트</span>
            <span className="side-row-trail muted">{pins.length}</span>
          </button>
          {pinsOpen
            ? pins.map((pin) => (
                <button
                  key={pin.path}
                  type="button"
                  className={`side-row vault-note${selected === pin.path ? " current" : ""}`}
                  style={{ paddingLeft: 30 }}
                  title={pin.path}
                  onClick={() => onOpenNote?.(pin.path)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu({
                      x: event.clientX,
                      y: event.clientY,
                      title: pin.title,
                      items: [
                        ...(onOpenNote ? [{ kind: "item" as const, label: "열기", icon: "page" as const, onSelect: () => onOpenNote(pin.path) }] : []),
                        { kind: "item", label: "Obsidian에서 열기", icon: "external", onSelect: () => void openObsidian(obsidianUrl(vaultPath, pin.path)).catch(() => undefined) },
                      ],
                    });
                  }}
                >
                  <Icon name="page" size={14} className="side-row-icon" />
                  <span className="side-row-label">{pin.title}</span>
                </button>
              ))
            : null}
        </>
      ) : null}
      <div className="vault-tree" role="tree" aria-label="볼트 폴더">
        {rootStyle ? (
          <div className="vault-border" style={borderVars(rootStyle, theme)}>
            {body}
          </div>
        ) : (
          body
        )}
      </div>
    </section>
  );
}
