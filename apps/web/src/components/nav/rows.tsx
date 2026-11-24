import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ItemIcon, artifactKind, itemKindOf } from "../ItemIcon.tsx";
import { FORMAT_LABEL, PROVIDER_LABEL, type Artifact, type Provider, type Session, type Work } from "@workbench/contracts";
import type { State } from "../../state.ts";
import { docAgentLabel, purposeText, type Row } from "../../tree.ts";
import { statusText } from "../../format.ts";
import { ROW_STATES, groupState, leadState, rowState, type RowStateInfo } from "../../row-state.ts";
import type { Look } from "../../appearance.ts";
import { AUTO_NAME_HINT, EditableText } from "../EditableText.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { StateMark } from "../StateMark.tsx";
import { Icon, iconName, type IconName } from "../Icon.tsx";
import { LinkBadge } from "../LinkSidebar.tsx";
import { linkOfSession } from "../../links.ts";
import { PlacementMark } from "../pkm/ViewsSection.tsx";
import { paneDrag } from "../../panedrag.ts";
import type { PaneItem } from "../../panes.ts";
import { docKind } from "./model.ts";

// The sidebar's rows as they always were (folders, works, sessions, the "문서" row, documents),
// for the single tree and for a project unfolded in the navigator's list: same looks, same
// `data-row-id`, same keys and menus.

/** What a row opens in a pane (dragged onto the main area, or Ctrl+clicked). */
export function rowItem(row: Row): PaneItem | null {
  if (row.type === "session") return { kind: "session", id: row.session.id };
  if (row.type === "work") return { kind: "project", id: row.work.id };
  if (row.type === "doc") return { kind: "doc", id: row.artifact.id };
  if (row.type === "folder") return { kind: "folder", id: row.folder.id };
  return null;
}

const sessionRowLabel = (session: Session) => (session.documentAgent ? docAgentLabel(session) : purposeText(session));

export const rowLabel = (row: Row) => (row.type === "folder" ? row.folder.name : row.type === "work" ? row.work.title : row.type === "session" ? sessionRowLabel(row.session) : row.type === "doc" ? row.artifact.name : row.type === "section" ? row.label : "");

/** One AI of a document, as read out and shown in the row's tooltip (its one state word). */
function agentText(agent: Session, visibleSessionId: string | null) {
  const state = rowState(agent, { onScreen: agent.id === visibleSessionId });
  return `문서 AI, ${PROVIDER_LABEL[agent.provider]}${state ? `, ${state.word}` : ""}`;
}

/** The AI a document row stands for: the most pressing by the one state order, then the newest. */
export function leadAgentState(agents: Session[], visibleSessionId: string | null): { session: Session; state: RowStateInfo | null } | null {
  if (!agents.length) return null;
  const lead = leadState(agents, (agent) => rowState(agent, { onScreen: agent.id === visibleSessionId }));
  if (lead) return { session: lead.item, state: lead.state };
  return { session: agents.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)), state: null };
}

/** Ctrl/Cmd+click or a middle click asks for the right pane. */
export const sideClick = (event: { ctrlKey: boolean; metaKey: boolean; button: number }) => event.button === 1 || ((event.ctrlKey || event.metaKey) && event.button === 0);

const DOC_ICON: Partial<Record<Artifact["format"], IconName>> = { markdown: "page", text: "page", design: "palette" };

export function docIcon(artifact: Artifact): IconName {
  if (artifact.format === "markdown" && /\.(mindmap|mm)\.md$/i.test(artifact.name)) return "mindmap";
  return DOC_ICON[artifact.format] ?? "file";
}

/** The "+" that shows on a hovered row (Notion-style); it never starts a drag or opens the row. */
export function RowAdd({ label, onAdd }: { label: string; onAdd: (anchor: HTMLButtonElement) => void }) {
  return (
    <button
      type="button"
      className="row-add"
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      // Enter/Space on the + is the +'s, not the row's (the row's Enter went inside the project as well — fix 1).
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onAdd(event.currentTarget);
      }}
    >
      <Icon name="plus" size={12} />
    </button>
  );
}

/**
 * The row's ⋯ (the owner, 2026-11-14: "마우스를 올리면 끝에 ⋯이 표시돼서 이름을 쉽게 바꿀 수"): shown at the
 * row's end while it is pointed at or holds the keyboard (in the trailing fact's place), always on a
 * touch screen; it opens the row's menu, whose first item is 이름 바꾸기 where the item can be renamed.
 */
export function RowMore({ name, expanded, onOpen }: { name: string; expanded?: boolean; onOpen: (x: number, y: number, anchor: HTMLButtonElement) => void }) {
  return (
    <button type="button" className="row-more" aria-label={`${name} 더 보기`} title="더 보기: 이름 바꾸기 등" aria-haspopup="menu" aria-expanded={expanded}
      onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); onOpen(box.left, box.bottom + 4, event.currentTarget); }}>
      <Icon name="dots" size={14} />
    </button>
  );
}

/** What a row needs from where it is shown. */
export type RowContext = {
  state: State;
  lookOf: (provider: Provider) => Look;
  visibleSessionId: string | null;
  currentWorkId: string | null;
  currentDocId: string | null;
  focusId: string | null;
  /** The one row Tab reaches (the focused one, else the first or current). */
  tabId: string | null;
  renaming: string | null;
  startRename: (id: string) => void;
  toggle: (row: Row) => void;
  activate: (row: Row) => void;
  onKey: (event: ReactKeyboardEvent, row: Row) => void;
  onPress: (event: ReactPointerEvent, row: Row) => void;
  onFocusRow: (id: string) => void;
  onRename: (row: Row, name: string) => void;
  onRenameDone: (row: Row) => void;
  onMenu: (row: Row, x: number, y: number) => void;
  /** The ⋯ on a document row: its menu under the button. */
  onMoreMenu?: (row: Row, anchor: HTMLElement) => void;
  /** The row whose menu is open (its ⋯ stays shown). */
  menuOpenId?: string | null;
  justDragged: () => boolean;
  openRight?: (item: PaneItem) => void;
  closeWebTab?: (session: Session) => void;
  newSession: (folderId: string) => void;
  newPage: (row: Extract<Row, { type: "work" }>) => void;
  creationMenu?: (work: Work | null, x: number, y: number) => void;
  newSubpage?: (artifact: Artifact) => void;
  /** Rows marked as the navigator's list rows (keyboard order inside the list). */
  listRow?: boolean;
  /** N1, inside a project: a conversation says its state in words, a document its kind (MD, PPTX, HWPX…). */
  words?: boolean;
};

/** A conversation's state for a row: its one state (row-state.ts), the one on screen never "새 답". */
export const sessionState = (session: Session, visibleSessionId: string | null) => rowState(session, { onScreen: session.id === visibleSessionId });

export { StateMark } from "../StateMark.tsx";

export function TreeRow({ row, ctx }: { row: Row; ctx: RowContext }) {
  const { state, visibleSessionId, currentWorkId, currentDocId } = ctx;
  if (row.type === "section") {
    return (
      <div className={`side-section-label${row.kind ? " side-kind" : ""}`} style={{ paddingLeft: 8 + row.depth * 14 }} data-row-id={row.id} onContextMenu={event => {
        if (!row.workId) return;
        event.preventDefault(); event.stopPropagation(); ctx.onMenu(row, event.clientX, event.clientY);
      }}>
        {row.kind ? (
          <>
            <span className="row-chevron blank" aria-hidden />
            <Icon name={row.kind === "web" ? "globe" : "chat"} size={13} className="side-kind-icon" />
            <span>{row.label}</span>
            <span className="side-kind-count">{row.count}</span>
          </>
        ) : row.label}
      </div>
    );
  }
  const indent: CSSProperties = { paddingLeft: 8 + row.depth * 14 };
  const expandable = (row.type === "folder" && !row.empty) || (row.type === "work" && row.expandable) || row.type === "docs";
  const isOpen = (row.type === "folder" || row.type === "work" || row.type === "docs") && row.open;
  const chevron = (
    <span
      className={`row-chevron${expandable ? "" : " blank"}`}
      onClick={(event) => {
        if (!expandable) return;
        event.stopPropagation();
        ctx.toggle(row);
      }}
      aria-hidden
    >
      {expandable ? <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={13} /> : null}
    </span>
  );
  const listAttr = ctx.listRow ? { "data-list-row": "" } : {};
  if (ctx.renaming === row.id && (row.type === "folder" || row.type === "work" || row.type === "session")) {
    const value = row.type === "folder" ? row.folder.name : row.type === "work" ? row.work.title : row.session.purpose;
    return (
      <div className="side-row renaming" style={indent} data-row-id={row.id} {...listAttr}>
        {chevron}
        <ItemIcon kind={row.type === "folder" ? "folder" : row.type === "work" ? "project" : "chat"} size={15} />
        <EditableText className="side-rename" label={`${value} 이름 바꾸기`} value={value}
          // A conversation or project emptied asks for its automatic name; a folder has none to fall back on.
          {...(row.type === "folder" ? { emptyRefused: "폴더 이름을 적어 주세요. 이름 없는 폴더는 없습니다." } : { empty: { hint: AUTO_NAME_HINT } })}
          onSave={(next) => ctx.onRename(row, next)} onDone={() => ctx.onRenameDone(row)} />
      </div>
    );
  }
  let icon: IconName = "folder";
  let label = "";
  let trailing: ReactNode = null;
  let count: ReactNode = null;
  let ariaLabel: string | undefined;
  /** The row stands for where the user is (a document open on screen, its group when folded). */
  let here = false;
  let style: CSSProperties = indent;
  let title: string | undefined;
  if (row.type === "folder") {
    label = row.folder.name;
    // The navigator's colour and icon show here too (the colour is the person's own, user data).
    icon = iconName(row.folder.icon) ?? "folder";
    if (row.folder.color) style = { ...indent, "--folder-color": row.folder.color } as CSSProperties;
    trailing = (
      <span className="side-row-trail">
        <RowAdd label="이 폴더에 새 작업" onAdd={() => ctx.newSession(row.folder.id)} />
      </span>
    );
  } else if (row.type === "work") {
    icon = "project";
    label = row.work.title;
    const marks = groupState(row.sessions, visibleSessionId);
    const only = row.sessions.length === 1 ? row.sessions[0] : null;
    // A folded work shows the link of a session inside it (its row is hidden).
    const linked = only ?? (row.open ? undefined : row.sessions.find((session) => linkOfSession(state, session.id)));
    trailing = (
      <span className="side-row-trail">
        <PlacementMark workId={row.work.id} />
        <RowAdd label="새로 만들기" onAdd={anchor => {
          const box = anchor.getBoundingClientRect();
          if (ctx.creationMenu) ctx.creationMenu(row.work, box.left, box.bottom);
          else ctx.newPage(row);
        }} />
        {linked ? <LinkBadge sessionId={linked.id} /> : null}
        {marks.needs ? <span className="nav-pill" title={`확인 필요 ${marks.needs}`}>{marks.needs}</span> : marks.running ? <StateMark state={ROW_STATES.running} size={14} /> : null}
      </span>
    );
    title = `${row.work.title}\n프로젝트 노트와 속성 열기`;
  } else if (row.type === "session") {
    icon = row.session.pageAgent ? "globe" : "chat";
    label = sessionRowLabel(row.session);
    const said = sessionState(row.session, visibleSessionId);
    trailing = (
      <span className="side-row-trail">
        <LinkBadge sessionId={row.session.id} />
        {ctx.words ? (said ? <span className={`row-state tone-${said.tone}`}>{said.word}</span> : null) : (
          <>
            <EngineMark provider={row.session.provider} size={13} className="side-row-engine" />
            {said && said.id !== "done" ? <span className={`row-state tone-${said.tone}`}>{said.word}</span> : null}
          </>
        )}
        {ctx.listRow ? <RowMore name={row.session.purpose} onOpen={(x, y) => ctx.onMenu(row, x, y)} /> : null}
        {row.session.pageAgent && ctx.closeWebTab ? <button type="button" className="row-web-close" title="웹 탭 닫기 (대화는 보관함에 남습니다)" aria-label={`${row.session.purpose} 웹 탭 닫기`}
          onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); ctx.closeWebTab!(row.session); }}><Icon name="x" size={13} /></button> : null}
      </span>
    );
    title = `${row.session.pageAgent ? "웹 AI" : row.session.documentAgent ? "문서 AI" : "대화"}, ${PROVIDER_LABEL[row.session.provider]}${said ? `, ${said.word}` : ""}${row.session.activity && said?.id === "running" ? `\n${statusText(row.session)}` : ""}`;
  } else if (row.type === "docs") {
    icon = "file";
    label = "문서";
    // Folded, the group still says that one of its documents' AIs needs the user or answered.
    // Folded, the group stands for its documents: where the user is, and their AIs' most pressing state.
    const lead = row.open ? null : leadAgentState(row.agents, visibleSessionId);
    const shown = currentDocId ? state.artifacts[currentDocId] : undefined;
    here = !row.open && Boolean(shown && shown.workId === row.work.id && shown.role !== "project-note");
    count = <span className="side-kind-count">{row.count}</span>;
    trailing = lead?.state && lead.state.id !== "done" ? (
      <span className="side-row-trail">
        <StateMark state={lead.state} size={14} />
      </span>
    ) : null;
    ariaLabel = `문서 ${row.count}${lead?.state ? `, 문서 AI ${lead.state.word}` : ""}`;
  } else if (row.type === "doc") {
    icon = docIcon(row.artifact);
    label = row.artifact.name;
    const artifact = row.artifact;
    const lead = leadAgentState(row.agents, visibleSessionId);
    // A document says its kind; its AI shows only while it asks for the person, fails, works or has a new answer.
    const aiMark = lead?.state && lead.state.id !== "done" && lead.state.id !== "queued" ? lead.state : null;
    trailing = (
      <span className="side-row-trail">
        {artifact.format === "markdown" && ctx.newSubpage ? <RowAdd label="하위 페이지" onAdd={() => ctx.newSubpage!(artifact)} /> : null}
        {ctx.onMoreMenu ? <RowMore name={artifact.name} expanded={ctx.menuOpenId === row.id} onOpen={(_x, _y, anchor) => ctx.onMoreMenu!(row, anchor)} /> : null}
        {ctx.words ? (
          <>
            {/* One trailing fact: the document AI's state while it asks, fails, works or answered anew; else the kind. */}
            {aiMark ? <span className="row-doc-ai" title={`문서 AI ${aiMark.word}`}><StateMark state={aiMark} size={14} withWord /></span> : <span className="row-kind" title={`${artifact.revision}판`}>{docKind(artifact.name, artifact.format)}</span>}
          </>
        ) : (
          <>
            <span className="side-row-rev">{artifact.revision}판</span>
            {aiMark ? <StateMark state={aiMark} size={14} /> : null}
          </>
        )}
      </span>
    );
    title = `${row.artifact.name}\n${FORMAT_LABEL[row.artifact.format]}, ${row.artifact.revision}판`;
    if (lead) {
      title += `\n${row.agents.map((agent) => agentText(agent, visibleSessionId)).join("\n")}`;
      ariaLabel = `${label}, ${docKind(artifact.name, artifact.format)}${aiMark ? `, 문서 AI ${aiMark.word}` : ""}`;
    }
    here = row.id === currentDocId;
  }
  // Items wear the item icons (ItemIcon.tsx); the "문서" group row keeps its line icon.
  const itemKind = row.type === "doc" ? artifactKind(row.artifact) : row.type === "docs" || row.type === "folder" ? null : itemKindOf(icon);
  const classes = ["side-row", `row-${row.type}`];
  if (row.type === "folder" && row.folder.color) classes.push("nav-folder", "colored");
  if (row.id === ctx.focusId) classes.push("focused");
  if (row.type === "work" && row.id === currentWorkId && !visibleSessionId && !currentDocId) classes.push("current");
  if (row.type === "work" && row.id === currentWorkId && (visibleSessionId || currentDocId)) classes.push("current-project");
  if (row.type === "session" && row.id === visibleSessionId) classes.push("current");
  if ((row.type === "doc" || row.type === "docs") && here) classes.push("current");
  const item = rowItem(row);
  return (
    <div
      role="treeitem"
      aria-label={row.type === "session" ? `${label}, ${(title ?? "").split("\n")[0]}` : row.type === "work" ? `${label}, 프로젝트` : ariaLabel}
      aria-current={(row.type === "work" && row.id === currentWorkId && (visibleSessionId || currentDocId)) || (row.type === "docs" && here) ? "location" : undefined}
      aria-level={row.depth + 1}
      aria-expanded={expandable ? isOpen : undefined}
      aria-selected={row.type === "work" ? row.id === currentWorkId && !visibleSessionId && !currentDocId : row.id === visibleSessionId || row.id === currentDocId}
      tabIndex={row.id === ctx.tabId ? 0 : -1}
      className={classes.join(" ")}
      style={style}
      data-row-id={row.id}
      {...listAttr}
      title={title}
      onPointerDown={(event) => ctx.onPress(event, row)}
      onClick={(event: ReactMouseEvent) => {
        if (ctx.justDragged()) return;
        ctx.onFocusRow(row.id);
        if (sideClick(event) && item && ctx.openRight) ctx.openRight(item);
        else ctx.activate(row);
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && item && ctx.openRight) ctx.openRight(item);
      }}
      onDoubleClick={() => (row.type === "folder" || row.type === "work" || row.type === "session") && ctx.startRename(row.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        ctx.onFocusRow(row.id);
        ctx.onMenu(row, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => ctx.onKey(event, row)}
      onFocus={() => ctx.onFocusRow(row.id)}
    >
      {chevron}
      {ctx.words && row.type === "session" ? (
        <StateMark state={sessionState(row.session, visibleSessionId)} />
      ) : row.type === "folder" ? (
        <span className="side-row-icon nav-folder-icon">
          {/* The person's own folder icon stays a line icon in their colour; the plain folder is the item icon. */}
          {icon === "folder" ? <ItemIcon kind="folder" size={15} /> : <Icon name={icon} size={15} />}
        </span>
      ) : itemKind ? (
        <ItemIcon kind={itemKind} size={15} className="side-row-icon" />
      ) : (
        <Icon name={icon} size={15} className="side-row-icon" />
      )}
      <span className="side-row-label">{label}</span>
      {count}
      {trailing}
    </div>
  );
}

/** A session in "지금" (or a pinned one): opens on click, drags into a pane, its menu on right-click. */
export function NowRow({
  session,
  label,
  current,
  onOpen,
  onMenu,
  openRight,
  extraClass = "",
  meta,
  detail,
}: {
  session: Session;
  label: string;
  /** 0.5.4 (활동): what this running or waiting turn is doing now ("12분째 · 380 MB", "2번째"), quiet at the row's end in place of the state word its group already says. */
  detail?: string;
  /** N1: the conversation's project, quiet at the row's end. */
  meta?: string;
  current: boolean;
  look: Look;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  openRight?: (item: PaneItem) => void;
  extraClass?: string;
}) {
  const said = rowState(session, { onScreen: current });
  return (
    <button
      type="button"
      className={`side-row now-row${current ? " current" : ""}${extraClass}`}
      onPointerDown={(event) => {
        if (event.button === 1 && openRight) event.preventDefault();
        paneDrag.press({ item: { kind: "session", id: session.id }, label: session.purpose }, event);
      }}
      onClick={(event) => {
        if (paneDrag.justDragged()) return;
        if (sideClick(event) && openRight) openRight({ kind: "session", id: session.id });
        else onOpen();
      }}
      onAuxClick={(event) => event.button === 1 && openRight?.({ kind: "session", id: session.id })}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(event.clientX, event.clientY);
      }}
      title={`${label}${meta ? `\n${meta}` : ""}${said ? `\n${said.word}` : ""}${detail ? `\n${detail}` : ""}`}
      aria-label={`${label}${said ? `, ${said.word}` : ""}${detail ? `, ${detail}` : ""}${meta ? `, ${meta}` : ""}`}
    >
      <StateMark state={said} />
      <span className="side-row-label">{label}</span>
      <span className="side-row-trail">
        <LinkBadge sessionId={session.id} />
        {detail ? <span className="nav-owner now-detail">{detail}</span> : said ? <span className={`row-state tone-${said.tone}`}>{said.word}</span> : null}
      </span>
    </button>
  );
}
