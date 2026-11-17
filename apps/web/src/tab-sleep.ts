import { createContext, useContext, useEffect } from "react";
import type { BrowserPage, Proposal, Session } from "@workbench/contracts";
import { viewDocument, viewPage } from "./companion.ts";
import type { Layout, PaneTab } from "./panes.ts";
import { activeTab, projectOfTab, scopeOf, showsWeb, tabsOf } from "./tabs.ts";

// Tab sleep (0.5.1; the owner, 2026-11-16: "그 탭을 보고있지 않으면 다시 볼때까지 프리징되서 램 안먹는"). A tab's view is
// mounted the first time it is shown and, until now, stayed mounted (hidden) until its tab closed. A tab that has been
// off screen for ten minutes now goes to sleep: its view is unmounted — the editor frame, the conversation's rows —
// and the tab stays on its strip as it was. Showing it again mounts it again (the path a tab restored at start takes).
// Nothing is lost by it: a view holding unsaved edits is asked to save first, through the leave path its tab uses when
// a person leaves it, and sleeps only once its editor says saved; whatever is at work, or cannot be told, stays awake.
// A web page sleeps as a browser discards a background tab: its native page is released first (the gateway keeps its
// record), and the tab shown again loads its last address in the same profile — what was typed into a form on it is
// gone, as in a browser. Never while an AI is using the page.
// `sleepPlan` decides; Panes.tsx applies it on one timer.

/** How long a tab is off screen before it sleeps — and how long a refused save waits before it is asked again. */
export const TAB_SLEEP_MS = 10 * 60_000;
/** The most recently shown tabs of the project on screen that never sleep (going back and forth between them is never slowed). */
export const AWAKE_RECENT = 6;

/** How long a save before sleeping may take (the slowest editor answers its own save within a minute); no answer by then: the view stays. */
export const SLEEP_SAVE_WAIT_MS = 90_000;

/** The time in use: the rig's shorter one (`window.__workbenchTabSleepMs`, set by a test before the app loads), else the default. */
export function tabSleepAfter(): number {
  const given = (globalThis as { __workbenchTabSleepMs?: unknown }).__workbenchTabSleepMs;
  return typeof given === "number" && given > 0 ? given : TAB_SLEEP_MS;
}

export type SleepInput<V> = {
  layout: Layout<V>;
  /** The layout as drawn (tabs.ts `drawnLayout`): the tab in front of each of ITS panes is on screen. Not given: every pane is drawn. */
  drawn?: Layout<V>;
  /** The tabs whose view is mounted. */
  mounted: ReadonlySet<string>;
  now: number;
  /** When each tab was last on screen (a tab on screen: now). */
  shownAt: ReadonlyMap<string, number>;
  /** The keeper (tabs.ts `setTabKeeper`): the tab holds unsaved edits — an editor that cannot tell counts as unsaved. */
  unsaved: (tab: PaneTab<V>) => boolean;
  /** Something is at work in the tab, or it holds what only its view keeps (`tabAtWork`, `useKeepAwake`); unsure: true. */
  atWork: (tab: PaneTab<V>) => boolean;
  /** When each tab was last asked for what comes before sleeping (its editor to save, its web page to be released). */
  askedAt?: ReadonlyMap<string, number>;
  /** Tabs for which that has just been done (the editor answered "saved", the page was released): they may sleep now. */
  saved?: ReadonlySet<string>;
  /** The time off screen (default `TAB_SLEEP_MS`). */
  after?: number;
};
/**
 * `sleep`: unmount these views now. `ask`: these are due, but something comes first — unsaved edits: their editor is
 * asked to save; a web page: its native page is released — and then it is decided again.
 */
export type SleepPlan = { sleep: string[]; ask: string[] };

/**
 * The one decision. A mounted tab is due when ALL hold: it is not on screen in any pane; it has been off screen for
 * `after`; nothing is at work in it (`atWork`: for a web page, no AI is using it — `pageInUse`); it is not one of the
 * `AWAKE_RECENT` most recently shown tabs of the project on screen. A due tab with nothing to do first sleeps. A due
 * tab WITH unsaved edits (or an editor that cannot tell), and a due web page, never sleep as they are: they are listed
 * to be asked first — the editor to save, the page to be released; at most once per `after` — and sleep only when
 * given back as `saved` with every other clause still holding.
 */
export function sleepPlan<V>({ layout, drawn = layout, mounted, now, shownAt, unsaved, atWork, askedAt, saved, after = TAB_SLEEP_MS }: SleepInput<V>): SleepPlan {
  const onScreen = new Set(drawn.panes.map((pane) => activeTab(pane).id));
  const tabs = layout.panes.flatMap(tabsOf);
  const project = scopeOf(layout);
  const lastShown = (tab: PaneTab<V>) => (onScreen.has(tab.id) ? now : shownAt.get(tab.id));
  const recent = new Set(project === null ? [] : tabs
    .filter((tab) => projectOfTab(tab) === project && lastShown(tab) !== undefined)
    .sort((a, b) => lastShown(b)! - lastShown(a)!)
    .slice(0, AWAKE_RECENT).map((tab) => tab.id));
  const plan: SleepPlan = { sleep: [], ask: [] };
  for (const tab of tabs) {
    if (!mounted.has(tab.id) || onScreen.has(tab.id) || recent.has(tab.id)) continue;
    const shown = shownAt.get(tab.id);
    if (shown === undefined || now - shown < after) continue;
    if (atWork(tab)) continue;
    if (saved?.has(tab.id) || !(showsWeb(tab.view) || unsaved(tab))) plan.sleep.push(tab.id);
    else if (now - (askedAt?.get(tab.id) ?? -Infinity) >= after) plan.ask.push(tab.id);
  }
  return plan;
}

/**
 * What the app knows of work going on: its conversations and the proposals being made (state.ts); and of its web
 * pages (browser-state.ts): the pages, those held open for their AI, those with an action whose result is not in.
 */
export type SleepWorld = { sessions: Record<string, Session>; proposals: Record<string, Proposal>; pages?: BrowserPage[]; heldPageIds?: string[]; pending?: Record<string, unknown> };
const working = (session: Session) => session.status !== "idle" && session.status !== "error";

/**
 * The web pages' own, stricter clauses: whether a page must stay as it is. An AI using the page ALWAYS keeps it — its
 * web AI conversation answering, waiting or stopping; the AI holding the page; an agent's own page (the agent comes
 * back to it without its tab being shown); a page held open for its AI; an action on it without a result. So does what
 * the app can see the page doing: a download on its way or waiting for an answer, a permission question, a window it
 * opened. What the app cannot see — sound or a video playing, the camera or microphone in use, text typed into a form
 * — is not a reason. A page the app does not know, or one still opening: unsure, so yes. One with no native page
 * (not connected, closed): nothing is held, no.
 */
export function pageInUse(pageId: string, world: SleepWorld): boolean {
  const page = world.pages?.find((entry) => entry.pageId === pageId);
  if (!page || page.status === "opening") return true;
  if (page.status !== "ready") return false;
  if (page.agentSessionId || page.control.owner !== "human") return true;
  if (world.heldPageIds?.includes(pageId) || world.pending?.[pageId]) return true;
  if (Object.values(world.sessions).some((session) => working(session) && (session.id === page.sessionId || session.pageAgent?.pageId === pageId))) return true;
  const native = page.native;
  return Boolean(native?.downloads?.some((download) => ["blocked", "downloading", "cancelling", "checking"].includes(download.status))
    || native?.permissions?.some((request) => request.status === "pending" || request.status === "native-prompt")
    || native?.popups?.length);
}

/**
 * Whether something is at work in a tab, as far as the app's state says; unsure counts as yes. Only a conversation,
 * a document and a web page are known to come back (the conversation from the gateway at its reading place, the
 * document from its file, the page from its address): every other kind of tab — a terminal, a project's page, a
 * presentation, home — stays awake. A conversation: it is answering, waiting for an approval or stopping, or an AI it
 * started (a document's, a web page's) is. A document, in its own tab or beside a conversation: an AI of it is at
 * work, or a proposal for it is being made. A web page, in its own tab or beside a conversation: `pageInUse`.
 */
export function tabAtWork<V>(tab: PaneTab<V>, world: SleepWorld): boolean {
  const view = tab.view as { kind?: string };
  if ((view.kind !== "work" && view.kind !== "document" && view.kind !== "browser") || !tab.workId) return true;
  const pageId = viewPage(tab.view as { kind: string });
  if (pageId && pageInUse(pageId, world)) return true;
  const artifactId = viewDocument(tab.view as { kind: string });
  const sessions = Object.values(world.sessions);
  if (view.kind === "work") {
    const named = tab.sessionId ? world.sessions[tab.sessionId] : undefined;
    if (tab.sessionId && !named) return true;
    // A tab that names no conversation of its project shows the project's active one — whichever that is: any of the project's at work counts.
    const own = named && named.workId === tab.workId ? named : undefined;
    if (sessions.some((session) => working(session) && (own
      ? session.id === own.id || session.documentAgent?.parentSessionId === own.id || session.pageAgent?.parentSessionId === own.id
      : session.workId === tab.workId))) return true;
  }
  if (artifactId) {
    if (sessions.some((session) => working(session) && session.documentAgent?.artifactId === artifactId)) return true;
    if (Object.values(world.proposals).some((proposal) => proposal.artifactId === artifactId && proposal.status === "running")) return true;
  }
  return false;
}

// What only a mounted view knows it holds (documents pinned to the next request, an open drawing): the view says so
// with `useKeepAwake`, and its tab stays awake while it does.
const held = new Map<string, number>();
/** The tab a view is drawn in (Panes.tsx sets it). */
export const SleepTab = createContext<string | null>(null);
/** While `hold`, the tab this view is in does not sleep. */
export function useKeepAwake(hold: boolean) {
  const tabId = useContext(SleepTab);
  useEffect(() => {
    if (!tabId || !hold) return;
    held.set(tabId, (held.get(tabId) ?? 0) + 1);
    return () => { const left = (held.get(tabId) ?? 1) - 1; if (left > 0) held.set(tabId, left); else held.delete(tabId); };
  }, [tabId, hold]);
}
export const heldAwake = (tabId: string) => held.has(tabId);

// A document tab closed while its 문서 AI turn runs live in its editor (office-ai-live, coordinator's gate 1): the view
// says so with `useKeepOnClose`, and Panes.tsx keeps the closed tab's view mounted off screen — exactly as a hidden tab's
// — until it lets go (the turn ended, however it ended). `TabClosed` tells that view it is being kept so.
const kept = new Map<string, number>();
const keptListeners = new Set<() => void>();
const keptChanged = () => { for (const listener of [...keptListeners]) listener(); };
/** Whether the view in this tab must outlive the tab's closing for now. */
export const keptOnClose = (tabId: string) => kept.has(tabId);
export function onKeptOnClose(listener: () => void) { keptListeners.add(listener); return () => { keptListeners.delete(listener); }; }
/** The view of a closed tab, kept until it lets go (Panes.tsx). */
export const TabClosed = createContext(false);
/** While `hold`, closing this view's tab keeps the view mounted off screen until `hold` ends. */
export function useKeepOnClose(hold: boolean) {
  const tabId = useContext(SleepTab);
  useEffect(() => {
    if (!tabId || !hold) return;
    kept.set(tabId, (kept.get(tabId) ?? 0) + 1); keptChanged();
    return () => { const left = (kept.get(tabId) ?? 1) - 1; if (left > 0) kept.set(tabId, left); else kept.delete(tabId); keptChanged(); };
  }, [tabId, hold]);
}
