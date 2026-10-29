import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectPick, Work } from "@workbench/contracts";
import { projectChoices } from "../entry.ts";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";
import "../styles/entry.css";

const lastPart = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** The menu's full height (filter, "새 프로젝트", a label, about eight rows). */
const MENU_HEIGHT = 430;

/**
 * Where the menu fits: home keeps the input centred or near the top, so below unless above has
 * clearly more room; the list shrinks to what is left (it scrolls).
 */
function placeMenu(anchor: HTMLElement | null): { placement: "above" | "below"; list: number } {
  const box = anchor?.getBoundingClientRect();
  if (!box) return { placement: "below", list: 340 };
  const above = box.top - 12;
  const below = window.innerHeight - box.bottom - 12;
  const placement = below >= MENU_HEIGHT || below >= above ? "below" : "above";
  return { placement, list: Math.max(120, Math.min(340, (placement === "below" ? below : above) - 90)) };
}

/** What the chip says: a new project, or a new session in an existing one. */
export const projectLabel = (target: Work | null) => (target ? `→ ${target.title}에 새 세션` : "새 프로젝트");

/**
 * `[프로젝트 ▾]` beside the folder chip on home: where the request goes. The folder's live work is
 * the default ("같은 폴더 = 같은 프로젝트"); "새 프로젝트" or any recent project can be picked here,
 * found by name, classification or folder.
 */
export function ProjectChoice({
  state,
  target,
  folderWork,
  hasFolder,
  onChange,
}: {
  state: State;
  /** Where the request goes now (null: a new project). */
  target: Work | null;
  /** The live work of the chosen folder, if any. */
  folderWork: Work | null;
  hasFolder: boolean;
  onChange: (pick: ProjectPick) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(() => placeMenu(null));
  const close = useCallback(() => setOpen(false), []);
  const works = useMemo(() => (open ? projectChoices(state, query, query.trim() ? 30 : 12) : []), [open, state, query]);
  // Row 0 is "새 프로젝트", then the works.
  const rows = works.length + 1;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    window.requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  // Typing a name points at the first match (Enter takes it); otherwise at the current choice.
  const chosenRow = target ? works.findIndex((work) => work.id === target.id) + 1 : 0;
  useEffect(() => setCursor(query.trim() ? 1 : chosenRow), [query, open]);
  useEffect(() => {
    document.querySelector<HTMLElement>(`.project-menu [data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (index: number) => {
    const work = works[Math.min(index, rows - 1) - 1];
    onChange(work ? { kind: "work", workId: work.id } : { kind: "new" });
    close();
  };

  return (
    <div className="anchor" ref={anchor}>
      <button
        type="button"
        className={`select-button project-button${target ? " existing" : ""}`}
        onClick={() => {
          if (!open) setRoom(placeMenu(anchor.current));
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title={target ? `${target.title} · ${target.cwd}` : hasFolder ? "고른 폴더에 새 프로젝트를 만듭니다" : "앱이 새 프로젝트 폴더를 만듭니다"}
      >
        <Icon name="project" size={14} />
        <span className="project-button-label">{projectLabel(target)}</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      <Popover open={open} onClose={close} placement={room.placement} align="right" className="project-menu">
        <label className="project-filter">
          <Icon name="search" size={14} />
          <input
            ref={input}
            value={query}
            placeholder="프로젝트 찾기"
            aria-label="프로젝트 찾기"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setCursor((at) => (Math.min(at, rows - 1) + step + rows) % rows);
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(cursor);
              }
            }}
          />
        </label>
        <div className="project-list" style={{ maxHeight: room.list }}>
          <button type="button" role="menuitem" data-row={0} className={`menu-item${!target ? " active" : ""}${Math.min(cursor, rows - 1) === 0 ? " keyed" : ""}`} onClick={() => choose(0)}>
            <span className="menu-item-label">
              <Icon name="plus" size={14} /> 새 프로젝트
            </span>
            <span className="menu-item-hint">{hasFolder ? "고른 폴더에" : "새 폴더"}</span>
          </button>
          <div className="menu-label">{query.trim() ? `찾은 프로젝트 ${works.length}` : "최근 프로젝트"}</div>
          {works.map((work, index) => (
            <button
              key={work.id}
              type="button"
              role="menuitem"
              data-row={index + 1}
              className={`menu-item${target?.id === work.id ? " active" : ""}${cursor === index + 1 ? " keyed" : ""}`}
              onClick={() => choose(index + 1)}
              title={work.cwd}
            >
              <span className="menu-item-label">{work.title}</span>
              <span className="menu-item-hint">{work.id === folderWork?.id ? "고른 폴더" : work.cwdManaged ? "" : lastPart(work.cwd)}</span>
            </button>
          ))}
          {!works.length ? <div className="project-empty">{query.trim() ? "맞는 프로젝트가 없습니다." : "아직 프로젝트가 없습니다."}</div> : null}
        </div>
      </Popover>
    </div>
  );
}
