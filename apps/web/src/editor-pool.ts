import type { DocFormat, OfficeEditorKind } from "@workbench/contracts";

// The editor pool (0.5.4; the owner, 2026-11-16: "엔진은 용량을 공용으로 먹으면서 안에 작업 내용이나 AI 문서 지시 내용 등등만
// 따로"). Until 0.5.3 every document tab had its own editor frame — ten Word tabs, ten Word editors. Now, per KIND of editor,
// the documents share frames: a frame holds the document on screen; a document that is not on screen holds no editor, only
// its state (its unsaved edits as the editor's own serialised copy in the recovery store, its view place, its 문서 AI
// draft — all kept by its tab already) and its page picture. Showing it again opens it IN PLACE in a running editor of its
// kind (office:park → office:swap), never a new one unless two of that kind are on screen at once (two panes, two windows)
// or one is pinned (a 문서 AI turn running live in it, an output or a copy on its way).
//
// This file is the bookkeeping only (which frame holds which document, K by what is on screen, park before a swap, the
// per-kind switch); apps/web/src/components/EditorPoolLayer.tsx draws the frames and OfficeEditor.tsx speaks to the page.

/** The kinds proven to keep every guarantee (ux/reports/editor-pool-report.md): the others keep one frame per tab. */
export const POOLED_KINDS: ReadonlySet<OfficeEditorKind> = new Set<OfficeEditorKind>(["docs", "slides", "sheets"]);
/** The kinds whose page can take another document in place at all (the rest never pool, whatever a switch says). */
const SWAPPING_KINDS: ReadonlySet<OfficeEditorKind> = new Set<OfficeEditorKind>(["docs", "slides", "sheets"]);

const KIND_OF: Partial<Record<DocFormat, OfficeEditorKind>> = { docx: "docs", pptx: "slides", xlsx: "sheets", hwp: "hwp", hwpx: "hwp", markdown: "markdown", html: "html", pdf: "pdf" };

/**
 * The pool kind of a document's editor, or null: it keeps its own frame per tab. `workbench.pool.<kind>` ("on" / "off")
 * turns a proven kind off (the rigs' before/after) — or on, for a kind whose page can swap but is not proven yet.
 */
export function poolKindOf(format: DocFormat | undefined, storage: Pick<Storage, "getItem"> | null = safeStorage()): OfficeEditorKind | null {
  // 설정 › 문서 도구: the person's master switch (off = one editor per tab for every kind).
  if (!readEditorPool(storage)) return null;
  const kind = format ? KIND_OF[format] : undefined;
  if (!kind || !SWAPPING_KINDS.has(kind)) return null;
  let override: string | null = null;
  try { override = storage?.getItem(`workbench.pool.${kind}`) ?? null; } catch { /* storage unavailable */ }
  if (override === "off") return null;
  return override === "on" || POOLED_KINDS.has(kind) ? kind : null;
}
/** 설정 › 문서 도구 › 「같은 종류 문서는 편집기 함께 쓰기」: on unless the person turned it off (this device). */
export const EDITOR_POOL_KEY = "workbench.editorPool";
export const EDITOR_POOL_LABEL = "같은 종류 문서는 편집기 함께 쓰기";
export const EDITOR_POOL_HINT = "워드·파워포인트·엑셀 탭이 종류마다 편집기 하나를 함께 써서 메모리를 아낍니다. 한동안 보지 않은 문서는 다시 볼 때 되돌리기 기록이 비워집니다.";
export function readEditorPool(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try { return storage?.getItem(EDITOR_POOL_KEY) !== "off"; } catch { return true; }
}
/** Takes effect for tabs opened afterwards (editors already open keep how they were opened). */
export function writeEditorPool(on: boolean) {
  try { localStorage.setItem(EDITOR_POOL_KEY, on ? "on" : "off"); } catch { /* storage refused */ }
  window.dispatchEvent(new Event("workbench:editor-pool"));
}
function safeStorage() { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } }

/** A frame of the pool: `holder` — the document's editor that has it now (null: free); `swappable` — its page said office:swap-ready; `busy` — a park is on its way. */
export type PoolFrame = { id: string; kind: string; holder: string | null; swappable: boolean; busy: boolean };
/**
 * A document's editor as the pool sees it at one moment. `pinned`: it must keep its frame even off screen. `shownAt`: when
 * it was last on screen (the recent ones stay live). `dirty`: it holds unsaved edits (the last of the recent ones parked).
 */
export type PoolHolder = { id: string; kind: string; doc: string; visible: boolean; pinned: boolean; frame: string | null; shownAt: number; dirty: boolean; /** Mounted behind at restore to warm its kind's editor (guarantee 8). */ warm?: boolean };
export type PoolStep = { do: "nothing" } | { do: "keep" } | { do: "take"; frame: string } | { do: "park"; from: string; frame: string } | { do: "wait" } | { do: "create" };

/**
 * Recent documents stay LIVE (the coordinator, 2026-11-18): besides the frames on screen or pinned, up to `recent` frames of
 * a kind stay with the documents shown most recently — switching among them is instant and keeps their undo. Only a
 * document older than those is parked and swapped. Among the recent ones, the one with unsaved edits goes last, then the
 * one shown longest ago first.
 */
const keepOrder = (a: PoolHolder, b: PoolHolder) => (Number(b.dirty) - Number(a.dirty)) || (b.shownAt - a.shownAt);

/**
 * What a document's editor gets. Off screen: nothing (it keeps what it has). On screen without a frame: a free frame of its
 * kind (swap); else a new frame while at most `recent` off-screen documents of its kind hold one; else the frame of the
 * least recent off-screen, unpinned document (parked first; one with unsaved edits last); a park on its way: wait for it;
 * else a new frame.
 */
export function planWant(holder: PoolHolder, frames: readonly PoolFrame[], holders: readonly PoolHolder[], recent = 0): PoolStep {
  if (holder.frame) return { do: "keep" };
  const own = frames.filter((frame) => frame.kind === holder.kind);
  // Warm at restore: the tab last shown of a kind with open tabs starts its kind's editor behind — only while that kind
  // has no frame at all.
  if (!holder.visible) return holder.warm && own.length === 0 ? { do: "create" } : { do: "nothing" };
  const free = own.find((frame) => !frame.holder && frame.swappable && !frame.busy);
  if (free) return { do: "take", frame: free.id };
  const byId = new Map(holders.map((entry) => [entry.id, entry]));
  const offScreen = own.flatMap((frame) => { const other = frame.holder ? byId.get(frame.holder) : undefined; return other && !other.visible && !other.pinned ? [{ frame, other }] : []; });
  // The documents off screen keep their frames while there are at most `recent` of them (this one taking a new frame).
  if (offScreen.length <= recent) return { do: "create" };
  const spare = offScreen.filter(({ frame }) => frame.swappable && !frame.busy).sort((x, y) => keepOrder(y.other, x.other))[0];
  if (spare) return { do: "park", from: spare.other.id, frame: spare.frame.id };
  if (own.some((frame) => frame.busy)) return { do: "wait" };
  return { do: "create" };
}

/** K: the frames a kind keeps — one per document of it on screen or pinned, up to `recent` more for recent off-screen documents holding one, and at least one while any document of it is open. */
export function framesWanted(kind: string, holders: readonly PoolHolder[], recent = 0): number {
  const mine = holders.filter((holder) => holder.kind === kind);
  if (!mine.length) return 0;
  const live = mine.filter((holder) => holder.visible || holder.pinned).length;
  const kept = Math.min(recent, mine.filter((holder) => !holder.visible && !holder.pinned && holder.frame).length);
  return Math.max(1, live + kept);
}

const GiB = 1024 ** 3;
/**
 * N, the recent frames per kind, by the memory the resource manager reads (apps/host/src/resources: its budget = available
 * memory + what its running turns use − the reserve; `pressure`: below its low mark). Room (≥ 2 GiB): 2; tight (≥ 1 GiB): 1;
 * less, or under pressure: 0 (the recent ones are parked, their edits kept). No reading (a remote host, not yet read): 2.
 */
export function recentFramesFor(reading: { pressure: boolean; budgetBytes: number } | null): number {
  if (!reading) return 2;
  if (reading.pressure) return 0;
  return reading.budgetBytes >= 2 * GiB ? 2 : reading.budgetBytes >= GiB ? 1 : 0;
}

/** What the pool asks of a document's editor (OfficeEditor.tsx). */
export type HolderPort = {
  id: string; kind: string; doc: string;
  visible(): boolean;
  /** Must keep its frame now (a live 문서 AI turn, an output or copy, a conflict, a flush or command waiting, shown under a comparison). */
  pinned(): boolean;
  /** Holds unsaved edits now (the last of the recent ones to be parked). */
  dirty(): boolean;
  /** Mounted behind at restore to warm its kind (warmTabs): wants a frame though off screen while its kind has none. */
  warm?(): boolean;
  /** Keep the document's state so the frame can be given away (office:park); false: it could not — the frame stays. */
  park(): Promise<boolean>;
  /** This frame is the editor's now: `fresh` — a new page (it sends office:init on office:ready); `swap` — a running page holding another document. */
  attach(frameId: string, mode: "fresh" | "swap"): void;
  /** The frame was given to another document (after a park that said ok). */
  detach(): void;
};

export type PoolOptions = { trimDelayMs?: number; stuckMs?: number; now?: () => number };

/**
 * The pool of one window surface (PaneLayout makes one). Decisions are `planWant` / `framesWanted`; this class carries them
 * out in order, parks before it swaps, and trims extra frames after `trimDelayMs` (so a quick pane flip does not reload).
 */
export class EditorPool {
  private readonly byId = new Map<string, PoolFrame>();
  private readonly ports = new Map<string, HolderPort>();
  private readonly holding = new Map<string, string>();
  /** Holders whose park was refused: treated as pinned until then (asked again later, never in a loop). */
  private readonly stuck = new Map<string, number>();
  /** When each holder was last seen on screen. */
  private readonly shown = new Map<string, number>();
  private recent = 0;
  private readonly listeners = new Set<() => void>();
  private next = 0;
  private scheduled = false;
  private trimTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly trimDelayMs: number;
  private readonly stuckMs: number;
  private readonly now: () => number;
  constructor(options: PoolOptions = {}) {
    this.trimDelayMs = options.trimDelayMs ?? 3000;
    this.stuckMs = options.stuckMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  frames(): PoolFrame[] { return [...this.byId.values()].map((frame) => ({ ...frame })); }
  /** The frame a document's editor holds now. */
  frameOf(holderId: string): string | null { return this.holding.get(holderId) ?? null; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  register(port: HolderPort): () => void {
    this.ports.set(port.id, port);
    this.update();
    return () => {
      this.ports.delete(port.id); this.stuck.delete(port.id); this.shown.delete(port.id);
      const frame = this.holding.get(port.id);
      this.holding.delete(port.id);
      // A document closed (its view unmounted: closed, asleep, another mode): its frame goes with it, as it did before the
      // pool. A page left holding a document nobody shows could still write that document's recovery copy afterwards.
      if (frame) { this.byId.delete(frame); this.changed(); }
      this.update();
    };
  }

  /** Something about a holder changed (shown, hidden, pinned, unpinned): decided again shortly (one pass for a burst). */
  update() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.run(); });
  }

  /** N recent frames per kind (recentFramesFor): fewer parks the extra ones (after the settle time). */
  setRecent(value: number) {
    const next = Math.max(0, Math.floor(value));
    if (next === this.recent) return;
    this.recent = next; this.update();
  }

  /** The page in this frame said office:swap-ready. */
  swappable(frameId: string) {
    const frame = this.byId.get(frameId);
    if (frame && !frame.swappable) { frame.swappable = true; this.update(); }
  }

  /** The page in this frame refused a swap (office:swapped ok:false): never asked again; the holder gets a new frame. */
  refused(frameId: string, holderId: string) {
    const frame = this.byId.get(frameId);
    if (frame) { frame.swappable = false; if (frame.holder === holderId) frame.holder = null; }
    if (this.holding.get(holderId) === frameId) this.holding.delete(holderId);
    this.changed(); this.update();
  }

  private holders(): PoolHolder[] {
    const now = this.now();
    for (const [id, until] of this.stuck) if (until <= now) this.stuck.delete(id);
    return [...this.ports.values()].map((port) => {
      const visible = port.visible();
      if (visible) this.shown.set(port.id, now);
      return { id: port.id, kind: port.kind, doc: port.doc, visible, pinned: port.pinned() || this.stuck.has(port.id), frame: this.holding.get(port.id) ?? null, shownAt: this.shown.get(port.id) ?? 0, dirty: port.dirty(), warm: port.warm?.() ?? false };
    });
  }

  private changed() { for (const listener of [...this.listeners]) listener(); }

  private run() {
    let changed = false;
    for (const holder of this.holders()) {
      const step = planWant(holder, [...this.byId.values()], this.holders(), this.recent);
      const port = this.ports.get(holder.id)!;
      if (step.do === "take") {
        const frame = this.byId.get(step.frame)!;
        frame.holder = holder.id; this.holding.set(holder.id, frame.id); changed = true;
        port.attach(frame.id, "swap");
      } else if (step.do === "park") {
        this.park(step.from, step.frame, false);
      } else if (step.do === "create") {
        const frame: PoolFrame = { id: `pool-${holder.kind}-${(this.next += 1)}`, kind: holder.kind, holder: holder.id, swappable: false, busy: false };
        this.byId.set(frame.id, frame); this.holding.set(holder.id, frame.id); changed = true;
        port.attach(frame.id, "fresh");
      }
    }
    if (changed) this.changed();
    this.scheduleTrim();
  }

  /** Park the holder of this frame; then (ok) the frame is free — and removed when `remove`. Refused: the holder keeps it. */
  private park(holderId: string, frameId: string, remove: boolean) {
    const frame = this.byId.get(frameId), port = this.ports.get(holderId);
    if (!frame || !port || frame.busy) return;
    frame.busy = true;
    const done = (ok: boolean) => {
      frame.busy = false;
      if (ok && frame.holder === holderId && this.ports.get(holderId) === port) {
        frame.holder = null; this.holding.delete(holderId);
        port.detach();
        if (remove) this.byId.delete(frameId);
        this.changed();
      } else if (!ok) this.stuck.set(holderId, this.now() + this.stuckMs);
      this.update();
    };
    port.park().then(done, () => done(false));
  }

  private scheduleTrim() {
    if (this.trimDelayMs <= 0) { this.trim(); return; }
    if (this.trimTimer !== null) clearTimeout(this.trimTimer);
    this.trimTimer = setTimeout(() => { this.trimTimer = null; this.trim(); }, this.trimDelayMs);
  }

  /** Frames beyond K of a kind: free ones are removed; those held off screen (not pinned) are parked and removed. */
  private trim() {
    const holders = this.holders(), byId = new Map(holders.map((holder) => [holder.id, holder]));
    let changed = false;
    for (const kind of new Set([...this.byId.values()].map((frame) => frame.kind))) {
      const frames = [...this.byId.values()].filter((frame) => frame.kind === kind);
      const holderOf = (frame: PoolFrame) => (frame.holder ? byId.get(frame.holder) : undefined);
      // 0: on screen, pinned or busy; 1: off screen (the recent ones first: unsaved, then most recently shown); 2: free.
      const rank = (frame: PoolFrame) => { const holder = holderOf(frame); return frame.busy ? 0 : holder && (holder.visible || holder.pinned) ? 0 : holder ? 1 : 2; };
      const ordered = frames.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? keepOrder(holderOf(a)!, holderOf(b)!) : 0));
      const wanted = Math.max(framesWanted(kind, holders, this.recent), frames.some((frame) => rank(frame) < 2) ? 1 : 0);
      for (const frame of ordered.slice(wanted)) {
        const level = rank(frame);
        if (level === 2) { this.byId.delete(frame.id); changed = true; }
        else if (level === 1) this.park(frame.holder!, frame.id, true);
      }
    }
    if (changed) this.changed();
  }
}

/**
 * Guarantee 8 (warm at restore): the tabs PaneLayout mounts behind at start, one per pooled kind that has an open tab — the
 * tab of that kind shown last (App.tsx `warmTabsFor`). Their editor starts behind (if the tab opens in its editor, not in
 * 쪽 보기); nothing else is warmed.
 */
const warmIds = new Set<string>();
export function markWarmTabs(ids: readonly string[]) { warmIds.clear(); for (const id of ids) warmIds.add(id); }
export const isWarmTab = (tabId: string | null) => Boolean(tabId && warmIds.has(tabId));

/** The tab to warm per pooled kind: of the open document tabs not on screen, the one shown last (by the panes' recent lists). */
export function warmTabsFor(tabs: readonly { id: string; format: DocFormat | undefined; onScreen: boolean; recency: number }[], kindOf: (format: DocFormat | undefined) => string | null = (format) => poolKindOf(format)): string[] {
  const best = new Map<string, { id: string; recency: number }>(), shownKinds = new Set<string>();
  for (const tab of tabs) {
    const kind = kindOf(tab.format);
    if (!kind) continue;
    if (tab.onScreen) { shownKinds.add(kind); continue; }
    const now = best.get(kind);
    if (!now || tab.recency < now.recency) best.set(kind, { id: tab.id, recency: tab.recency });
  }
  return [...best].filter(([kind]) => !shownKinds.has(kind)).map(([, entry]) => entry.id);
}
