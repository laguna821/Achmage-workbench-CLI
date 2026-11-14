import { besideOf, oneViewPerDocument, keepCompanions, leavesView, releaseViews, viewDocument, viewsToRelease, withoutCompanion, type Companion } from "./companion.ts";
import type { EditorState } from "./doc-editors.ts";
import type { LeaveGate } from "./leave-gate.ts";
import { paneById, setPane, type Layout, type PaneContent, type PaneId } from "./panes.ts";
import { activeTab, addBackgroundTab, contentKey, findTab, tabsOf, withTabs } from "./tabs.ts";

// The app's side of 곁 화면: how a view is left, shown, put beside a conversation and closed.
// Plain functions over the layout the app lends (no React), so the rules are tested with real
// panes and tabs and stand-in views.
//
// The rules, each a review ruling:
// - Nothing saves or closes a document's other view by itself. Asked for where it already has a
//   view (a card, a 연결 row, the navigator), the app goes to that view.
// - Moving a document (beside a conversation, or to a tab of its own) is the person's explicit
//   act. If the view that goes holds an editor with edits, or one that cannot tell, the person is
//   asked first and can cancel; nothing is flushed before the answer.
// - A web page has no edits: it only changes place, and never stops running by being moved.

/** Every layout change settles the same way: a conversation gone to again keeps its companion, and a document never has two views. */
export const settleLayout = <V>(changed: Layout<V>, previous: Layout<V>): Layout<V> => oneViewPerDocument(withTabs(keepCompanions(changed), previous));

export type DeskDeps<V> = {
  layout: () => Layout<V>;
  /** Apply a layout change (the app settles it with `settleLayout`). */
  update: (change: (layout: Layout<V>) => Layout<V>) => void;
  /** The leave guard a tab's view registered: it saves what only that view can save. */
  guard: (tabId: string) => ((reason?: LeaveReason) => Promise<void>) | undefined;
  gate: LeaveGate;
  /** Bring a tab to the front (through the leave of what its pane shows now); `then` once it is. */
  select: (paneId: PaneId, tabId: string, then?: () => void) => void;
  /** What each open view of a document says about unsaved edits (doc-editors.ts). */
  editors: (artifactId: string) => EditorState[];
  /** The app's own comparison: every editor that reports edits holds the text of the saved revision. Information only. */
  looksSaved: (artifactId: string) => boolean;
  /**
   * "저장하지 않은 내용이 있습니다": the person answers. 저장하고 옮기기 runs `go`, 저장하지 않고
   * 옮기기 runs `drop` (what the editor holds unsaved is dropped, the file is left as it is); the
   * app shows that it is working until either settles. 취소 runs nothing. `same` only informs.
   */
  ask: (artifactId: string, said: { certain: boolean; same: boolean }, go: () => Promise<void>, drop: () => Promise<void>) => void;
  /** The tab's conversation is covered by its companion (no room for both). */
  covered: (tabId: string) => boolean;
  /** A navigation started (the start-up restore of the stored layout keeps what was chosen). */
  onNavigate?: () => void;
  fail: (error: unknown) => void;
  /** What a pane shows when its last tab closes. */
  home: PaneContent<V>;
  /** A conversation's view with `beside` next to it. */
  conversation: (beside: Companion) => V;
  /** A web page as a tab of its own (null: the page is gone). */
  page: (pageId: string) => PaneContent<V> | null;
};

/** Why a view is left: `close` (its tab closes: save first), `discard` (its tab closes on the person's 저장하지 않고 옮기기: nothing is saved). */
export type LeaveReason = "close" | "discard";

export type LeaveOptions = {
  /** Told when the leave is refused (a view could not save), besides the app's notice. */
  failed?: (error: unknown) => void;
  /** The tab that will show the view (null: a new one). A tab shown again lets nothing go. */
  destination?: string | null;
  /** The person asked to move the document: its other view saves (after the question) and closes. */
  move?: boolean;
  /** Where the app goes to the document's existing view instead (no `then`): told once it is in front. */
  redirected?: () => void;
};

export function createDesk<V extends { kind: string }>(deps: DeskDeps<V>) {
  /**
   * `then`, once the pane's view has saved what only it can save (when `next` takes it away), and
   * — for an explicit move — once the document's other view has saved and closed. Without `move`,
   * a document that already has a view elsewhere is not opened again: the app goes to that view
   * and `then` does not run.
   */
  const leave = (paneId: PaneId, next: V | null, then: () => void, { destination = null, move = false, redirected, failed }: LeaveOptions = {}) => {
    deps.onNavigate?.();
    const layout = deps.layout();
    const pane = paneById(layout, paneId);
    const shown = pane ? activeTab(pane).id : null;
    const others = viewsToRelease(layout, destination, next);
    if (others.documents.length && !move) {
      const holder = others.documents.find((entry) => !entry.beside) ?? others.documents[0]!;
      deps.select(holder.paneId, holder.tabId, redirected);
      return;
    }
    // The tab on screen saves when its view goes — unless it is one of those closing, which saves as it closes.
    const own = pane && shown && leavesView(pane, next) && !others.documents.some((holder) => holder.tabId === shown) ? deps.guard(shown) : undefined;
    // `keep`: the other views save as they close; else (저장하지 않고 옮기기) they close without saving.
    const guardsFor = (keep: boolean) => [own ? () => own() : null, ...others.documents.map((holder) => { const guard = deps.guard(holder.tabId); return guard ? () => guard(holder.beside ? undefined : keep ? "close" : "discard") : null; })]
      .filter((guard): guard is () => Promise<void> => guard !== null);
    const release = [...others.documents, ...others.pages];
    const run = (keep = true) => {
      const guards = guardsFor(keep);
      // One promise for the saving: the gate waits on it, and so does whoever shows that it is going on.
      const saving = guards.length ? (async () => { for (const guard of guards) await guard(); })() : null;
      deps.gate.run(paneId, saving ? () => saving : null, () => {
        if (release.length) deps.update((current) => releaseViews(current, release, deps.home));
        then();
      }, (error) => { deps.fail(error); failed?.(error); }, [shown ?? paneId, ...others.documents.map((holder) => holder.tabId)].join("+"));
      return saving ? saving.then(() => undefined, () => undefined) : Promise.resolve();
    };
    const artifactId = viewDocument(next);
    const states = artifactId && others.documents.length ? deps.editors(artifactId) : [];
    if (states.some((state) => state !== false)) deps.ask(artifactId!, { certain: states.includes(true), same: deps.looksSaved(artifactId!) }, () => run(true), () => run(false));
    else void run();
  };

  /** Show `content` in the pane that already has it in a tab, else in `paneId`. */
  const show = (paneId: PaneId, content: PaneContent<V>, options: { move?: boolean; then?: () => void; failed?: (error: unknown) => void } = {}) => {
    const existing = findTab(deps.layout(), contentKey(content));
    const target = existing?.pane.id ?? paneId;
    leave(target, content.view, () => {
      deps.update((current) => ({ ...setPane(current, target, content), focus: target }));
      options.then?.();
    }, { destination: existing?.tab.id ?? null, move: options.move, redirected: options.then, failed: options.failed });
  };

  /**
   * A document or web page beside the conversation `paneId` shows. False: that pane shows no
   * conversation. A document that has a view elsewhere is gone to instead, unless `move`.
   */
  const openBeside = (paneId: PaneId, beside: Companion, options: { move?: boolean; then?: () => void } = {}): boolean => {
    const pane = paneById(deps.layout(), paneId);
    if (!pane || pane.view.kind !== "work") return false;
    const now = besideOf(pane.view);
    if (now && now.kind === beside.kind && (now.kind === "document" ? now.artifactId === (beside as typeof now).artifactId && now.proposalId === (beside as typeof now).proposalId : now.pageId === (beside as typeof now).pageId)) return true;
    show(paneId, { workId: pane.workId, sessionId: pane.sessionId, view: deps.conversation(beside) }, options);
    return true;
  };

  /** Put a document beside the conversation `at` (the person's "대화 옆에"): its tab saves, after the question, and closes. */
  const moveBeside = (paneId: PaneId, at: Pick<PaneContent<V>, "workId" | "sessionId">, beside: Companion, then?: () => void) =>
    show(paneId, { ...at, view: deps.conversation(beside) }, { move: true, then });

  /** Close what is beside a conversation. A web page stays listed as a tab of its own behind the conversation: it keeps running. */
  const closeBeside = (paneId: PaneId, tabId: string) => {
    const tab = deps.layout().panes.flatMap(tabsOf).find((entry) => entry.id === tabId);
    const beside = tab ? besideOf(tab.view) : null;
    if (!beside) return;
    const guard = deps.guard(tabId);
    const page = beside.kind === "browser" ? deps.page(beside.pageId) : null;
    deps.gate.run(paneId, guard ? () => guard() : null, () => deps.update((current) => {
      const closed = withoutCompanion(current, tabId);
      return page ? addBackgroundTab(closed, paneId, page) : closed;
    }), deps.fail, tabId);
  };

  /**
   * Office control (the engine editing for the person who asked): an editable view of the document.
   * A tab of its own is brought to the front and `done` at once. Beside a conversation the document
   * is only read, so its own tab is opened: that read view holds nothing unsaved and takes no
   * writer lease, so this does not go through the move question. The conversation keeps its place.
   */
  const edit = (paneId: PaneId, content: PaneContent<V>, done: () => void, failed?: (error: unknown) => void) => {
    const own = findTab(deps.layout(), contentKey(content));
    if (own) { deps.select(own.pane.id, own.tab.id); done(); return; }
    // A view that cannot be left (its save failed) refuses at once, instead of the gateway's wait.
    show(paneId, content, { move: true, then: done, failed });
  };

  /** Go to a conversation (its row names it): where its companion lies over it, the conversation is brought back. */
  const conversation = (paneId: PaneId, content: PaneContent<V>, then?: () => void) =>
    show(paneId, content, { then: () => {
      const tab = findTab(deps.layout(), contentKey(content));
      if (tab && besideOf(tab.tab.view) && deps.covered(tab.tab.id)) closeBeside(tab.pane.id, tab.tab.id);
      then?.();
    } });

  return { leave, show, openBeside, moveBeside, closeBeside, edit, conversation };
}

export type Desk<V extends { kind: string }> = ReturnType<typeof createDesk<V>>;
