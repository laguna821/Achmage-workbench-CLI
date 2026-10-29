import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Folder, ProjectStage } from "@workbench/contracts";
import { Icon, type IconName } from "../Icon.tsx";

// The navigator's small windows: deleting a folder that is not empty (choose: only the folder, or
// archive it with what is inside), a folder's colour and icon (Notebook Navigator's), and tags for
// projects. Plain panels with a scrim, no blur.

/** Icons a folder can wear (the app's own set). */
export const FOLDER_ICONS: IconName[] = ["folder", "book", "star", "flame", "bulb", "tool", "globe", "calendar", "mail", "image", "palette", "terminal", "clipboard", "list", "run", "project"];

/** "폴더만 지우기" or "보관": what happens to a folder with things inside. */
export function FolderDeleteDialog({
  folder,
  projects,
  folders,
  parentName,
  onDeleteOnly,
  onArchive,
  onClose,
}: {
  folder: Folder;
  projects: number;
  folders: number;
  parentName: string;
  onDeleteOnly: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const inside = [projects ? `프로젝트 ${projects}개` : "", folders ? `하위 폴더 ${folders}개` : ""].filter(Boolean).join("와 ");
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <div className="nav-dialog" role="dialog" aria-label={`${folder.name} 지우기`}>
        <h2>「{folder.name}」 폴더를 지울까요?</h2>
        <p className="muted">안에 {inside}가 있습니다. 무엇도 잃지 않게 둘 중 하나를 고르세요.</p>
        <div className="nav-dialog-choices">
          <button ref={first} type="button" className="nav-choice" onClick={onDeleteOnly}>
            <strong>폴더만 지우기</strong>
            <span className="muted">안의 것은 위 폴더({parentName})로 옮깁니다.</span>
          </button>
          <button type="button" className="nav-choice" onClick={onArchive}>
            <strong>보관</strong>
            <span className="muted">안의 것과 함께 보관함으로 옮깁니다. 보관함에서 되돌릴 수 있습니다.</span>
          </button>
        </div>
        <div className="nav-dialog-foot">
          <button type="button" className="button" onClick={onClose}>
            그만두기
          </button>
        </div>
      </div>
    </div>
  );
}

/** A panel that opens where it was asked (a menu's position) and stays inside the window. */
function Floating({ x, y, onClose, label, children, className }: { x: number; y: number; onClose: () => void; label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPlace({ left: Math.max(6, Math.min(x, window.innerWidth - box.width - 6)), top: Math.max(6, Math.min(y, window.innerHeight - box.height - 6)) });
  }, [x, y]);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`nav-floating ${className ?? ""}`} style={place} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

/** "색·아이콘": the stages' colours and any `#rrggbb`, and a few icons; each choice applies at once. */
export function FolderStylePanel({
  folder,
  stages,
  x,
  y,
  onColor,
  onIcon,
  onClose,
}: {
  folder: Folder;
  stages: ProjectStage[];
  x: number;
  y: number;
  onColor: (color: string | null) => void;
  onIcon: (icon: string | null) => void;
  onClose: () => void;
}) {
  const [hex, setHex] = useState(folder.color ?? "");
  const valid = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.trim());
  const swatches = [...new Set(stages.map((stage) => stage.color.toLowerCase()))];
  return (
    <Floating x={x} y={y} onClose={onClose} label={`${folder.name} 색과 아이콘`} className="folder-style">
      <div className="nav-floating-title">색</div>
      <div className="folder-swatches">
        <button type="button" className={`folder-swatch none${!folder.color ? " on" : ""}`} title="색 없음" aria-label="색 없음" onClick={() => onColor(null)}>
          <Icon name="x" size={12} />
        </button>
        {swatches.map((color) => (
          <button
            key={color}
            type="button"
            className={`folder-swatch${folder.color === color ? " on" : ""}`}
            style={{ "--swatch": color } as CSSProperties}
            title={stages.find((stage) => stage.color.toLowerCase() === color)?.name ?? color}
            aria-label={`색 ${color}`}
            onClick={() => onColor(color)}
          />
        ))}
      </div>
      <form
        className="folder-hex"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onColor(hex.trim().toLowerCase());
        }}
      >
        <input value={hex} placeholder="#rrggbb" aria-label="색 직접 적기" spellCheck={false} onChange={(event) => setHex(event.target.value)} />
        <button type="submit" className="button small" disabled={!valid}>
          적용
        </button>
      </form>
      <div className="nav-floating-title">아이콘</div>
      <div className="folder-icons">
        {FOLDER_ICONS.map((name) => (
          <button
            key={name}
            type="button"
            className={`icon-button small${(folder.icon ?? "folder") === name ? " pressed" : ""}`}
            title={name === "folder" ? "기본 폴더" : name}
            aria-label={name === "folder" ? "기본 아이콘" : `아이콘 ${name}`}
            onClick={() => onIcon(name === "folder" ? null : name)}
          >
            <Icon name={name} size={16} />
          </button>
        ))}
      </div>
    </Floating>
  );
}

/** "태그 더하기…": tags typed (commas or spaces between), offered from the tags in use. */
export function TagPrompt({ x, y, count, known, onAdd, onClose }: { x: number; y: number; count: number; known: string[]; onAdd: (tags: string[]) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const tags = [...new Set(text.split(/[,\s]+/).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean))];
  return (
    <Floating x={x} y={y} onClose={onClose} label="태그 더하기" className="tag-prompt">
      <div className="nav-floating-title">{count > 1 ? `프로젝트 ${count}개에 태그 더하기` : "태그 더하기"}</div>
      <form
        className="folder-hex"
        onSubmit={(event) => {
          event.preventDefault();
          if (tags.length) onAdd(tags);
        }}
      >
        <input ref={input} value={text} list="nav-known-tags" placeholder="강의, 2026-2" aria-label="더할 태그" onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="button small" disabled={!tags.length}>
          더하기
        </button>
        <datalist id="nav-known-tags">
          {known.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      </form>
    </Floating>
  );
}
