import { isUnseen, type Artifact, type BrowserPage, type Session } from "@workbench/contracts";
import { statusText, statusTone, type Tone } from "./format.ts";
import { MIN_PANE, type Layout, type PaneContent, type PaneId } from "./panes.ts";
import type { State } from "./state.ts";
import { activeTab, closeTab, contentKey, tabsOf, updateTabView } from "./tabs.ts";
import { EDITOR_MIN_WIDTH, EDITOR_PANEL_WIDTH, READ_PAGE_MIN_WIDTH } from "./components/docs/document-modes.ts";

// 곁 화면 (companion): a document or web page beside its conversation, inside that conversation's
// tab. The conversation is the tab's identity and keeps its place and its input; what is beside it
// is part of the tab's view. A document has one view at a time: a tab of its own, or one
// conversation's companion.

export type Companion =
  | { kind: "document"; artifactId: string; proposalId: string | null }
  | { kind: "browser"; pageId: string };

type Viewish = { kind: string; artifactId?: unknown; pageId?: unknown; beside?: unknown };

export function isCompanion(value: unknown): value is Companion {
  if (!value || typeof value !== "object") return false;
  const companion = value as Partial<Record<string, unknown>>;
  if (companion.kind === "document") return typeof companion.artifactId === "string" && (companion.proposalId === null || typeof companion.proposalId === "string");
  return companion.kind === "browser" && typeof companion.pageId === "string";
}

/** What a conversation's view has beside it. */
export const besideOf = (view: Viewish): Companion | null => (view.kind === "work" && isCompanion(view.beside) ? view.beside : null);

/** The document a view shows: its own tab's, or the conversation's companion. */
export function viewDocument(view: Viewish | null | undefined): string | null {
  if (!view) return null;
  if (view.kind === "document") return typeof view.artifactId === "string" ? view.artifactId : null;
  const beside = besideOf(view);
  return beside?.kind === "document" ? beside.artifactId : null;
}

/** The web page a view shows: its own tab's, or the conversation's companion. */
export function viewPage(view: Viewish | null | undefined): string | null {
  if (!view) return null;
  if (view.kind === "browser") return typeof view.pageId === "string" ? view.pageId : null;
  const beside = besideOf(view);
  return beside?.kind === "browser" ? beside.pageId : null;
}

/** One mounted view: the tab's identity and, for a conversation, what is beside it (not which proposal it compares). */
function instanceOf<V>(content: PaneContent<V>): string {
  const beside = besideOf(content.view as Viewish);
  return `${contentKey(content)}${beside ? `+${beside.kind === "document" ? `doc:${beside.artifactId}` : `page:${beside.pageId}`}` : ""}`;
}

/**
 * Whether going from what a tab shows to `next` takes a view away (its editor must save first).
 * A conversation that only gains a companion is not left; a companion closed, replaced, or made a
 * tab of its own is.
 */
export function leavesView<V>(current: PaneContent<V>, next: V | null): boolean {
  if (!next) return true;
  const before = instanceOf(current), after = instanceOf({ ...current, view: next });
  if (before === after) return false;
  return !(besideOf(current.view as Viewish) === null && after.startsWith(`${before}+`));
}

export type DocumentHolder = { paneId: PaneId; tabId: string; beside: boolean };

/** Every tab showing a document: tabs of its own (`beside: false`) and conversations it is beside. */
export function viewsOfDocument<V>(layout: Layout<V>, artifactId: string): DocumentHolder[] {
  return layout.panes.flatMap((pane) => tabsOf(pane)
    .filter((tab) => viewDocument(tab.view as Viewish) === artifactId)
    .map((tab) => ({ paneId: pane.id, tabId: tab.id, beside: (tab.view as Viewish).kind !== "document" })));
}

/** The same layout with one conversation tab's companion closed. */
export const withoutCompanion = <V>(layout: Layout<V>, tabId: string): Layout<V> =>
  updateTabView(layout, tabId, (view) => (besideOf(view as Viewish) ? ({ kind: "work" } as V) : view));

/**
 * A document has one view. Where a layout shows it twice, its own tab wins over a conversation's
 * companion, and between two conversations the one on screen (else the first) keeps it. The same
 * layout back when nothing is doubled.
 */
export function oneViewPerDocument<V>(layout: Layout<V>): Layout<V> {
  const beside = layout.panes.flatMap((pane) => tabsOf(pane).flatMap((tab) => {
    const companion = besideOf(tab.view as Viewish);
    return companion?.kind === "document" ? [{ tabId: tab.id, artifactId: companion.artifactId, shown: activeTab(pane).id === tab.id }] : [];
  }));
  if (!beside.length) return layout;
  const own = new Set(layout.panes.flatMap((pane) => tabsOf(pane).flatMap((tab) => ((tab.view as Viewish).kind === "document" && typeof (tab.view as Viewish).artifactId === "string" ? [(tab.view as Viewish).artifactId as string] : []))));
  const keeper = new Map<string, string>();
  for (const entry of [...beside].sort((a, b) => Number(b.shown) - Number(a.shown))) if (!own.has(entry.artifactId) && !keeper.has(entry.artifactId)) keeper.set(entry.artifactId, entry.tabId);
  let next = layout;
  for (const entry of beside) if (keeper.get(entry.artifactId) !== entry.tabId) next = withoutCompanion(next, entry.tabId);
  return next;
}

/** Every tab showing a web page: its own tab (`beside: false`) and conversations it is beside. */
export function viewsOfPage<V>(layout: Layout<V>, pageId: string): DocumentHolder[] {
  return layout.panes.flatMap((pane) => tabsOf(pane)
    .filter((tab) => viewPage(tab.view as Viewish) === pageId)
    .map((tab) => ({ paneId: pane.id, tabId: tab.id, beside: (tab.view as Viewish).kind !== "browser" })));
}

/**
 * The views that save and close before `next` is shown in tab `destination` (null: a new tab).
 * A document has one view, so its others go: a tab of its own, another conversation's companion.
 * A web page only changes place. A tab shown again (its own view handed back, or a conversation
 * gone to with a plain view) is not opened anew: nothing of it goes.
 */
export function viewsToRelease<V>(layout: Layout<V>, destination: string | null, next: V | null): { documents: DocumentHolder[]; pages: DocumentHolder[] } {
  const none = { documents: [], pages: [] };
  if (!next) return none;
  const others = (holders: DocumentHolder[]) => holders.filter((holder) => holder.tabId !== destination && layout.panes.flatMap(tabsOf).find((tab) => tab.id === holder.tabId)?.view !== next);
  const artifactId = viewDocument(next as unknown as Viewish), pageId = viewPage(next as unknown as Viewish);
  return { documents: artifactId ? others(viewsOfDocument(layout, artifactId)) : [], pages: pageId ? others(viewsOfPage(layout, pageId)) : [] };
}

/** The layout without those views: a companion closed in its conversation's tab, a tab of its own closed. */
export function releaseViews<V>(layout: Layout<V>, holders: DocumentHolder[], fallback: PaneContent<V>): Layout<V> {
  let next = layout;
  for (const holder of holders) next = holder.beside ? withoutCompanion(next, holder.tabId) : closeTab(next, holder.paneId, holder.tabId, fallback);
  return next;
}

/**
 * A conversation shown again keeps what is beside it. The app goes to a conversation with a plain
 * view (a sidebar row, a notice, Ctrl+Tab); where that pane's own tab for it has a companion, the
 * companion stays. Closing one is done on the tab (`withoutCompanion`), never by navigating.
 */
export function keepCompanions<V>(layout: Layout<V>): Layout<V> {
  let changed = false;
  const panes = layout.panes.map((pane) => {
    const view = pane.view as Viewish;
    if (view.kind !== "work" || besideOf(view) || !pane.tabs) return pane;
    const key = contentKey(pane);
    const own = pane.tabs.find((tab) => contentKey(tab) === key);
    if (!own || !besideOf(own.view as Viewish)) return pane;
    changed = true;
    return { ...pane, view: own.view };
  });
  return changed ? { ...layout, panes } : layout;
}

/** A view kept from an earlier version, as this one shows it. "나란히" was the document's own tab. */
export function legacyView(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const view = value as Viewish;
  if (view.kind === "split" && typeof view.artifactId === "string") return { kind: "document", artifactId: view.artifactId, proposalId: null };
  if (view.kind === "work" && "beside" in view && !isCompanion(view.beside)) return { kind: "work" };
  return value;
}

/** A layout as it was stored, with the views of an earlier version turned into this one's. */
export function upgradeStoredLayout(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { panes?: unknown }).panes)) return raw;
  const data = raw as { panes: unknown[] };
  const upgrade = <T,>(entry: T): T => (entry && typeof entry === "object" && "view" in entry ? { ...entry, view: legacyView((entry as { view: unknown }).view) } : entry);
  return { ...data, panes: data.panes.map((pane) => {
    const upgraded = upgrade(pane) as { tabs?: unknown };
    return upgraded && typeof upgraded === "object" && Array.isArray(upgraded.tabs) ? { ...upgraded, tabs: upgraded.tabs.map(upgrade) } : upgraded;
  }) };
}

// ── side by side, or laid over ───────────────────────────────────────────────────────────────

/** The conversation column's least width: a pane's (the input's controls stop fitting below it). */
export const CHAT_MIN = MIN_PANE;
/** The line between the two columns, and the handle to resize them. */
export const COLUMN_GAP = 7;
/** The room more it needs to come back beside once laid over (no flipping at the threshold). */
const HYSTERESIS = 16;

/**
 * The least width of a document beside a conversation column: a pane's for the app's own views; an
 * embedded editor's 680 and, while its own AI panel may be open (`panel`), that panel's 360 too —
 * otherwise the page's text would be squeezed between two panels.
 */
export const companionMinimum = ({ editing, panel = false }: { editing: boolean; panel?: boolean }) =>
  (editing ? EDITOR_MIN_WIDTH + (panel ? EDITOR_PANEL_WIDTH : 0) : MIN_PANE);

/** A document read beside a conversation: pages drawn to the column need their width; reflowing text a pane's. */
export const readMinimum = (format: Artifact["format"] | undefined) =>
  (format === "docx" || format === "pptx" || format === "xlsx" || format === "pdf" ? READ_PAGE_MIN_WIDTH : MIN_PANE);

export type BesideFit = { mode: "beside"; chat: number | null } | { mode: "over" };

/**
 * Two columns side by side only while both keep their minimum; otherwise one lies over the other
 * (never squeezed). `ratio`: the conversation's share. Unmeasured (0): beside, at the ratio.
 */
export function besideFit({ width, chatMin, contentMin, ratio, was }: { width: number; chatMin: number; contentMin: number; ratio: number; was: "beside" | "over" }): BesideFit {
  if (!width) return { mode: "beside", chat: null };
  const room = width - COLUMN_GAP;
  if (room < chatMin + contentMin + (was === "over" ? HYSTERESIS : 0)) return { mode: "over" };
  return { mode: "beside", chat: Math.max(chatMin, Math.min(room - contentMin, Math.round(room * ratio))) };
}

export const clampRatio = (ratio: number) => Math.min(0.7, Math.max(0.2, ratio));

// ── what the main conversation is told of its documents' and pages' AIs ──────────────────────

/** `last`: the first line of that AI's latest finished reply, while it is not at work on another. */
export type ChildLine = { session: Session; kind: "document" | "web"; name: string; state: string; tone: Tone; last: string | null };

const LAST_LENGTH = 80;
/** One line of a reply's own words: its first line with text, without Markdown's lead marks. */
function firstWords(text: string): string | null {
  const line = text.split("\n").map((entry) => entry.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").trim()).find(Boolean);
  if (!line) return null;
  return line.length > LAST_LENGTH ? `${line.slice(0, LAST_LENGTH)}…` : line;
}

/**
 * The AIs working for a conversation (a document's, a web tab's), one line each, only while there
 * is something to say: a proposal waiting or being made, an answer in progress, an approval
 * waiting, an error, a new answer — and what it last did, from the reply the gateway keeps on
 * every session (`preview`; `activity` is the state while it works). Nothing is asked for.
 */
export function childWork(state: State, parent: Session, pages: BrowserPage[]): ChildLine[] {
  const lines: ChildLine[] = [];
  for (const session of Object.values(state.sessions)) {
    if (session.archivedAt) continue;
    const document = session.documentAgent?.parentSessionId === parent.id ? state.artifacts[session.documentAgent.artifactId] : undefined;
    const page = session.pageAgent?.parentSessionId === parent.id ? session.pageAgent : undefined;
    if (!document && !page) continue;
    const proposals = Object.values(state.proposals).filter((proposal) => proposal.sessionId === session.id && (proposal.status === "pending" || proposal.status === "running"));
    const tone = statusTone(session);
    const said: string[] = [];
    if (proposals.length) said.push(`수정안 ${proposals.length}건`);
    if (tone !== "idle") said.push(statusText(session));
    else if (proposals.some((proposal) => proposal.status === "pending")) said.push("확인 기다림");
    else if (isUnseen(session)) said.push("새 답");
    if (!said.length) continue;
    const shown = page ? pages.find((entry) => entry.pageId === page.pageId) : undefined;
    lines.push({
      session,
      kind: document ? "document" : "web",
      name: document ? document.name : shown?.title || shown?.url || session.purpose,
      state: said.join(" · "),
      tone: tone === "idle" && proposals.length ? "attention" : tone,
      // At work or waiting on an approval, its earlier reply is not this turn's: it is left out.
      last: (tone === "idle" || tone === "error") && session.preview ? firstWords(session.preview) : null,
    });
  }
  return lines.sort((a, b) => a.session.createdAt - b.session.createdAt || a.session.id.localeCompare(b.session.id));
}
