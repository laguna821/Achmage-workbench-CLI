import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { FORMAT_LABEL, PROVIDER_LABEL, isUnseen, type Artifact, type Provider, type Session, type Work } from "@workbench/contracts";
import type { State } from "../../state.ts";
import { docAgentLabel, leadAgent, type AgentTone, type Row } from "../../tree.ts";
import { statusText, statusTone } from "../../format.ts";
import type { Look } from "../../appearance.ts";
import { EditableText } from "../EditableText.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { Icon, iconName, type IconName } from "../Icon.tsx";
import { LinkBadge } from "../LinkSidebar.tsx";
import { linkOfSession } from "../../links.ts";
import { PlacementMark } from "../pkm/ViewsSection.tsx";
import { paneDrag } from "../../panedrag.ts";
import type { PaneItem } from "../../panes.ts";

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

const sessionRowLabel = (session: Session) => (session.documentAgent ? docAgentLabel(session) : session.purpose);

export const rowLabel = (row: Row) => (row.type === "folder" ? row.folder.name : row.type === "work" ? row.work.title : row.type === "session" ? sessionRowLabel(row.session) : row.type === "doc" ? row.artifact.name : row.type === "section" ? row.label : "");

const TONE_TEXT: Record<Exclude<AgentTone, null>, string> = { attention: "확인 필요", error: "오류", active: "진행 중", new: "새 답" };

/** One AI of a document, as read out and shown in the row's tooltip ("새 답" included). */
function agentText(agent: Session, visibleSessionId: string | null) {
  const unseen = agent.id !== visibleSessionId && statusTone(agent) === "idle" && isUnseen(agent);
  return `문서 AI · ${PROVIDER_LABEL[agent.provider]} · ${statusText(agent)}${unseen ? " · 새 답" : ""}`;
}

/** The state dot of an AI at a row's end, the same language as conversation rows. */
function AgentDot({ tone }: { tone: AgentTone }) {
  return tone ? <span className={`dot dot-${tone}`} title={TONE_TEXT[tone]} /> : null;
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
      onClick={(event) => {
        event.stopPropagation();
        onAdd(event.currentTarget);
      }}
    >
      <Icon name="plus" size={12} />
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
};

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
        <Icon name={row.type === "folder" ? "folder" : row.type === "work" ? "project" : "chat"} size={15} />
        <EditableText className="side-rename" value={value} onSave={(next) => ctx.onRename(row, next)} onDone={() => ctx.onRenameDone(row)} />
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
    const attention = row.sessions.some((session) => session.status === "awaitingApproval");
    const busy = row.sessions.some((session) => session.status === "starting" || session.status === "running" || session.status === "interrupting");
    const unseen = row.sessions.some((session) => session.id !== visibleSessionId && isUnseen(session));
    const only = row.sessions.length === 1 ? row.sessions[0] : null;
    // A folded work shows the link of a session inside it (its row is hidden).
    const linked = only ?? (row.open ? undefined : row.sessions.find((session) => linkOfSession(state, session.id)));
    trailing = (
      <span className="side-row-trail">
        <PlacementMark workId={row.work.id} />
        <RowAdd label="새 문서·세션 만들기" onAdd={anchor => {
          const box = anchor.getBoundingClientRect();
          if (ctx.creationMenu) ctx.creationMenu(row.work, box.left, box.bottom);
          else ctx.newPage(row);
        }} />
        {linked ? <LinkBadge sessionId={linked.id} /> : null}
        {only ? <EngineMark provider={only.provider} size={13} className="side-row-engine" /> : null}
        {attention ? <span className="dot dot-attention" title="확인 필요" /> : busy ? <span className="dot dot-active" title="진행 중" /> : unseen ? <span className="dot dot-new" title="새 답" /> : null}
      </span>
    );
    title = `프로젝트 · ${row.work.title}\n오버뷰와 속성 열기\n${row.work.cwd}`;
  } else if (row.type === "session") {
    icon = row.session.pageAgent ? "globe" : "chat";
    label = sessionRowLabel(row.session);
    const tone = statusTone(row.session);
    const unseen = row.session.id !== visibleSessionId && isUnseen(row.session);
    trailing = (
      <span className="side-row-trail">
        <LinkBadge sessionId={row.session.id} />
        <EngineMark provider={row.session.provider} size={13} className="side-row-engine" />
        {tone !== "idle" ? <span className={`dot dot-${tone}`} title={statusText(row.session)} /> : unseen ? <span className="dot dot-new" title="새 답" /> : null}
        {row.session.pageAgent && ctx.closeWebTab ? <button type="button" className="row-web-close" title="웹 탭 닫기 · 대화는 보관함에 유지" aria-label={`${row.session.purpose} 웹 탭 닫기`}
          onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); ctx.closeWebTab!(row.session); }}><Icon name="x" size={13} /></button> : null}
      </span>
    );
    title = `${row.session.pageAgent ? "웹 AI" : row.session.documentAgent ? "문서 AI" : "대화"} · ${PROVIDER_LABEL[row.session.provider]} · ${statusText(row.session)}`;
  } else if (row.type === "docs") {
    icon = "file";
    label = "문서";
    // Folded, the group still says that one of its documents' AIs needs the user or answered.
    // Folded, the group stands for its documents: where the user is, and their AIs' most pressing state.
    const lead = row.open ? null : leadAgent(row.agents, visibleSessionId);
    const shown = currentDocId ? state.artifacts[currentDocId] : undefined;
    here = !row.open && Boolean(shown && shown.workId === row.work.id && shown.role !== "project-note");
    count = <span className="side-kind-count">{row.count}</span>;
    trailing = lead ? (
      <span className="side-row-trail">
        <EngineMark provider={lead.session.provider} size={13} className="side-row-engine" />
        <AgentDot tone={lead.tone} />
      </span>
    ) : null;
    ariaLabel = `문서 ${row.count}${lead?.tone ? ` · ${TONE_TEXT[lead.tone]}` : ""}`;
  } else if (row.type === "doc") {
    icon = docIcon(row.artifact);
    label = row.artifact.name;
    const artifact = row.artifact;
    const lead = leadAgent(row.agents, visibleSessionId);
    trailing = (
      <span className="side-row-trail">
        {artifact.format === "markdown" && ctx.newSubpage ? <RowAdd label="하위 페이지" onAdd={() => ctx.newSubpage!(artifact)} /> : null}
        {ctx.onMoreMenu ? (
          <button type="button" className="row-more" aria-label={`${artifact.name} 메뉴`} title="메뉴" aria-haspopup="menu" aria-expanded={ctx.menuOpenId === row.id}
            onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); ctx.onMoreMenu!(row, event.currentTarget); }}>
            <Icon name="dots" size={14} />
          </button>
        ) : null}
        <span className="side-row-rev">r{artifact.revision}</span>
        {lead ? <EngineMark provider={lead.session.provider} size={13} className="side-row-engine" /> : null}
        <AgentDot tone={lead?.tone ?? null} />
      </span>
    );
    title = `${FORMAT_LABEL[row.artifact.format]} · ${row.artifact.path}`;
    if (lead) {
      title += `\n${row.agents.map((agent) => agentText(agent, visibleSessionId)).join("\n")}`;
      ariaLabel = `${label} · ${row.agents.map((agent) => agentText(agent, visibleSessionId)).join(" · ")}`;
    }
    here = row.id === currentDocId;
  }
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
      aria-label={row.type === "session" ? `${label} · ${title}` : row.type === "work" ? `프로젝트 · ${label}` : ariaLabel}
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
      {row.type === "folder" ? (
        <span className="side-row-icon nav-folder-icon">
          <Icon name={icon} size={15} />
        </span>
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
}: {
  session: Session;
  label: string;
  current: boolean;
  look: Look;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  openRight?: (item: PaneItem) => void;
  extraClass?: string;
}) {
  const unseen = isUnseen(session) && !current;
  const tone = statusTone(session);
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
      title={`${label} · ${statusText(session)}`}
    >
      <span className={`dot dot-${tone === "idle" && unseen ? "new" : tone}`} />
      <span className="side-row-label">{label}</span>
      <LinkBadge sessionId={session.id} />
      <EngineMark provider={session.provider} size={13} className="side-row-engine" />
    </button>
  );
}
