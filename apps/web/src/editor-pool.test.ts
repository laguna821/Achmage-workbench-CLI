import { describe, expect, it, vi } from "vitest";
import { EditorPool, framesWanted, planWant, poolKindOf, recentFramesFor, warmTabsFor, type PoolFrame, type PoolHolder, type HolderPort } from "./editor-pool.ts";

const holder = (id: string, patch: Partial<PoolHolder> = {}): PoolHolder => ({ id, kind: "docs", doc: `doc-${id}`, visible: false, pinned: false, frame: null, shownAt: 0, dirty: false, ...patch });
const frame = (id: string, patch: Partial<PoolFrame> = {}): PoolFrame => ({ id, kind: "docs", holder: null, swappable: true, busy: false, ...patch });

describe("the per-kind switch", () => {
  it("pools Word, PowerPoint and Excel by default and nothing that is not proven", () => {
    const none = { getItem: () => null };
    expect(poolKindOf("docx", none)).toBe("docs");
    expect(poolKindOf("pptx", none)).toBe("slides");
    expect(poolKindOf("xlsx", none)).toBe("sheets");
    for (const format of ["hwp", "hwpx", "pdf", "markdown", "html", "epub", "xmind"] as const) expect(poolKindOf(format, none)).toBeNull();
  });
  it("can be turned on or off per kind (the rigs' before/after)", () => {
    expect(poolKindOf("docx", { getItem: (key: string) => (key === "workbench.pool.docs" ? "off" : null) })).toBeNull();
    expect(poolKindOf("hwpx", { getItem: (key: string) => (key === "workbench.pool.hwp" ? "on" : null) })).toBeNull();
    expect(poolKindOf("pptx", { getItem: (key: string) => (key === "workbench.pool.slides" ? "off" : null) })).toBeNull();
  });
});

describe("which frame a shown document gets (planWant)", () => {
  it("keeps the frame it has", () => {
    expect(planWant(holder("a", { visible: true, frame: "f1" }), [frame("f1", { holder: "a" })], [])).toEqual({ do: "keep" });
  });
  it("takes a free frame by swapping its document", () => {
    expect(planWant(holder("a", { visible: true }), [frame("f1")], [])).toEqual({ do: "take", frame: "f1" });
  });
  it("takes the frame of a document off screen, after that one is parked", () => {
    const b = holder("b", { frame: "f1" });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { holder: "b" })], [b])).toEqual({ do: "park", from: "b", frame: "f1" });
  });
  it("never takes the frame of a document on screen or pinned (a live 문서 AI turn): a second frame is made", () => {
    const shown = holder("b", { visible: true, frame: "f1" }), turning = holder("c", { pinned: true, frame: "f2" });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { holder: "b" }), frame("f2", { holder: "c" })], [shown, turning])).toEqual({ do: "create" });
  });
  it("does not swap into a page that has not said it can, or one busy parking", () => {
    expect(planWant(holder("a", { visible: true }), [frame("f1", { swappable: false })], [])).toEqual({ do: "create" });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { busy: true, holder: "b" })], [holder("b", { frame: "f1" })])).toEqual({ do: "wait" });
  });
  it("wants nothing for a document off screen", () => {
    expect(planWant(holder("a"), [frame("f1")], [])).toEqual({ do: "nothing" });
  });
  it("only looks at frames of its own kind", () => {
    expect(planWant(holder("a", { visible: true }), [frame("f1", { kind: "slides" })], [])).toEqual({ do: "create" });
  });
});

describe("how many frames a kind keeps (framesWanted: K = what is on screen or pinned, at least one)", () => {
  it("one frame for one, five or ten documents of which one is shown", () => {
    const holders = Array.from({ length: 10 }, (_, index) => holder(`h${index}`, { visible: index === 3 }));
    expect(framesWanted("docs", holders)).toBe(1);
    expect(framesWanted("docs", holders.slice(0, 5))).toBe(1);
  });
  it("two panes with two documents: two; back to one pane: one", () => {
    expect(framesWanted("docs", [holder("a", { visible: true }), holder("b", { visible: true })])).toBe(2);
    expect(framesWanted("docs", [holder("a", { visible: true }), holder("b")])).toBe(1);
  });
  it("a pinned document off screen keeps its own", () => {
    expect(framesWanted("docs", [holder("a", { visible: true }), holder("b", { pinned: true })])).toBe(2);
  });
});

/** A holder port that records what the pool told it. */
function port(id: string, state: { visible?: boolean; pinned?: boolean; dirty?: boolean; parks?: boolean | (() => Promise<boolean>) } = {}) {
  const calls: string[] = [];
  const value: HolderPort & { calls: string[]; state: typeof state } = {
    id, kind: "docs", doc: `doc-${id}`, calls, state,
    visible: () => Boolean(state.visible), pinned: () => Boolean(state.pinned), dirty: () => Boolean(state.dirty),
    park: async () => { calls.push("park"); const parks = state.parks ?? true; return typeof parks === "function" ? parks() : parks; },
    attach: (frameId, mode) => { calls.push(`attach:${frameId}:${mode}`); },
    detach: () => { calls.push("detach"); },
  };
  return value;
}
const settle = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

describe("EditorPool (the bookkeeping the frames follow)", () => {
  it("five documents, one shown at a time: ONE frame; the one left is parked before its frame swaps", async () => {
    const pool = new EditorPool({ trimDelayMs: 0 });
    const ports = Array.from({ length: 5 }, (_, index) => port(`t${index}`));
    for (const each of ports) pool.register(each);
    ports[0]!.state.visible = true; pool.update(); await settle();
    expect(pool.frames()).toHaveLength(1);
    expect(ports[0]!.calls).toEqual([`attach:${pool.frames()[0]!.id}:fresh`]);
    pool.swappable(pool.frames()[0]!.id);
    for (const next of [1, 2, 3, 4]) {
      ports[next - 1]!.state.visible = false; ports[next]!.state.visible = true; pool.update(); await settle();
      expect(pool.frames()).toHaveLength(1);
      expect(ports[next - 1]!.calls.slice(-2)).toEqual(["park", "detach"]);
      expect(ports[next]!.calls.at(-1)).toBe(`attach:${pool.frames()[0]!.id}:swap`);
    }
  });
  it("back to a tab whose frame was not taken meanwhile: nothing happens (undo and all kept)", async () => {
    const pool = new EditorPool({ trimDelayMs: 0 });
    const a = port("a", { visible: true });
    pool.register(a); pool.update(); await settle();
    a.state.visible = false; pool.update(); await settle();
    a.state.visible = true; pool.update(); await settle();
    expect(a.calls).toEqual([`attach:${pool.frames()[0]!.id}:fresh`]);
  });
  it("a park that is refused (edits not kept, a turn running) gives the incoming document its own frame", async () => {
    const pool = new EditorPool({ trimDelayMs: 0 });
    const a = port("a", { visible: true, parks: false }), b = port("b");
    pool.register(a); pool.register(b); pool.update(); await settle();
    pool.swappable(pool.frames()[0]!.id);
    a.state.visible = false; b.state.visible = true; pool.update(); await settle();
    expect(a.calls).toEqual([`attach:${pool.frames()[0]!.id}:fresh`, "park"]);
    expect(pool.frames()).toHaveLength(2);
    expect(b.calls).toEqual([`attach:${pool.frames()[1]!.id}:fresh`]);
  });
  it("two panes make two frames; one pane again goes back to one (after the settle time)", async () => {
    vi.useFakeTimers();
    try {
      const pool = new EditorPool({ trimDelayMs: 3000 });
      const a = port("a", { visible: true }), b = port("b", { visible: true });
      pool.register(a); pool.register(b); pool.update(); await settle();
      expect(pool.frames()).toHaveLength(2);
      b.state.visible = false; pool.update(); await settle();
      expect(pool.frames()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3000); await settle();
      expect(pool.frames()).toHaveLength(1);
      expect(b.calls.slice(-2)).toEqual(["park", "detach"]);
      expect(pool.frames()[0]!.holder).toBe("a");
    } finally { vi.useRealTimers(); }
  });
  it("a pinned document (a live turn) off screen keeps its frame; the other gets a second one", async () => {
    const pool = new EditorPool({ trimDelayMs: 0 });
    const a = port("a", { visible: true }), b = port("b");
    pool.register(a); pool.register(b); pool.update(); await settle();
    pool.swappable(pool.frames()[0]!.id);
    a.state.visible = false; a.state.pinned = true; b.state.visible = true; pool.update(); await settle();
    expect(a.calls).not.toContain("park");
    expect(pool.frames().map((entry) => entry.holder).sort()).toEqual(["a", "b"]);
    // The turn ends: the pinned one lets go, back to one frame.
    a.state.pinned = false; pool.update(); await settle();
    expect(pool.frames()).toHaveLength(1);
    expect(pool.frames()[0]!.holder).toBe("b");
  });
  it("a document closed (its view unmounted) takes its frame with it", async () => {
    const pool = new EditorPool({ trimDelayMs: 0 });
    const a = port("a", { visible: true });
    const off = pool.register(a); pool.update(); await settle();
    off();
    expect(pool.frames()).toHaveLength(0);
  });
  it("a page that refuses the swap is not swapped into again; the document gets a new frame", async () => {
    const pool = new EditorPool({ trimDelayMs: 0 });
    const a = port("a", { visible: true }), b = port("b");
    pool.register(a); pool.register(b); pool.update(); await settle();
    const first = pool.frames()[0]!.id;
    pool.swappable(first);
    a.state.visible = false; b.state.visible = true; pool.update(); await settle();
    expect(b.calls.at(-1)).toBe(`attach:${first}:swap`);
    pool.refused(first, "b"); await settle();
    expect(b.calls.at(-1)).toMatch(/^attach:.*:fresh$/);
    // The refused frame is never swapped into again (here: removed by the trim, K = 1).
    expect(pool.frames().every((entry) => entry.id !== first || !entry.swappable)).toBe(true);
    expect(pool.frames()).toHaveLength(1);
  });
});

describe("recent documents stay live (LRU, N by memory)", () => {
  it("N recent frames: a shown document gets a NEW frame while fewer than N off-screen documents hold one", () => {
    const off = holder("b", { frame: "f1", shownAt: 10 });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { holder: "b" })], [off], 2)).toEqual({ do: "create" });
    // N reached: the least recent clean one is parked and its frame swapped.
    const c = holder("c", { frame: "f2", shownAt: 20 });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { holder: "b" }), frame("f2", { holder: "c" })], [off, c], 2)).toEqual({ do: "create" });
    const d = holder("d", { frame: "f3", shownAt: 30 });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { holder: "b" }), frame("f2", { holder: "c" }), frame("f3", { holder: "d" })], [off, c, d], 2)).toEqual({ do: "park", from: "b", frame: "f1" });
  });
  it("a document with unsaved edits is the last of the recent ones to be parked", () => {
    const old = holder("b", { frame: "f1", shownAt: 10, dirty: true }), newer = holder("c", { frame: "f2", shownAt: 20 });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { holder: "b" }), frame("f2", { holder: "c" })], [old, newer], 1)).toEqual({ do: "park", from: "c", frame: "f2" });
  });
  it("pinned documents are not among the recent ones (they keep theirs and do not count)", () => {
    const turning = holder("b", { frame: "f1", pinned: true }), recent = holder("c", { frame: "f2", shownAt: 5 });
    expect(planWant(holder("a", { visible: true }), [frame("f1", { holder: "b" }), frame("f2", { holder: "c" })], [turning, recent], 1)).toEqual({ do: "create" });
  });
  it("K = on screen + pinned + up to N recent off-screen documents that hold a frame", () => {
    const holders = [holder("a", { visible: true, frame: "f0" }), holder("b", { frame: "f1" }), holder("c", { frame: "f2" }), holder("d", { frame: "f3" }), holder("e")];
    expect(framesWanted("docs", holders, 2)).toBe(3);
    expect(framesWanted("docs", holders, 1)).toBe(2);
    expect(framesWanted("docs", holders, 0)).toBe(1);
  });
  it("recentFramesFor: 2 with room, 1 when tight, 0 under pressure", () => {
    const GiB = 1024 ** 3;
    expect(recentFramesFor({ pressure: false, budgetBytes: 4 * GiB })).toBe(2);
    expect(recentFramesFor({ pressure: false, budgetBytes: 1.5 * GiB })).toBe(1);
    expect(recentFramesFor({ pressure: false, budgetBytes: 0.5 * GiB })).toBe(0);
    expect(recentFramesFor({ pressure: true, budgetBytes: 8 * GiB })).toBe(0);
    expect(recentFramesFor(null)).toBe(2);
  });
  it("EditorPool with N = 2: A, B, C shown in turn stay live (no park); a 4th parks the oldest; back to a live one: nothing happens", async () => {
    let clock = 0;
    const pool = new EditorPool({ trimDelayMs: 0, now: () => (clock += 1) });
    pool.setRecent(2);
    const ports = ["a", "b", "c", "d"].map((id) => port(id));
    for (const each of ports) pool.register(each);
    const show = async (index: number) => { ports.forEach((each, i) => { each.state.visible = i === index; }); pool.update(); await settle(); for (const frame of pool.frames()) pool.swappable(frame.id); await settle(); };
    await show(0); await show(1); await show(2);
    expect(pool.frames()).toHaveLength(3);
    expect(ports.flatMap((each) => each.calls).filter((call) => call === "park")).toEqual([]);
    await show(0);
    expect(ports[0]!.calls.filter((call) => call.startsWith("attach"))).toHaveLength(1);
    await show(3);
    expect(pool.frames()).toHaveLength(3);
    // b was shown longest ago: parked, its frame taken by d.
    expect(ports[1]!.calls.slice(-2)).toEqual(["park", "detach"]);
    expect(ports[3]!.calls.at(-1)).toMatch(/:swap$/);
  });
  it("memory short (N drops to 0): the recent frames are parked and removed", async () => {
    const pool = new EditorPool({ trimDelayMs: 0 });
    pool.setRecent(2);
    const a = port("a", { visible: true }), b = port("b");
    pool.register(a); pool.register(b); pool.update(); await settle();
    a.state.visible = false; b.state.visible = true; pool.update(); await settle();
    expect(pool.frames()).toHaveLength(2);
    pool.setRecent(0); await settle();
    expect(pool.frames()).toHaveLength(1);
    expect(a.calls.slice(-2)).toEqual(["park", "detach"]);
  });
});

describe("warm at restore (guarantee 8)", () => {
  it("a warm tab off screen gets a frame only while its kind has none", () => {
    expect(planWant(holder("a", { warm: true }), [], [], 2)).toEqual({ do: "create" });
    expect(planWant(holder("a", { warm: true }), [frame("f1", { holder: "b" })], [holder("b", { visible: true, frame: "f1" })], 2)).toEqual({ do: "nothing" });
    expect(planWant(holder("a"), [], [], 2)).toEqual({ do: "nothing" });
  });
  it("warmTabsFor: per pooled kind with open tabs, the one shown last; none for a kind on screen or not pooled", () => {
    const kindOf = (format?: string) => (format === "docx" ? "docs" : format === "pptx" ? "slides" : null);
    expect(warmTabsFor([
      { id: "w-old", format: "docx", onScreen: false, recency: 3 },
      { id: "w-new", format: "docx", onScreen: false, recency: 1 },
      { id: "p-shown", format: "pptx", onScreen: true, recency: 0 },
      { id: "p-other", format: "pptx", onScreen: false, recency: 2 },
      { id: "h", format: "hwpx", onScreen: false, recency: 0 },
    ] as never, kindOf as never)).toEqual(["w-new"]);
  });
});
