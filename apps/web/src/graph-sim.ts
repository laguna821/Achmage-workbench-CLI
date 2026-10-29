// The projects' graph in motion: a small force simulation in the manner of d3-force, written here
// (no library). Forces: a pull to the middle, many-body repulsion (Barnes–Hut), a spring per line
// with its kind's length and strength, and a collision of ellipses that leaves each label its
// room. "alpha" heats on a change and cools to rest. Same input, same layout: points start on a
// golden-angle spiral and the only nudge (two points on one spot) comes from a fixed-seed generator.

export type LinkKind = "related" | "tag";

export type SimForces = {
  /** Pull to the middle, a share of the distance per tick (d3 forceX/forceY strength). */
  center: number;
  /** Many-body strength; larger pushes points further apart. */
  repel: number;
  /** Collision 0–1: how much of an overlap is undone per tick. */
  collide: number;
  links: Record<LinkKind, { strength: number; distance: number }>;
};

/** A point to place: its drawn radius and the half axes of the ellipse it keeps clear (point and label). */
export type SimNodeInput = { id: string; r: number; rx: number; ry: number };
export type SimLinkInput = { from: string; to: string; kind: LinkKind };

export type SimNode = SimNodeInput & { index: number; x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null };
export type SimLink = { source: SimNode; target: SimNode; kind: LinkKind; strength: number; distance: number; bias: number };

export const DEFAULT_FORCES: SimForces = {
  center: 0.05,
  repel: 160,
  collide: 0.7,
  links: { related: { strength: 0.7, distance: 130 }, tag: { strength: 0.4, distance: 80 } },
};

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const SPIRAL = 16;
const THETA2 = 0.81;

/** d3-force's LCG: a fixed sequence, so a nudge is the same each run. */
function lcg(seed: number) {
  let state = seed;
  return () => (state = (1664525 * state + 1013904223) % 4294967296) / 4294967296;
}

type Quad = { x0: number; y0: number; size: number; cx: number; cy: number; weight: number; kids: Quad[] | null; points: SimNode[] | null };

/** A square of points with their centre (equal weights), split in four while it holds more than one. */
function quad(points: SimNode[], x0: number, y0: number, size: number, depth: number): Quad {
  let cx = 0;
  let cy = 0;
  for (const point of points) {
    cx += point.x;
    cy += point.y;
  }
  const out: Quad = { x0, y0, size, cx: cx / points.length, cy: cy / points.length, weight: points.length, kids: null, points: null };
  if (points.length === 1 || depth >= 24 || size < 1e-3) {
    out.points = points;
    return out;
  }
  const half = size / 2;
  const parts: SimNode[][] = [[], [], [], []];
  for (const point of points) parts[(point.x >= x0 + half ? 1 : 0) + (point.y >= y0 + half ? 2 : 0)]!.push(point);
  out.kids = [];
  parts.forEach((part, at) => {
    if (part.length) out.kids!.push(quad(part, x0 + (at & 1 ? half : 0), y0 + (at & 2 ? half : 0), half, depth + 1));
  });
  return out;
}

export class Simulation {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  alphaTarget = 0;
  readonly alphaMin = 0.002;
  /** About 240 ticks from a full heat to rest (four seconds at 60 frames). */
  readonly alphaDecay = 1 - Math.pow(0.002, 1 / 240);
  /** What a point keeps of its speed each tick (d3's velocityDecay 0.4). */
  readonly friction = 0.6;
  private forces: SimForces;
  private random = lcg(1);
  private byId = new Map<string, SimNode>();

  constructor(forces: SimForces = DEFAULT_FORCES) {
    this.forces = structuredClone(forces);
  }

  get running() {
    return this.alpha >= this.alphaMin || this.alphaTarget > 0;
  }

  node(id: string) {
    return this.byId.get(id);
  }

  /**
   * New points and lines. Known points keep their place (and pin); `known` places others where they
   * were before (a graph left and opened again). The rest start beside a placed neighbour, or on
   * the spiral; `fresh` (or nothing known) lays everything out from the spiral, heat at full.
   * Returns how many points came and went.
   */
  setData(nodes: SimNodeInput[], links: SimLinkInput[], options: { fresh?: boolean; known?: Map<string, { x: number; y: number; pinned?: boolean }> } = {}) {
    const before = this.byId;
    const fresh = Boolean(options.fresh) || (!before.size && !options.known?.size);
    const next = new Map<string, SimNode>();
    let added = 0;
    const placed: SimNode[] = [];
    const waiting: SimNode[] = [];
    nodes.forEach((input, index) => {
      const old = fresh ? undefined : before.get(input.id);
      const seen = fresh || old ? undefined : options.known?.get(input.id);
      const node: SimNode = old
        ? { ...old, ...input, index }
        : { ...input, index, x: 0, y: 0, vx: 0, vy: 0, fx: seen?.pinned ? seen.x : null, fy: seen?.pinned ? seen.y : null };
      if (seen) {
        node.x = seen.x;
        node.y = seen.y;
      }
      if (!old) added += 1;
      next.set(input.id, node);
      (old || seen ? placed : waiting).push(node);
    });
    const removed = [...before.keys()].filter((id) => !next.has(id)).length;
    this.byId = next;
    this.nodes = nodes.map((input) => next.get(input.id)!);
    if (fresh) {
      this.random = lcg(1);
      this.alpha = 1;
      for (const node of this.nodes) Object.assign(node, spiral(node.index, 0, 0), { vx: 0, vy: 0, fx: null, fy: null });
    } else {
      // Beside a placed neighbour when there is one, else on a spiral around the middle of what is placed.
      const centre = placed.length ? { x: placed.reduce((sum, node) => sum + node.x, 0) / placed.length, y: placed.reduce((sum, node) => sum + node.y, 0) / placed.length } : { x: 0, y: 0 };
      const outer = placed.length ? Math.sqrt(placed.length) : 0;
      waiting.forEach((node, at) => {
        const friends = links
          .filter((link) => link.from === node.id || link.to === node.id)
          .map((link) => next.get(link.from === node.id ? link.to : link.from)!)
          .filter((friend) => friend && !waiting.includes(friend));
        if (friends.length) {
          const angle = (node.index + 1) * GOLDEN;
          node.x = friends.reduce((sum, friend) => sum + friend.x, 0) / friends.length + Math.cos(angle) * SPIRAL * 1.5;
          node.y = friends.reduce((sum, friend) => sum + friend.y, 0) / friends.length + Math.sin(angle) * SPIRAL * 1.5;
        } else Object.assign(node, spiral(at + outer * outer, centre.x, centre.y));
      });
    }
    this.links = [];
    for (const link of links) {
      const source = next.get(link.from);
      const target = next.get(link.to);
      if (source && target && source !== target) this.links.push({ source, target, kind: link.kind, strength: 0, distance: 0, bias: 0.5 });
    }
    this.weigh();
    return { added, removed, fresh };
  }

  setForces(forces: SimForces) {
    this.forces = structuredClone(forces);
    this.weigh();
  }

  /** Warm up again (a change): never cooler than it is. */
  reheat(alpha = 0.3) {
    this.alpha = Math.max(this.alpha, alpha);
  }

  /** Hold a point at a place (dragging, or pinned after a drop). */
  pin(id: string, x: number, y: number) {
    const node = this.byId.get(id);
    if (!node) return;
    node.fx = x;
    node.fy = y;
  }

  /** Let a point go where the forces take it. */
  release(id: string) {
    const node = this.byId.get(id);
    if (!node) return;
    node.fx = null;
    node.fy = null;
  }

  /** Release every held point; how many there were. */
  releaseAll() {
    let count = 0;
    for (const node of this.nodes) {
      if (node.fx === null && node.fy === null) continue;
      node.fx = null;
      node.fy = null;
      count += 1;
    }
    return count;
  }

  /** One step: cool, push and pull, move. */
  tick() {
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;
    this.pull(alpha);
    this.repel(alpha);
    const { center } = this.forces;
    if (center > 0) {
      for (const node of this.nodes) {
        node.vx -= node.x * center * alpha;
        node.vy -= node.y * center * alpha;
      }
    }
    this.collide();
    for (const node of this.nodes) {
      if (node.fx === null) node.x += node.vx *= this.friction;
      else {
        node.x = node.fx;
        node.vx = 0;
      }
      if (node.fy === null) node.y += node.vy *= this.friction;
      else {
        node.y = node.fy;
        node.vy = 0;
      }
    }
  }

  /** Run to rest at once (reduced motion, tests); the number of ticks it took. */
  settle(limit = 2000) {
    let ticks = 0;
    while (this.alpha >= this.alphaMin && ticks < limit) {
      this.tick();
      ticks += 1;
    }
    return ticks;
  }

  /** Spring strength per line: its kind's share of d3's default (weaker at busy points), and who moves more. */
  private weigh() {
    const count = new Map<SimNode, number>();
    for (const link of this.links) {
      count.set(link.source, (count.get(link.source) ?? 0) + 1);
      count.set(link.target, (count.get(link.target) ?? 0) + 1);
    }
    for (const link of this.links) {
      const a = count.get(link.source)!;
      const b = count.get(link.target)!;
      const kind = this.forces.links[link.kind];
      link.strength = kind.strength / Math.min(a, b);
      link.distance = kind.distance;
      link.bias = a / (a + b);
    }
  }

  private jiggle() {
    return (this.random() - 0.5) * 1e-6;
  }

  private pull(alpha: number) {
    for (const link of this.links) {
      if (!link.strength) continue;
      const { source, target } = link;
      const x = target.x + target.vx - source.x - source.vx || this.jiggle();
      const y = target.y + target.vy - source.y - source.vy || this.jiggle();
      const length = Math.sqrt(x * x + y * y);
      const k = ((length - link.distance) / length) * alpha * link.strength;
      target.vx -= x * k * link.bias;
      target.vy -= y * k * link.bias;
      source.vx += x * k * (1 - link.bias);
      source.vy += y * k * (1 - link.bias);
    }
  }

  private repel(alpha: number) {
    const strength = -this.forces.repel;
    if (!strength || this.nodes.length < 2) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const node of this.nodes) {
      x0 = Math.min(x0, node.x);
      y0 = Math.min(y0, node.y);
      x1 = Math.max(x1, node.x);
      y1 = Math.max(y1, node.y);
    }
    const root = quad(this.nodes, x0, y0, Math.max(x1 - x0, y1 - y0) + 1, 0);
    const visit = (node: SimNode, square: Quad) => {
      const inside = node.x >= square.x0 && node.x < square.x0 + square.size && node.y >= square.y0 && node.y < square.y0 + square.size;
      let x = square.cx - node.x;
      let y = square.cy - node.y;
      let l = x * x + y * y;
      if (!inside && (square.size * square.size) / THETA2 < l) {
        // Far enough: the whole square pushes as one body at its centre.
        if (l < 1) l = Math.sqrt(l);
        node.vx += (x * strength * square.weight * alpha) / l;
        node.vy += (y * strength * square.weight * alpha) / l;
        return;
      }
      if (square.kids) {
        for (const kid of square.kids) visit(node, kid);
        return;
      }
      for (const other of square.points!) {
        if (other === node) continue;
        x = other.x - node.x;
        y = other.y - node.y;
        if (x === 0) x = this.jiggle();
        if (y === 0) y = this.jiggle();
        l = x * x + y * y;
        if (l < 1) l = Math.sqrt(l);
        node.vx += (x * strength * alpha) / l;
        node.vy += (y * strength * alpha) / l;
      }
    };
    for (const node of this.nodes) visit(node, root);
  }

  /** Ellipses (point and label) that overlap move apart; a held point does not give way. */
  private collide() {
    const strength = this.forces.collide;
    const nodes = this.nodes;
    if (!strength || nodes.length < 2) return;
    let wide = 1;
    let tall = 1;
    for (const node of nodes) {
      wide = Math.max(wide, node.rx);
      tall = Math.max(tall, node.ry);
    }
    // A grid of cells two widest ellipses wide: overlapping pairs share a cell or touch one.
    const cellX = wide * 2;
    const cellY = tall * 2;
    const px = nodes.map((node) => node.x + node.vx);
    const py = nodes.map((node) => node.y + node.vy);
    const cells = new Map<number, number[]>();
    const key = (cx: number, cy: number) => cx * 1_000_003 + cy;
    nodes.forEach((_, at) => {
      const cell = key(Math.floor(px[at]! / cellX), Math.floor(py[at]! / cellY));
      const list = cells.get(cell);
      if (list) list.push(at);
      else cells.set(cell, [at]);
    });
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]!;
      const cx = Math.floor(px[i]! / cellX);
      const cy = Math.floor(py[i]! / cellY);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const j of cells.get(key(cx + dx, cy + dy)) ?? []) {
            if (j <= i) continue;
            const b = nodes[j]!;
            const heldA = a.fx !== null;
            const heldB = b.fx !== null;
            if (heldA && heldB) continue;
            const spanX = a.rx + b.rx;
            const spanY = a.ry + b.ry;
            let x = px[i]! - px[j]!;
            let y = py[i]! - py[j]!;
            if (x === 0) x = this.jiggle();
            if (y === 0) y = this.jiggle();
            const q = (x / spanX) ** 2 + (y / spanY) ** 2;
            if (q >= 1) continue;
            const d = Math.sqrt(q);
            const k = ((1 - d) / d) * strength;
            // The bigger point gives way less.
            const share = heldA ? 0 : heldB ? 1 : (b.r * b.r) / (a.r * a.r + b.r * b.r);
            a.vx += x * k * share;
            a.vy += y * k * share;
            b.vx -= x * k * (1 - share);
            b.vy -= y * k * (1 - share);
          }
        }
      }
    }
  }
}

function spiral(index: number, cx: number, cy: number) {
  const radius = SPIRAL * Math.sqrt(0.5 + index);
  const angle = index * GOLDEN;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

export type View = { x: number; y: number; k: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** What the points take up, labels included (a label sits under its point). */
export function extent(nodes: SimNode[]): Box | null {
  if (!nodes.length) return null;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const node of nodes) {
    box.x0 = Math.min(box.x0, node.x - node.rx);
    box.x1 = Math.max(box.x1, node.x + node.rx);
    box.y0 = Math.min(box.y0, node.y - node.r);
    box.y1 = Math.max(box.y1, node.y + node.ry);
  }
  return box;
}

/** The view that shows the whole box in the frame, centred, a margin around it, never larger than `most` (100%: labels keep their size). */
export function fitView(box: Box | null, frame: { width: number; height: number }, margin = 28, most = 1): View {
  if (!box) return { x: frame.width / 2, y: frame.height / 2, k: 1 };
  const width = Math.max(1, box.x1 - box.x0);
  const height = Math.max(1, box.y1 - box.y0);
  const k = Math.max(0.05, Math.min(most, (frame.width - margin * 2) / width, (frame.height - margin * 2) / height));
  return { k, x: frame.width / 2 - ((box.x0 + box.x1) / 2) * k, y: frame.height / 2 - ((box.y0 + box.y1) / 2) * k };
}

/** Zoom by `factor` keeping the point under (px, py) where it is. */
export function zoomAt(view: View, px: number, py: number, factor: number, least = 0.05, most = 4): View {
  const k = Math.min(most, Math.max(least, view.k * factor));
  return { k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k };
}
