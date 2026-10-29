import { useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { HomeView } from "@workbench/contracts";
import { colorOf, foldKey, type Board, type Group, type NestedGroup } from "../../groups.ts";
import { GroupHead, groupStyle, lookProps, toggleFold, type Paint } from "./parts.tsx";

// The two shapes every grouped layout takes: sections (a heading per group, groups inside groups
// under it; the body is the layout's own — cards, rows, tiles) and a board (a column per group, a
// row per subgroup). Both draw the view's look (Bases Look): the group's colour as a border (a
// band on top of board columns), a light tint, an emphasized heading; a heading folds its group.

type Shared = {
  view: HomeView;
  onView: (view: HomeView) => void;
  paint: Paint;
};

/**
 * Groups as sections. Without a group key, `groups` holds one group and no heading is drawn.
 * `body` draws a group's items (a sub-group's too).
 */
export function GroupSections<T>({
  view,
  onView,
  paint,
  ruleKey,
  subKey,
  groups,
  sectionClass = "",
  headClass = "section-label",
  className = "",
  body,
  heading = true,
}: Shared & {
  ruleKey: string;
  subKey?: string;
  groups: NestedGroup<T>[];
  sectionClass?: string;
  headClass?: string;
  className?: string;
  body: (items: T[], group: Group<T>, path: string) => ReactNode;
  /** False: one group without a heading (an ungrouped view). */
  heading?: boolean;
}) {
  const look = lookProps(view.look);
  if (!heading) return <div className={`group-sections ungrouped ${className}`}>{groups.map((group) => body(group.items, group, ""))}</div>;
  return (
    <div className={`group-sections ${look.className} ${className}`} style={look.style}>
      {groups.map((group) => {
        const color = colorOf(view.look, ruleKey, group);
        const fold = foldKey(ruleKey, group.id);
        const folded = view.collapsed.includes(fold);
        return (
          <section key={group.id || "none"} className={`group-section ${sectionClass}${color ? " has-color" : ""}${folded ? " folded" : ""}`} style={groupStyle(color)} data-group={group.id} aria-label={group.label}>
            <GroupHead
              className={headClass}
              label={group.label}
              count={group.items.length}
              color={color}
              folded={folded}
              onToggle={() => onView(toggleFold(view, fold))}
              onPaint={(x, y) => paint(ruleKey, group, x, y)}
            />
            {folded ? null : group.sub && subKey ? (
              <div className="group-subs">
                {group.sub.map((sub) => {
                  const subColor = colorOf(view.look, subKey, sub);
                  const subFold = foldKey(subKey, sub.id, fold);
                  const subFolded = view.collapsed.includes(subFold);
                  return (
                    <section key={sub.id || "none"} className={`group-section sub${subColor ? " has-color" : ""}${subFolded ? " folded" : ""}`} style={groupStyle(subColor)} data-group={sub.id} aria-label={`${group.label} › ${sub.label}`}>
                      <GroupHead
                        as="h3"
                        className={headClass}
                        label={sub.label}
                        count={sub.items.length}
                        color={subColor}
                        folded={subFolded}
                        onToggle={() => onView(toggleFold(view, subFold))}
                        onPaint={(x, y) => paint(subKey, sub, x, y)}
                      />
                      {subFolded ? null : body(sub.items, sub, subFold)}
                    </section>
                  );
                })}
              </div>
            ) : (
              body(group.items, group, fold)
            )}
          </section>
        );
      })}
    </div>
  );
}

export type Cell = { col: string; lane: string | null };

type Drag<T> = { item: T; from: Cell; x0: number; y0: number; active: boolean; over: HTMLElement | null; card: HTMLElement; title: string };

/** Cards drawn per cell before "더 보기" (a few hundred projects still show whole columns). */
const CELL_CAP = 120;

/**
 * A board: a column per group and, with a subgroup, a row (swimlane) per subgroup across them.
 * Cards are dragged with the pointer (no HTML drag and drop, which WebKitGTK handles poorly); while
 * dragging, nothing is drawn again: the card under the pointer, the place it would land (or why it
 * cannot) and the floating name are classes and a transform. A press without a drag opens the item.
 */
export function GroupBoard<T>({
  view,
  onView,
  paint,
  board,
  colKey,
  laneKey,
  stageColumns = false,
  itemId,
  itemAttr,
  itemTitle,
  card,
  onOpen,
  canMove,
  onMove,
  cardHint,
}: Shared & {
  board: Board<T>;
  colKey: string;
  laneKey: string | null;
  /** The columns are stages: they also carry `data-stage-column` (today's kanban). */
  stageColumns?: boolean;
  itemId: (item: T) => string;
  /** The card's data attribute naming its item (`data-work`, `data-session`). */
  itemAttr: string;
  itemTitle: (item: T) => string;
  card: (item: T) => ReactNode;
  onOpen: (item: T) => void;
  /** Why the item cannot go there, or null. */
  canMove: (item: T, from: Cell, to: Cell) => string | null;
  onMove: (item: T, from: Cell, to: Cell) => void;
  cardHint: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag<T> | null>(null);
  const [wide, setWide] = useState<Set<string>>(new Set());
  const look = lookProps(view.look);
  const lanes = board.lanes;

  const clear = () => {
    const current = drag.current;
    drag.current = null;
    current?.card.classList.remove("lifted");
    current?.over?.classList.remove("over", "refuse");
    root.current?.classList.remove("dragging");
    if (ghost.current) ghost.current.hidden = true;
  };

  const start = (event: ReactPointerEvent<HTMLElement>, item: T, from: Cell) => {
    if (event.button !== 0) return;
    drag.current = { item, from, x0: event.clientX, y0: event.clientY, active: false, over: null, card: event.currentTarget, title: itemTitle(item) };
    const move = (moved: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      if (!current.active) {
        if (Math.hypot(moved.clientX - current.x0, moved.clientY - current.y0) <= 5) return;
        current.active = true;
        current.card.classList.add("lifted");
        root.current?.classList.add("dragging");
        if (ghost.current) {
          ghost.current.hidden = false;
          ghost.current.firstChild!.textContent = current.title;
        }
      }
      if (ghost.current) ghost.current.style.transform = `translate(${Math.round(moved.clientX + 12)}px, ${Math.round(moved.clientY + 8)}px)`;
      const target = (document.elementFromPoint(moved.clientX, moved.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drop]") ?? null;
      const inside = target && root.current?.contains(target) ? target : null;
      if (inside === current.over) return;
      current.over?.classList.remove("over", "refuse");
      current.over = inside;
      let reason: string | null = null;
      if (inside) {
        const to: Cell = { col: inside.dataset.col ?? "", lane: inside.dataset.lane ?? null };
        if (to.col !== current.from.col || to.lane !== current.from.lane) {
          reason = canMove(current.item, current.from, to);
          inside.classList.add(reason ? "refuse" : "over");
        }
      }
      if (hint.current) hint.current.textContent = reason ? "옮길 수 없음" : "";
    };
    const end = (ended: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const current = drag.current;
      clear();
      if (!current || ended.type === "pointercancel") return;
      if (!current.active) return onOpen(current.item);
      if (!current.over) return;
      const to: Cell = { col: current.over.dataset.col ?? "", lane: current.over.dataset.lane ?? null };
      if (to.col !== current.from.col || to.lane !== current.from.lane) onMove(current.item, current.from, to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const keys = (event: ReactKeyboardEvent<HTMLElement>, item: T, from: Cell) => {
    if (event.key === "Enter") return onOpen(item);
    if (!event.altKey) return;
    const columns = board.columns.map((column) => column.id);
    const rows = lanes?.map((lane) => lane.id) ?? [];
    let to: Cell | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const next = columns[columns.indexOf(from.col) + (event.key === "ArrowLeft" ? -1 : 1)];
      if (next !== undefined) to = { ...from, col: next };
    } else if (lanes && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const next = rows[rows.indexOf(from.lane ?? "") + (event.key === "ArrowUp" ? -1 : 1)];
      if (next !== undefined) to = { ...from, lane: next };
    }
    if (!to) return;
    event.preventDefault();
    onMove(item, from, to);
  };

  const cards = (items: T[], from: Cell) => {
    const key = `${from.col}\n${from.lane ?? ""}`;
    const shown = wide.has(key) ? items : items.slice(0, CELL_CAP);
    return (
      <div className="kanban-cards">
        {shown.map((item) => (
          <div
            key={itemId(item)}
            role="button"
            tabIndex={0}
            className="kanban-card"
            {...{ [`data-${itemAttr}`]: itemId(item) }}
            title={cardHint}
            onPointerDown={(event) => start(event, item, from)}
            onKeyDown={(event) => keys(event, item, from)}
          >
            {card(item)}
          </div>
        ))}
        {items.length > shown.length ? (
          <button type="button" className="link home-more" onClick={() => setWide(new Set([...wide, key]))}>
            {items.length - shown.length}개 더 보기
          </button>
        ) : null}
        {!items.length ? (
          <div className="kanban-empty">
            <span className="idle">없음</span>
            <span className="drop">여기로 옮기기</span>
          </div>
        ) : null}
      </div>
    );
  };

  const columnLook = (column: Group<T>) => {
    const color = colorOf(view.look, colKey, column);
    const fold = foldKey(colKey, column.id);
    return { color, fold, folded: view.collapsed.includes(fold) };
  };

  const floating = (
    <div ref={ghost} className="kanban-ghost" hidden aria-hidden>
      <span />
      <span ref={hint} className="kanban-ghost-hint" />
    </div>
  );

  if (!lanes || !laneKey) {
    return (
      <div ref={root} className={`projects-kanban group-board ${look.className}`} style={look.style}>
        {board.columns.map((column) => {
          const { color, fold, folded } = columnLook(column);
          return (
            <section
              key={column.id || "none"}
              className={`kanban-column${color ? " has-color" : ""}${column.items.length ? "" : " empty"}${folded ? " folded" : ""}`}
              style={groupStyle(color)}
              data-drop
              data-col={column.id}
              data-group={column.id}
              {...(stageColumns ? { "data-stage-column": column.id } : {})}
              aria-label={column.label || "값 없음"}
            >
              <GroupHead
                as="header"
                className="kanban-head"
                label={column.label}
                count={column.items.length}
                color={color}
                folded={folded}
                onToggle={() => onView(toggleFold(view, fold))}
                onPaint={(x, y) => paint(colKey, column, x, y)}
              />
              {folded ? null : cards(column.items, { col: column.id, lane: null })}
            </section>
          );
        })}
        {floating}
      </div>
    );
  }

  const template = board.columns.map((column) => (columnLook(column).folded ? "96px" : "minmax(176px, 1fr)")).join(" ");
  return (
    <div ref={root} className={`projects-kanban group-board lanes ${look.className}`} style={{ ...look.style, "--board-columns": template } as CSSProperties}>
      <div className="kanban-row kanban-heads">
        {board.columns.map((column) => {
          const { color, fold, folded } = columnLook(column);
          return (
            <GroupHead
              key={column.id || "none"}
              as="header"
              className={`kanban-head kanban-column-head${folded ? " folded" : ""}`}
              label={column.label}
              count={column.items.length}
              color={color}
              folded={folded}
              onToggle={() => onView(toggleFold(view, fold))}
              onPaint={(x, y) => paint(colKey, column, x, y)}
            />
          );
        })}
      </div>
      {lanes.map((lane) => {
        const laneColor = colorOf(view.look, laneKey, lane);
        const laneFold = foldKey(laneKey, lane.id);
        const laneFolded = view.collapsed.includes(laneFold);
        return (
          <section key={lane.id || "none"} className={`kanban-lane${laneColor ? " has-color" : ""}${laneFolded ? " folded" : ""}`} style={groupStyle(laneColor)} data-lane={lane.id} aria-label={lane.label}>
            <GroupHead
              as="h3"
              className="kanban-lane-head"
              label={lane.label}
              count={lane.items.length}
              color={laneColor}
              folded={laneFolded}
              onToggle={() => onView(toggleFold(view, laneFold))}
              onPaint={(x, y) => paint(laneKey, lane, x, y)}
            />
            {laneFolded ? null : (
              <div className="kanban-row">
                {board.columns.map((column) => {
                  const { color, folded } = columnLook(column);
                  const items = board.cell(column.id, lane.id);
                  return (
                    <div
                      key={column.id || "none"}
                      className={`kanban-cell${color ? " has-color" : ""}${items.length ? "" : " empty"}${folded ? " folded" : ""}`}
                      style={groupStyle(color)}
                      data-drop
                      data-col={column.id}
                      data-lane={lane.id}
                      aria-label={`${column.label} · ${lane.label}`}
                    >
                      {folded ? <span className="kanban-cell-count">{items.length || ""}</span> : cards(items, { col: column.id, lane: lane.id })}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      {floating}
    </div>
  );
}
