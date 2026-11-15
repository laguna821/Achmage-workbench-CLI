import type { Session, Work } from "@workbench/contracts";
import type { Layout, PaneContent, PaneId } from "./panes.ts";
import { activeTab, contentKey, findTab } from "./tabs.ts";

/**
 * Where opening a conversation goes: a document's or web tab's AI beside its document or page; an
 * archived one of any kind as the conversation it is (read-only, with its 되돌리기 banner) — never
 * another conversation of the project, nor the document or page in its place.
 */
export function sessionView(session: Session): { kind: "work" } | { kind: "document"; artifactId: string; proposalId: null } | { kind: "browser"; pageId: string } {
  if (session.archivedAt) return { kind: "work" };
  if (session.documentAgent) return { kind: "document", artifactId: session.documentAgent.artifactId, proposalId: null };
  if (session.pageAgent) return { kind: "browser", pageId: session.pageAgent.pageId };
  return { kind: "work" };
}

/** Looking at a conversation marks it seen and makes it the project's active one — not an archived one. */
export const lookingChangesState = (session: Session) => !session.archivedAt;

/**
 * The one rule wherever showing a conversation would make it the project's active one (opening it,
 * focusing its pane or tab, placing, closing a pane, restoring a layout): a live chat of that
 * project, not already active. Never an archived one, nor a document's or web tab's AI.
 */
export const becomesActive = (owner: Work | undefined, session: Session | undefined): boolean =>
  Boolean(owner && session && lookingChangesState(session) && !session.documentAgent && !session.pageAgent && session.workId === owner.id && owner.activeSessionId !== session.id);

/** A document's or web tab's AI opens beside its document or page only while live. */
export const opensBeside = (session: Session) => Boolean((session.documentAgent || session.pageAgent) && !session.archivedAt);

export type RouteView = ReturnType<typeof sessionView>;

/**
 * Where a conversation is shown, and whether its conversation must be brought out there: a live
 * document AI beside its document (asked for, so it is never left hidden behind the document); a
 * live web AI beside its page; anything else — a chat, an archived one, an AI whose document is
 * gone — as the conversation it is.
 */
export function sessionRoute(session: Session, hasDocument: (artifactId: string) => boolean): { content: PaneContent<RouteView>; reveal: { artifactId: string; sessionId: string } | null } {
  const view = sessionView(session);
  const content = (shown: RouteView) => ({ workId: session.workId, sessionId: session.id, view: shown });
  if (view.kind === "document") return hasDocument(view.artifactId) ? { content: content(view), reveal: { artifactId: view.artifactId, sessionId: session.id } } : { content: content({ kind: "work" }), reveal: null };
  return { content: content(view), reveal: null };
}

/** The pane a view lands in: the one that already has it in a tab, else the focused one. */
export const landingPane = <V>(layout: Layout<V>, content: PaneContent<V>): PaneId => findTab(layout, contentKey(content))?.pane.id ?? layout.focus;

/** What the app lends the opener. `reveal` is filed only once the pane has moved (a refused leave asks for nothing). */
export type OpenerDesk = {
  find: (sessionId: string) => Session | undefined;
  hasDocument: (artifactId: string) => boolean;
  navigate: (content: PaneContent<RouteView>, opened?: () => void) => void;
  reveal: (artifactId: string, request: { sessionId: string }) => void;
  /** A conversation shown as itself (a chat, or a read-only archived one); `opened` once the pane shows it. */
  conversation: (session: Session, work?: { id: string }, opened?: () => void) => void;
};

/**
 * The one opener, in the shape each control hands over: a session, a session id, a project and one
 * of its sessions, or a document and one of its AIs. Every one ends in `open`.
 */
export function sessionEntries(desk: OpenerDesk) {
  const open = (session: Session, work?: { id: string }, opened?: () => void) => {
    const route = sessionRoute(session, desk.hasDocument);
    if (route.content.view.kind === "work") { desk.conversation(session, work, opened); return; }
    const reveal = route.reveal;
    desk.navigate(route.content, reveal || opened ? () => { if (reveal) desk.reveal(reveal.artifactId, { sessionId: reveal.sessionId }); opened?.(); } : undefined);
  };
  return {
    open: (session: Session) => open(session),
    /** As `open`, then `opened` once the pane shows the conversation (an 알림 goes on to its item from there). */
    openThen: (session: Session, opened: () => void) => open(session, undefined, opened),
    byId: (sessionId: string) => { const session = desk.find(sessionId); if (session) open(session); },
    select: (work: { id: string }, session: Session) => open(session, work),
    documentRow: (_artifact: { id: string }, agent: Session) => open(agent),
  };
}

export type RestorePlan =
  | { kind: "none" }
  /** Its read-only tab becomes the document (its document is open nowhere else). */
  | { kind: "replace"; tabId: string; paneId: PaneId; shown: boolean; content: PaneContent<RouteView> }
  /** Its document is open in another tab: go there with it (when it was on screen), and its read-only tab closes. */
  | { kind: "move"; tabId: string; paneId: PaneId; shown: boolean; content: PaneContent<RouteView> };

/**
 * A document AI that came back to life (되돌리기, or its document restored) while a tab showed it
 * as a read-only conversation: that tab must not fall through to another conversation of the project.
 */
export function restoredAgentPlan<V>(layout: Layout<V>, session: Session, hasDocument: (artifactId: string) => boolean): RestorePlan {
  const route = sessionRoute(session, hasDocument);
  const holder = findTab(layout, `session:${session.id}`);
  if (!holder || !route.reveal) return { kind: "none" };
  const shown = activeTab(holder.pane).id === holder.tab.id;
  const elsewhere = findTab(layout, `doc:${route.reveal.artifactId}`);
  return { kind: elsewhere ? "move" : "replace", tabId: holder.tab.id, paneId: holder.pane.id, shown, content: route.content };
}

/**
 * Why 되돌리기 is refused for an archived conversation (null: it is not). An archived document AI
 * whose document was removed is refused by the gateway (409 document_removed) until the document is back.
 */
export const restoreRefusal = (session: Session, hasDocument: (artifactId: string) => boolean): string | null =>
  session.documentAgent && !hasDocument(session.documentAgent.artifactId) ? "문서를 먼저 되돌려 주세요" : null;
