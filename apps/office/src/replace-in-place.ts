/**
 * A new revision taken by the RUNNING editor (brief office-ai-live, point 3): the window asks
 * (office:replace) only after this page said it can (office:replace-ready); the page loads the revision
 * into its editor, keeps the view where it was, and answers. 0.5.2 rebooted the whole page instead
 * (iframe remounted: Word ≈ 0.65–1.4 s, PowerPoint ≈ 2 s in WebKitGTK, the view back at the top).
 *
 * - Unsaved edits are never replaced: the editor is asked right before; dirty → answered `dirty` (the
 *   window keeps them and shows the existing conflict).
 * - While this page still follows the 문서 AI's executor turn, the replacement waits for that turn's end
 *   (at most a few seconds), so the panel does not lose the turn it is drawing.
 * - After the 문서 AI's edit, one brief line: "문서 AI가 고친 내용을 반영했습니다 · 되돌리기" (되돌리기 makes the
 *   revision before it the newest again, through the window: the editors' own undo history does not
 *   survive a document load).
 */
import type { OfficeHostMessage } from "@workbench/contracts";
import { listen, post } from "./bridge.ts";
import { onTurnActivity } from "./turn-activity.ts";
import { ensureHoldStyle } from "./editor-hold.ts";

export const APPLIED_WORDS = { applied: "문서 AI가 고친 내용을 반영했습니다", revert: "되돌리기" } as const;
export const APPLIED_LINE_MS = 12_000;
/** How long after its turn's end a new revision still counts as the 문서 AI's. */
const AI_RECENT_MS = 120_000;
const TURN_WAIT_MS = 4_000;

type Replace = Extract<OfficeHostMessage, { type: "office:replace" }>;
export type InPlaceEditor = {
  /** Whether the editor has unsaved edits right now (its own check). */
  dirty(): Promise<boolean>;
  /** Load this revision into the running editor and put the view back; reject when it cannot. */
  replace(revision: number): Promise<void>;
};

/** The rig's knob (office-ai.ts runsLiveHere): "0.5.2" answers failed, so the window reopens the page as 0.5.2 did. */
const measuring052 = () => { try { return localStorage.getItem("workbench.check.office-ai") === "0.5.2"; } catch { return false; } };

export function installInPlaceReplace(editor: InPlaceEditor, options: { doc?: Document; lineMs?: number; turnWaitMs?: number } = {}) {
  const doc = options.doc ?? document, view = doc.defaultView!;
  let following = false, aiUntil = 0;
  const offActivity = onTurnActivity((event) => {
    if (event.kind === "remote" || (event.kind === "observed" && event.turnId)) { following = true; aiUntil = Infinity; }
    // A new turn: the last one's "반영했습니다" line gives way (the hold line sits in the same place).
    else if (event.kind === "start") { aiUntil = Infinity; hideLine(); }
    else if (event.kind === "end" || (event.kind === "observed" && !event.turnId)) { following = false; aiUntil = Date.now() + AI_RECENT_MS; }
  });
  const waitTurn = async () => {
    const end = Date.now() + (options.turnWaitMs ?? TURN_WAIT_MS);
    while (following && Date.now() < end) await new Promise((resolve) => view.setTimeout(resolve, 100));
  };
  let line: HTMLDivElement | null = null, lineTimer: number | undefined;
  const hideLine = () => { view.clearTimeout(lineTimer); line?.remove(); line = null; };
  const showLine = (revision: number, before: number) => {
    hideLine();
    ensureHoldStyle(doc);
    line = doc.createElement("div");
    line.className = "wb-ai-hold wb-ai-applied"; line.setAttribute("role", "status"); line.setAttribute("aria-live", "polite");
    const text = doc.createElement("span"); text.textContent = APPLIED_WORDS.applied;
    const revert = doc.createElement("button"); revert.type = "button"; revert.textContent = APPLIED_WORDS.revert;
    revert.onclick = () => { hideLine(); post({ type: "office:revert-ai", revision, before }); };
    line.append(text, revert);
    doc.body.append(line);
    lineTimer = view.setTimeout(hideLine, options.lineMs ?? APPLIED_LINE_MS);
  };
  let queue = Promise.resolve();
  const handle = async (message: Replace) => {
    await waitTurn();
    try {
      if (measuring052()) throw new Error("0.5.2");
      if (await editor.dirty()) { post({ type: "office:replace-result", revision: message.revision, ok: false, reason: "dirty" }); return; }
      await editor.replace(message.revision);
    } catch {
      post({ type: "office:replace-result", revision: message.revision, ok: false, reason: "failed" });
      return;
    }
    // For the rig: the revision this page took in place (office-ai-live-check's hidden-tab cases).
    (view as unknown as { __workbenchReplaced?: number }).__workbenchReplaced = message.revision;
    post({ type: "office:opened", revision: message.revision, recovered: false });
    post({ type: "office:replace-result", revision: message.revision, ok: true });
    if (Date.now() < aiUntil) showLine(message.revision, message.before);
  };
  const stop = listen((message) => {
    if (message.type === "office:replace") queue = queue.then(() => handle(message));
  });
  post({ type: "office:replace-ready" });
  return { dispose() { stop(); offActivity(); hideLine(); }, settled: () => queue };
}

/** The view of a scrolling element, put back after its content was replaced (it may grow in phases). */
export async function keepScroll(element: () => HTMLElement | null, work: () => Promise<void>, view: Window = window, settleMs = 2_000) {
  const before = element();
  const top = before?.scrollTop ?? 0, left = before?.scrollLeft ?? 0;
  await work();
  const end = Date.now() + settleMs;
  while (Date.now() < end) {
    const now = element();
    if (now) { now.scrollTop = top; now.scrollLeft = left; if (Math.abs(now.scrollTop - top) <= 1) return true; }
    await new Promise((resolve) => view.setTimeout(resolve, 50));
  }
  return false;
}
