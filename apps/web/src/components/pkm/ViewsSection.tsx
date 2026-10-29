import { Icon } from "../Icon.tsx";
import type { MenuEntry, MenuRequest } from "../ContextMenu.tsx";
import { usePkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

// "보기" in the sidebar: saved queries shown as virtual folders (no model is asked), and the way
// into the rules that place new works ("자동 정리 규칙").

/**
 * `onFold`: the head folds the section to its line (the navigator keeps whether it is folded).
 * `menuExtras`: more items for a view's menu (the navigator's "바로가기에 더하기").
 */
export function ViewsSection({
  openMenu,
  folded = false,
  onFold,
  menuExtras,
}: {
  openMenu: (request: MenuRequest) => void;
  folded?: boolean;
  onFold?: (folded: boolean) => void;
  menuExtras?: (view: { id: string; name: string }) => MenuEntry[];
}) {
  const pkm = usePkm();
  const views = pkm.pkmState?.views;
  if (!views) return null;
  const selected = pkm.target?.kind === "view" ? pkm.target.id : null;

  const sectionMenu = (x: number, y: number) =>
    openMenu({
      x,
      y,
      title: "보기",
      items: [
        { kind: "item", label: "새 보기…", icon: "plus", onSelect: () => pkm.setDialog({ kind: "view", id: null }) },
        { kind: "item", label: "자동 정리 규칙…", icon: "bolt", onSelect: () => pkm.setDialog({ kind: "rules" }) },
      ],
    });

  return (
    <section className="side-section views-section" aria-label="보기">
      <div className="side-section-title with-tools">
        {onFold ? (
          <button type="button" className="nav-fold" aria-expanded={!folded} title={folded ? "보기 펼치기" : "보기 접기"} onClick={() => onFold(!folded)}>
            <Icon name={folded ? "chevronRight" : "chevronDown"} size={13} />
            <span>보기</span>
          </button>
        ) : (
          <span>보기</span>
        )}
        {folded && views.length ? <span className="nav-fold-count">{views.length}</span> : null}
        <span className="side-tools">
          <button type="button" className="icon-button small" title="새 보기" onClick={() => pkm.setDialog({ kind: "view", id: null })}>
            <Icon name="plus" size={13} />
          </button>
          <button
            type="button"
            className="icon-button small"
            title="보기 메뉴"
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              sectionMenu(box.left, box.bottom + 4);
            }}
          >
            <Icon name="dots" size={13} />
          </button>
        </span>
      </div>
      {folded ? null : views.map((view) => (
        <button
          key={view.id}
          type="button"
          className={`side-row view-row${selected === view.id ? " current" : ""}`}
          data-view-id={view.id}
          title={view.query}
          onClick={() => pkm.open?.({ kind: "view", id: view.id })}
          onContextMenu={(event) => {
            event.preventDefault();
            const items: MenuEntry[] = [
              { kind: "item", label: "열기", icon: "grid", onSelect: () => pkm.open?.({ kind: "view", id: view.id }) },
              { kind: "item", label: "고치기…", icon: "edit", onSelect: () => pkm.setDialog({ kind: "view", id: view.id }) },
              ...(menuExtras ? menuExtras(view) : []),
              { kind: "separator" },
              { kind: "item", label: "지우기", icon: "x", danger: true, onSelect: () => void pkm.client.deleteView(view.id).catch((error: Error) => pkm.onToast(error.message)) },
            ];
            openMenu({ x: event.clientX, y: event.clientY, title: view.name, items });
          }}
        >
          <Icon name="grid" size={14} className="side-row-icon" />
          <span className="side-row-label">{view.name}</span>
          <span className="side-row-trail muted">{view.count}</span>
        </button>
      ))}
      {!views.length && !folded ? (
        <button type="button" className="side-row" onClick={() => pkm.setDialog({ kind: "view", id: null })}>
          <Icon name="plus" size={14} className="side-row-icon" />
          <span className="side-row-label muted">보기 만들기</span>
        </button>
      ) : null}
    </section>
  );
}

/** On a work row: the rule that put the work where it is ("이 규칙으로 여기 있음"). */
export function PlacementMark({ workId }: { workId: string }) {
  const pkm = usePkm();
  const placement = pkm.pkmState?.placements[workId];
  if (!placement) return null;
  return (
    <span className="rule-mark" title={`규칙 「${placement.ruleName}」으로 여기 있음`} aria-label={`규칙 ${placement.ruleName}`}>
      <Icon name="bolt" size={11} />
    </span>
  );
}
