import type { GraphEdge } from "./graph.ts";
import { Simulation, extent, fitView, zoomAt, type SimForces, type SimNode, type SimNodeInput, type View } from "./graph-sim.ts";

// The graph on screen: runs the simulation a tick per frame (or to rest at once under reduced
// motion) and writes positions straight into the SVG, so no React render happens per frame. Turns
// pointer input (mouse, touch, pen) into dragging a point, panning, wheel and pinch zoom, and tells
// a click from a drag by a few pixels of movement.

/** What only changes the drawing (no forces): arrow size follows the "관련" line width. */
export type Drawing = { relatedWidth: number; arrows: boolean; textFade: number; showRelated: boolean; showTagLines: boolean };

/** What the graph was showing when it was left: points (and pins) and the view. */
export type GraphMemory = { positions: Map<string, { x: number; y: number; pinned: boolean }>; view: View | null; follow: boolean };

type Parts = {
  svg: SVGSVGElement;
  world: SVGGElement;
  tag: SVGPathElement;
  related: SVGPathElement;
  arrows: SVGPathElement;
  tagLit: SVGPathElement;
  relatedLit: SVGPathElement;
  arrowsLit: SVGPathElement;
};

type Gesture =
  | { kind: "point"; id: string; pointerId: number; x0: number; y0: number; dx: number; dy: number; slop: number; moved: boolean }
  | { kind: "pan"; pointerId: number; x0: number; y0: number; view: View; moved: boolean }
  | { kind: "pinch"; distance: number; mid: { x: number; y: number }; view: View };

type Line = { edge: GraphEdge; a: SimNode; b: SimNode };

const round = (value: number) => Math.round(value * 10) / 10;
/** A point dragged further than this (px) is a drag, not a click. */
const SLOP_MOUSE = 4;
const SLOP_TOUCH = 8;
/** Ticks run before the first frame of a fresh layout, so it opens already taking shape. */
const PREWARM = 40;
const TWEEN_MS = 200;
/** Up to this many points the lit state fades in (CSS); beyond, it switches at once. */
const FEW = 120;

const capture = (element: Element, pointerId: number) => {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Not a live pointer (a synthetic event): the window listeners still follow it.
  }
};

export class GraphView {
  readonly sim: Simulation;
  view: View = { x: 450, y: 280, k: 1 };
  /** Keep the whole graph in view while it settles, until the person moves the view or a point. */
  follow = true;
  onPinned: (count: number) => void = () => undefined;
  onBackground: () => void = () => undefined;
  private parts: Parts | null = null;
  private elements = new Map<string, SVGGElement>();
  private written = new Map<string, string>();
  private paths = new Map<SVGPathElement, string>();
  private lines: Line[] = [];
  private adjacent = new Map<string, Set<string>>();
  private frame = { width: 900, height: 560 };
  private drawing: Drawing = { relatedWidth: 1.6, arrows: false, textFade: 0.7, showRelated: true, showTagLines: true };
  private forces: SimForces;
  private reduced = false;
  private pinOnDrop = false;
  private raf = 0;
  private hover: string | null = null;
  private keyFocus: string | null = null;
  private focus: string | null = null;
  private dragging: string | null = null;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  /** The frame's place on screen, taken once per gesture: reading it on every move would force a layout mid-frame. */
  private box: DOMRect | null = null;
  private suppressClick = false;
  /** The person moved the view or a point since the last fresh layout. */
  private touched = false;
  private memory: GraphMemory | null;
  private tween: { from: View; to: View; start: number } | null = null;
  private labelOpacity = -1;
  private counter = 0;
  private listening = false;

  constructor(forces: SimForces, memory: GraphMemory | null = null) {
    this.forces = structuredClone(forces);
    this.sim = new Simulation(forces);
    this.memory = memory?.positions.size ? memory : null;
    if (this.memory?.view) {
      this.view = { ...this.memory.view };
      this.follow = this.memory.follow;
      this.touched = !this.memory.follow;
    }
  }

  attach(parts: Parts) {
    this.parts = parts;
    parts.svg.setAttribute("data-state", "rest");
    parts.svg.addEventListener("pointerdown", this.onPointerDown);
    parts.svg.addEventListener("pointerover", this.onPointerOver);
    parts.svg.addEventListener("pointerleave", this.onPointerLeave);
    parts.svg.addEventListener("focusin", this.onFocusIn);
    parts.svg.addEventListener("focusout", this.onFocusOut);
    parts.svg.addEventListener("wheel", this.onWheel, { passive: false });
    this.applyView();
  }

  /** Stop and let go; what is shown goes to `memory` for the next time. */
  detach(memory?: GraphMemory) {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.unlisten();
    const svg = this.parts?.svg;
    if (svg) {
      svg.removeEventListener("pointerdown", this.onPointerDown);
      svg.removeEventListener("pointerover", this.onPointerOver);
      svg.removeEventListener("pointerleave", this.onPointerLeave);
      svg.removeEventListener("focusin", this.onFocusIn);
      svg.removeEventListener("focusout", this.onFocusOut);
      svg.removeEventListener("wheel", this.onWheel);
    }
    this.parts = null;
    if (memory) {
      memory.positions = new Map(this.sim.nodes.map((node) => [node.id, { x: node.x, y: node.y, pinned: node.fx !== null && node.id !== this.dragging }]));
      memory.view = { ...this.view };
      memory.follow = this.follow;
    }
  }

  /**
   * New points and lines (after React drew their elements). The first layout, and any change
   * while it is still settling untouched, starts fresh from the spiral (so the same projects
   * always settle the same way); later changes keep where points are and warm up a little.
   */
  setGraph(nodes: SimNodeInput[], edges: GraphEdge[]) {
    const known = this.memory?.positions;
    const restoring = Boolean(known) && !this.sim.nodes.length;
    const before = this.sim.nodes.map((node) => node.id).join("|") + "#" + this.lines.map((line) => `${line.edge.from}>${line.edge.to}`).join("|");
    // Under reduced motion nothing was seen settling, so an untouched graph is always laid out afresh.
    const fresh = !restoring && (!this.sim.nodes.length || (!this.touched && (this.sim.running || this.reduced)));
    const result = this.sim.setData(
      nodes,
      edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
      { fresh, known: restoring ? known : undefined },
    );
    this.memory = null;
    this.lines = edges.flatMap((edge) => {
      const a = this.sim.node(edge.from);
      const b = this.sim.node(edge.to);
      return a && b ? [{ edge, a, b }] : [];
    });
    this.adjacent = new Map();
    for (const { edge } of this.lines) {
      if (!this.adjacent.has(edge.from)) this.adjacent.set(edge.from, new Set());
      if (!this.adjacent.has(edge.to)) this.adjacent.set(edge.to, new Set());
      this.adjacent.get(edge.from)!.add(edge.to);
      this.adjacent.get(edge.to)!.add(edge.from);
    }
    this.collect();
    this.parts?.svg.classList.toggle("few", this.sim.nodes.length <= FEW);
    const after = this.sim.nodes.map((node) => node.id).join("|") + "#" + this.lines.map((line) => `${line.edge.from}>${line.edge.to}`).join("|");
    if (result.fresh) {
      this.touched = false;
      this.follow = true;
      if (!this.reduced) for (let tick = 0; tick < PREWARM && this.sim.running; tick += 1) this.sim.tick();
    } else if (restoring) {
      // Back to the graph: the picture as it was; only new points (or lines) need to settle.
      this.sim.alpha = result.added || result.removed ? 0.3 : 0;
    } else this.sim.reheat(result.added || result.removed ? 0.5 : before !== after ? 0.3 : 0.12);
    this.onPinned(this.pinnedCount());
    this.applyLit();
    this.kick();
  }

  setForces(forces: SimForces) {
    if (JSON.stringify(forces) === JSON.stringify(this.forces)) return;
    this.forces = structuredClone(forces);
    this.sim.setForces(forces);
    this.sim.reheat(0.3);
    this.kick();
  }

  setDrawing(drawing: Drawing) {
    const fade = drawing.textFade !== this.drawing.textFade;
    this.drawing = { ...drawing };
    if (fade) this.applyView();
    this.draw();
  }

  setReduced(reduced: boolean) {
    this.reduced = reduced;
    if (reduced && this.sim.running && !this.gesture) this.kick();
  }

  setPinOnDrop(pin: boolean) {
    this.pinOnDrop = pin;
  }

  /** The point (a tag) whose neighbours stay lit without hovering. */
  setFocus(id: string | null) {
    this.focus = id;
    this.applyLit();
  }

  resize(width: number, height: number) {
    const before = this.frame;
    this.frame = { width, height };
    if (this.follow) this.fitNow();
    else this.view = { ...this.view, x: this.view.x + (width - before.width) / 2, y: this.view.y + (height - before.height) / 2 };
    this.applyView();
  }

  /** "화면에 맞추기": the whole graph in view (and kept so while it settles). */
  fit() {
    this.follow = true;
    this.moveView(fitView(extent(this.sim.nodes), this.frame));
  }

  /** "처음 크기로": 100%, the graph's middle in the middle. */
  resetZoom() {
    this.follow = false;
    this.touched = true;
    const box = extent(this.sim.nodes);
    const cx = box ? (box.x0 + box.x1) / 2 : 0;
    const cy = box ? (box.y0 + box.y1) / 2 : 0;
    this.moveView({ k: 1, x: this.frame.width / 2 - cx, y: this.frame.height / 2 - cy });
  }

  /** Let every pinned point go; they find their place again. */
  unpinAll() {
    if (!this.sim.releaseAll()) return;
    this.onPinned(0);
    this.sim.reheat(0.3);
    this.kick();
  }

  pinnedCount() {
    return this.sim.nodes.filter((node) => node.fx !== null && node.id !== this.dragging).length;
  }

  /** True once after a drag: the click that follows the release is not a click on the point. */
  takeClick() {
    const suppressed = this.suppressClick;
    this.suppressClick = false;
    return suppressed;
  }

  // ── frames ────────────────────────────────────────────────────────────────────────────────

  private kick() {
    if (!this.parts) return;
    if (this.reduced) {
      // No settling on screen: the rest positions at once.
      if (this.sim.running && !this.gesture) this.sim.settle();
      if (this.tween) {
        this.view = this.tween.to;
        this.tween = null;
      }
      if (this.follow && !this.gesture) this.fitNow();
      this.applyView();
      this.draw();
      this.setState("rest");
      return;
    }
    if (!this.raf) this.raf = requestAnimationFrame(this.step);
    this.setState("running");
  }

  private step = (now: number) => {
    this.raf = 0;
    if (!this.parts) return;
    if (this.sim.running) this.sim.tick();
    if (this.tween) {
      const t = Math.min(1, (now - this.tween.start) / TWEEN_MS);
      const ease = 1 - Math.pow(1 - t, 3);
      const { from, to } = this.tween;
      this.view = { x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease, k: from.k + (to.k - from.k) * ease };
      if (t >= 1) this.tween = null;
      this.applyView();
    } else if (this.follow && !this.gesture) {
      this.fitNow();
      this.applyView();
    }
    this.draw();
    if (this.sim.running || this.tween) this.raf = requestAnimationFrame(this.step);
    else this.setState("rest");
  };

  private setState(state: "running" | "rest") {
    if (this.parts && this.parts.svg.getAttribute("data-state") !== state) this.parts.svg.setAttribute("data-state", state);
  }

  private fitNow() {
    if (this.sim.nodes.length) this.view = fitView(extent(this.sim.nodes), this.frame);
  }

  private moveView(to: View) {
    if (this.reduced || !this.parts) {
      this.view = to;
      this.applyView();
      return;
    }
    this.tween = { from: { ...this.view }, to, start: performance.now() };
    this.kick();
  }

  private applyView() {
    const parts = this.parts;
    if (!parts) return;
    const { x, y, k } = this.view;
    parts.world.setAttribute("transform", `translate(${round(x)} ${round(y)}) scale(${Math.round(k * 10_000) / 10_000})`);
    // Labels fade in between 75% and 100% of the threshold zoom (0: always shown).
    const t = this.drawing.textFade;
    const opacity = t <= 0 ? 1 : Math.round(Math.min(1, Math.max(0, (k - t * 0.75) / (t * 0.25))) * 100) / 100;
    if (opacity !== this.labelOpacity) {
      this.labelOpacity = opacity;
      parts.svg.style.setProperty("--graph-label-opacity", String(opacity));
      parts.svg.classList.toggle("labels-off", opacity <= 0);
    }
    // Zoomed out, the labels around the point under the pointer keep their size on screen.
    const counter = Math.round(Math.max(1, 1 / k) * 100) / 100;
    if (counter !== this.counter) {
      this.counter = counter;
      parts.svg.style.setProperty("--graph-counter", String(counter));
    }
  }

  /** Every point's element, from what React drew. */
  private collect() {
    this.elements = new Map();
    if (!this.parts) return;
    for (const element of Array.from(this.parts.svg.querySelectorAll<SVGGElement>("g[data-node]"))) this.elements.set(element.getAttribute("data-node")!, element);
    this.written = new Map([...this.written].filter(([id]) => this.elements.has(id) && this.elements.get(id)!.hasAttribute("transform")));
  }

  draw() {
    const parts = this.parts;
    if (!parts) return;
    // A quarter of a screen pixel is as fine as a move can be seen: smaller ones are not written.
    const step = Math.max(0.1, 0.25 / this.view.k);
    const snap = (value: number) => round(Math.round(value / step) * step);
    for (const node of this.sim.nodes) {
      const element = this.elements.get(node.id);
      if (!element) continue;
      const transform = `translate(${snap(node.x)} ${snap(node.y)})`;
      if (this.written.get(node.id) === transform) continue;
      element.setAttribute("transform", transform);
      this.written.set(node.id, transform);
    }
    const centre = this.centre();
    let related = "";
    let relatedLit = "";
    let tag = "";
    let tagLit = "";
    let arrows = "";
    let arrowsLit = "";
    const { showRelated, showTagLines, arrows: withArrows, relatedWidth } = this.drawing;
    for (const { edge, a, b } of this.lines) {
      const lit = centre !== null && (edge.from === centre || edge.to === centre);
      const segment = `M${round(a.x)} ${round(a.y)}L${round(b.x)} ${round(b.y)}`;
      if (edge.kind === "tag") {
        if (!showTagLines) continue;
        if (lit) tagLit += segment;
        else tag += segment;
        continue;
      }
      if (!showRelated) continue;
      if (lit) relatedLit += segment;
      else related += segment;
      if (!withArrows) continue;
      const heads = arrowHead(a, b, relatedWidth) + (edge.mutual ? arrowHead(b, a, relatedWidth) : "");
      if (lit) arrowsLit += heads;
      else arrows += heads;
    }
    this.setPath(parts.tag, tag);
    this.setPath(parts.related, related);
    this.setPath(parts.arrows, arrows);
    this.setPath(parts.tagLit, tagLit);
    this.setPath(parts.relatedLit, relatedLit);
    this.setPath(parts.arrowsLit, arrowsLit);
  }

  private setPath(path: SVGPathElement, d: string) {
    if (this.paths.get(path) === d) return;
    this.paths.set(path, d);
    if (d) path.setAttribute("d", d);
    else path.removeAttribute("d");
  }

  // ── lit: the point under the pointer (or dragged, keyboard-focused, focused) and its neighbours ─

  private centre() {
    const centre = this.dragging ?? this.hover ?? this.keyFocus ?? this.focus;
    return centre && this.sim.node(centre) ? centre : null;
  }

  private applyLit() {
    const parts = this.parts;
    if (!parts) return;
    const centre = this.centre();
    const lit = centre ? new Set([centre, ...(this.adjacent.get(centre) ?? [])]) : null;
    parts.svg.classList.toggle("has-lit", Boolean(lit));
    for (const [id, element] of this.elements) {
      const on = Boolean(lit?.has(id));
      if (on !== element.hasAttribute("data-lit")) {
        if (on) element.setAttribute("data-lit", "");
        else element.removeAttribute("data-lit");
      }
      const middle = id === centre;
      if (middle !== element.hasAttribute("data-centre")) {
        if (middle) element.setAttribute("data-centre", "");
        else element.removeAttribute("data-centre");
      }
    }
    this.draw();
  }

  // ── pointer input ─────────────────────────────────────────────────────────────────────────

  private toWorld(clientX: number, clientY: number) {
    const box = this.box ?? this.parts!.svg.getBoundingClientRect();
    return { x: (clientX - box.left - this.view.x) / this.view.k, y: (clientY - box.top - this.view.y) / this.view.k };
  }

  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
  }

  private unlisten() {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!this.parts || (event.pointerType === "mouse" && event.button !== 0)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.listen();
    if (this.pointers.size === 2) return this.startPinch();
    if (this.gesture) return;
    this.suppressClick = false;
    this.tween = null;
    this.box = this.parts.svg.getBoundingClientRect();
    const element = (event.target as Element | null)?.closest?.("g[data-node]") ?? null;
    const node = element ? this.sim.node(element.getAttribute("data-node")!) : undefined;
    if (element && node) {
      const at = this.toWorld(event.clientX, event.clientY);
      this.gesture = { kind: "point", id: node.id, pointerId: event.pointerId, x0: event.clientX, y0: event.clientY, dx: node.x - at.x, dy: node.y - at.y, slop: event.pointerType === "mouse" ? SLOP_MOUSE : SLOP_TOUCH, moved: false };
      capture(element, event.pointerId);
    } else {
      this.gesture = { kind: "pan", pointerId: event.pointerId, x0: event.clientX, y0: event.clientY, view: { ...this.view }, moved: false };
      capture(this.parts.svg, event.pointerId);
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = this.gesture;
    if (!gesture || !this.parts) return;
    if (gesture.kind === "pinch") return this.movePinch(gesture);
    if (event.pointerId !== gesture.pointerId) return;
    const far = Math.hypot(event.clientX - gesture.x0, event.clientY - gesture.y0) >= (gesture.kind === "point" ? gesture.slop : 2);
    if (!gesture.moved && !far) return;
    if (!gesture.moved) {
      gesture.moved = true;
      this.follow = false;
      this.touched = true;
      this.tween = null;
    }
    if (gesture.kind === "pan") {
      this.view = { ...gesture.view, x: gesture.view.x + event.clientX - gesture.x0, y: gesture.view.y + event.clientY - gesture.y0 };
      this.applyView();
      return;
    }
    const at = this.toWorld(event.clientX, event.clientY);
    const x = at.x + gesture.dx;
    const y = at.y + gesture.dy;
    if (this.dragging !== gesture.id) {
      this.dragging = gesture.id;
      this.parts.svg.classList.add("dragging");
      this.applyLit();
      // Keep the simulation warm while a point is held: its neighbours follow it.
      if (!this.reduced) this.sim.alphaTarget = 0.3;
    }
    this.sim.pin(gesture.id, x, y);
    if (this.reduced) {
      // No settling on screen: the point goes where the pointer is, the rest waits for the drop.
      const node = this.sim.node(gesture.id)!;
      node.x = x;
      node.y = y;
      this.draw();
    } else this.kick();
  };

  private onPointerUp = (event: PointerEvent) => this.endPointer(event, false);
  private onPointerCancel = (event: PointerEvent) => this.endPointer(event, true);

  private endPointer(event: PointerEvent, cancelled: boolean) {
    this.pointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (!gesture || gesture.kind === "pinch") {
      if (this.pointers.size < 2) {
        this.gesture = null;
        this.box = null;
      }
      if (!this.pointers.size) this.unlisten();
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    this.gesture = null;
    this.box = null;
    if (!this.pointers.size) this.unlisten();
    if (gesture.kind === "pan") {
      // A click on empty space lets a focused tag go.
      if (!gesture.moved && !cancelled) this.onBackground();
      return;
    }
    if (!gesture.moved) {
      if (cancelled) this.suppressClick = true;
      return;
    }
    this.drop(gesture.id);
  }

  /** The end of a drag: Obsidian lets the point go; with "끌어 놓은 점 고정" it stays where it was put. */
  private drop(id: string) {
    this.suppressClick = true;
    this.dragging = null;
    this.parts?.svg.classList.remove("dragging");
    this.sim.alphaTarget = 0;
    if (this.reduced) {
      // The others find their places at once around the point where it was dropped.
      this.sim.reheat(0.3);
      this.sim.settle();
    }
    if (!this.pinOnDrop) this.sim.release(id);
    this.onPinned(this.pinnedCount());
    this.applyLit();
    this.kick();
  }

  private startPinch() {
    const gesture = this.gesture;
    if (gesture?.kind === "point") {
      if (gesture.moved) this.drop(gesture.id);
      else this.suppressClick = true;
    }
    const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    this.follow = false;
    this.touched = true;
    this.tween = null;
    this.gesture = { kind: "pinch", distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...this.view } };
  }

  private movePinch(gesture: Extract<Gesture, { kind: "pinch" }>) {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b || !this.parts) return;
    const box = this.box ?? this.parts.svg.getBoundingClientRect();
    const zoomed = zoomAt(gesture.view, gesture.mid.x - box.left, gesture.mid.y - box.top, Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance);
    this.view = { ...zoomed, x: zoomed.x + (a.x + b.x) / 2 - gesture.mid.x, y: zoomed.y + (a.y + b.y) / 2 - gesture.mid.y };
    this.applyView();
  }

  private onWheel = (event: WheelEvent) => {
    if (!this.parts) return;
    event.preventDefault();
    const box = this.parts.svg.getBoundingClientRect();
    // A wheel notch about 1.25×; a touchpad pinch (ctrl + wheel) zooms as fast.
    const factor = Math.pow(2, -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * (event.ctrlKey ? 10 : 1));
    this.follow = false;
    this.touched = true;
    this.tween = null;
    this.view = zoomAt(this.view, event.clientX - box.left, event.clientY - box.top, factor);
    this.applyView();
  };

  private onPointerOver = (event: PointerEvent) => {
    if (this.gesture) return;
    const id = (event.target as Element | null)?.closest?.("g[data-node]")?.getAttribute("data-node") ?? null;
    if (id === this.hover) return;
    this.hover = id;
    this.applyLit();
  };

  private onPointerLeave = () => {
    if (this.gesture || this.hover === null) return;
    this.hover = null;
    this.applyLit();
  };

  private onFocusIn = (event: FocusEvent) => {
    const element = (event.target as Element | null)?.closest?.("g[data-node]");
    // Only a keyboard focus lights: a click focuses the point too, and the pointer already lights it.
    let visible = false;
    try {
      visible = Boolean(element?.matches(":focus-visible"));
    } catch {
      visible = false;
    }
    const id = visible ? element!.getAttribute("data-node") : null;
    if (id === this.keyFocus) return;
    this.keyFocus = id;
    this.applyLit();
  };

  private onFocusOut = () => {
    if (this.keyFocus === null) return;
    this.keyFocus = null;
    this.applyLit();
  };
}

/** A small arrowhead at `b`'s rim, pointing from `a`; nothing when the two nearly touch. */
function arrowHead(a: SimNode, b: SimNode, width: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const size = 5 + width * 1.6;
  if (length < a.r + b.r + size * 1.5) return "";
  const ux = dx / length;
  const uy = dy / length;
  const tipX = b.x - ux * (b.r + 1.5);
  const tipY = b.y - uy * (b.r + 1.5);
  const baseX = tipX - ux * size;
  const baseY = tipY - uy * size;
  const side = size * 0.5;
  return `M${round(tipX)} ${round(tipY)}L${round(baseX - uy * side)} ${round(baseY + ux * side)}L${round(baseX + uy * side)} ${round(baseY - ux * side)}Z`;
}
