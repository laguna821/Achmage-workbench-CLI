import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ItemIcon } from "../ItemIcon.tsx";
import type { BrowserPage, Work } from "@workbench/contracts";
import { workPages, type WebItem } from "../../tree.ts";
import { leadState } from "../../row-state.ts";
import { InsideSection } from "./InsideSection.tsx";
import type { MenuEntry } from "../ContextMenu.tsx";
import { RowMore, StateMark, sessionState } from "./rows.tsx";
import type { NavShared } from "./shared.ts";

// Skin 2 · B, item 4: the 웹 section of level 2 lists the project's browser pages — the open ones and
// those whose tab was closed — each with its AI's state if it has one. A row and its tab are one item
// (`browser:<pageId>`): a row whose page is open goes to its tab (or opens one); a closed row says
// 닫힘 and opens the same page again (다시 열기); 목록에서 지우기 (its menu) is the final removal that
// the tab's × used to do silently. "+" opens a new page in THIS project. Rows use the list's row
// recipe as unit A left it (side-row, row-glyph, row-state); only their content is decided here.

/** What the 웹 rows need from the app (the desktop's browser; on a phone the lists are empty). */
export type WebRowActions = {
  pages: readonly BrowserPage[];
  closedPages: readonly BrowserPage[];
  /** The focused pane's tab, as an item id (`browser:<pageId>`), to mark the row on screen. */
  currentId: string | null;
  /** A row whose page is open: to its tab, else one tab; a page AI whose page is not known: its conversation. */
  open: (item: WebItem) => void;
  /** 다시 열기: the same page again (identity, profile, URL), then its tab. */
  reopen: (item: WebItem) => void;
  /** Close the page's tab (the row stays, 닫힘). */
  close: (item: WebItem) => void;
  /** 목록에서 지우기: the explicit, final removal. */
  forget: (item: WebItem) => void;
  /** The page's AI conversation. */
  openAgent?: (item: WebItem) => void;
  /** A new page in this project. */
  create: (work: Work) => void;
};

export const WEB_LABEL = "웹";

export function WebRows({ shared, work, web, text, tabId, onKey }: {
  shared: NavShared;
  work: Work;
  web: WebRowActions;
  /** The level's search words (lower case), or "". */
  text: string;
  /** The row Tab reaches in this level (roving), if it is one of these. */
  tabId: string | null;
  /** The level's keys (↑↓ Home End, Alt+←). */
  onKey: (event: ReactKeyboardEvent) => void;
}) {
  const { state, nav } = shared;
  const items = workPages(state, work.id, web);
  const shown = items.filter((item) => !text || `${item.title} ${item.url ?? ""}`.toLocaleLowerCase("ko").includes(text));
  const folded = Boolean(nav.sections.web);
  const here = folded && items.some((item) => item.id === web.currentId);
  // Folded, the head still says the most pressing state of an open page's AI (as 대화 and 문서 do).
  const lead = leadState(items, (item) => {
    const state = item.agent && item.open ? sessionState(item.agent, shared.visibleSessionId) : null;
    return state && state.id !== "done" && state.id !== "queued" ? state : null;
  })?.state ?? null;
  const addLabel = `「${work.title}」에 새 웹 페이지`;
  const menu = (item: WebItem, x: number, y: number) => {
    const entries: MenuEntry[] = [
      item.open ? { kind: "item", label: "열기", icon: "globe", onSelect: () => web.open(item) } : { kind: "item", label: "다시 열기", icon: "restore", onSelect: () => web.reopen(item) },
      ...(item.agent && web.openAgent ? [{ kind: "item" as const, label: "웹 AI 대화 열기", icon: "chat" as const, onSelect: () => web.openAgent!(item) }] : []),
      ...(item.open && item.pageId && item.id.startsWith("browser:") ? [{ kind: "item" as const, label: "탭 닫기", icon: "x" as const, hint: "목록에는 남습니다", onSelect: () => web.close(item) }] : []),
      ...(item.pageId && item.id.startsWith("browser:") ? [{ kind: "separator" as const }, { kind: "item" as const, label: "목록에서 지우기", icon: "trash" as const, danger: true, onSelect: () => web.forget(item) }] : []),
    ];
    shared.actions.openMenu({ x, y, title: item.title, items: entries });
  };
  const activate = (item: WebItem) => (item.open ? web.open(item) : web.reopen(item));
  return (
    <InsideSection id="web" label={WEB_LABEL} count={items.length} folded={folded} here={here} lead={lead}
      onFold={() => shared.saveNav({ sections: { ...nav.sections, web: !folded } })}
      addLabel={addLabel} onAdd={() => web.create(work)}
      empty={text ? "찾는 이름이 없습니다." : "아직 웹 페이지가 없습니다."}>
      {shown.length ? shown.map((item) => {
        const said = item.agent && item.open ? sessionState(item.agent, shared.visibleSessionId) : null;
        const word = item.open ? (said?.word ?? "") : "닫힘";
        const tone = item.open ? (said?.tone ?? "idle") : "closed";
        const current = item.id === web.currentId;
        const label = `${item.title}${word ? `, ${word}` : ""}${item.agent ? ", 웹 AI 있음" : ""}`;
        return (
          <div
            key={item.id}
            role="treeitem"
            aria-level={1}
            aria-selected={current}
            aria-label={label}
            tabIndex={item.id === tabId ? 0 : -1}
            className={`side-row row-web${current ? " current" : ""}${item.open ? "" : " closed"}`}
            data-row-id={item.id}
            data-list-row=""
            data-page-id={item.pageId ?? undefined}
            title={item.url ? `${item.title}\n${item.url}${item.open ? "" : "\n닫힘: 누르면 같은 페이지를 다시 엽니다"}` : item.title}
            onClick={() => activate(item)}
            onContextMenu={(event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation(); menu(item, event.clientX, event.clientY); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(item); }
              else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                menu(item, box.left + 24, box.bottom);
              } else onKey(event);
            }}
          >
            {item.agent && item.open ? <StateMark state={said} /> : <ItemIcon kind="web" size={15} className="side-row-icon" />}
            <span className="side-row-label">{item.title}</span>
            <span className="side-row-trail">
              <RowMore name={item.title} onOpen={(x, y) => menu(item, x, y)} />
              {word ? <span className={`row-state tone-${tone}`}>{word}</span> : null}
            </span>
          </div>
        );
      }) : null}
    </InsideSection>
  );
}
