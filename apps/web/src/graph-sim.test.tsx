import { describe, expect, it } from "vitest";
import { DEFAULT_FORCES, Simulation, extent, fitView, zoomAt, type SimForces, type SimLinkInput, type SimNodeInput } from "./graph-sim.ts";

// The graph's force simulation: same input, same layout; it cools to rest; collisions keep labels
// apart; each kind of line keeps its own length; held points stay where they are.

const point = (id: string, r = 6): SimNodeInput => ({ id, r, rx: 30, ry: r + 16 });

/** Projects p0…p11 in a ring of "관련", and three tags each holding four projects. */
function sample(): { nodes: SimNodeInput[]; links: SimLinkInput[] } {
  const nodes = [...Array.from({ length: 12 }, (_, at) => point(`p${at}`, 6 + (at % 4))), point("t0", 5), point("t1", 5), point("t2", 5)];
  const links: SimLinkInput[] = [
    ...Array.from({ length: 12 }, (_, at) => ({ from: `p${at}`, to: `p${(at + 1) % 12}`, kind: "related" as const })),
    ...Array.from({ length: 12 }, (_, at) => ({ from: `p${at}`, to: `t${at % 3}`, kind: "tag" as const })),
  ];
  return { nodes, links };
}

const settled = (forces: SimForces = DEFAULT_FORCES, data = sample()) => {
  const sim = new Simulation(forces);
  sim.setData(data.nodes, data.links);
  const ticks = sim.settle();
  return { sim, ticks };
};

const meanLength = (sim: Simulation, kind: "related" | "tag") => {
  const lines = sim.links.filter((link) => link.kind === kind);
  return lines.reduce((sum, link) => sum + Math.hypot(link.source.x - link.target.x, link.source.y - link.target.y), 0) / lines.length;
};

describe("graph simulation", () => {
  it("lays the same input out the same way every time", () => {
    const first = settled().sim.nodes.map(({ id, x, y }) => ({ id, x, y }));
    const second = settled().sim.nodes.map(({ id, x, y }) => ({ id, x, y }));
    expect(second).toEqual(first);
    // A fresh start after other data gives that same picture again.
    const sim = new Simulation();
    sim.setData([point("x"), point("y")], []);
    sim.settle();
    sim.setData(sample().nodes, sample().links, { fresh: true });
    sim.settle();
    expect(sim.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(first);
  });

  it("cools to rest within a few seconds of frames and fits inside the frame", () => {
    const { sim, ticks } = settled();
    expect(ticks).toBeLessThanOrEqual(260);
    expect(sim.running).toBe(false);
    for (const node of sim.nodes) expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
    const frame = { width: 900, height: 560 };
    const view = fitView(extent(sim.nodes), frame);
    expect(view.k).toBeGreaterThan(0.5);
    for (const node of sim.nodes) {
      const x = node.x * view.k + view.x;
      const y = node.y * view.k + view.y;
      expect(x - node.rx * view.k).toBeGreaterThanOrEqual(0);
      expect(x + node.rx * view.k).toBeLessThanOrEqual(frame.width);
      expect(y - node.r * view.k).toBeGreaterThanOrEqual(0);
      expect(y + node.ry * view.k).toBeLessThanOrEqual(frame.height);
    }
    // Warmed again (a change), it moves, then rests again.
    sim.reheat(0.3);
    expect(sim.running).toBe(true);
    expect(sim.settle()).toBeGreaterThan(50);
    expect(sim.running).toBe(false);
  });

  it("keeps points (and their labels' room) apart even when everything is pulled to the middle", () => {
    const nodes = Array.from({ length: 30 }, (_, at) => point(`n${at}`));
    const crowd = settled({ ...DEFAULT_FORCES, center: 0.3, repel: 0 }, { nodes, links: [] }).sim;
    let closest = Infinity;
    for (const a of crowd.nodes) {
      for (const b of crowd.nodes) {
        if (a === b) continue;
        closest = Math.min(closest, Math.hypot((a.x - b.x) / (a.rx + b.rx), (a.y - b.y) / (a.ry + b.ry)));
      }
    }
    // 1 = ellipses touching; a little give is allowed (the collision is soft).
    expect(closest).toBeGreaterThan(0.85);
    const loose = settled({ ...DEFAULT_FORCES, center: 0.3, repel: 0, collide: 0 }, { nodes, links: [] }).sim;
    const spread = (sim: Simulation) => {
      const box = extent(sim.nodes)!;
      return (box.x1 - box.x0) * (box.y1 - box.y0);
    };
    expect(spread(crowd)).toBeGreaterThan(spread(loose) * 2);
  });

  it("gives each kind of line its own length", () => {
    const with60 = settled({ ...DEFAULT_FORCES, links: { ...DEFAULT_FORCES.links, related: { strength: 0.9, distance: 60 } } }).sim;
    const with220 = settled({ ...DEFAULT_FORCES, links: { ...DEFAULT_FORCES.links, related: { strength: 0.9, distance: 220 } } }).sim;
    expect(meanLength(with220, "related")).toBeGreaterThan(meanLength(with60, "related") * 1.8);
    const shortTags = settled({ ...DEFAULT_FORCES, links: { ...DEFAULT_FORCES.links, tag: { strength: 0.9, distance: 40 } } }).sim;
    const longTags = settled({ ...DEFAULT_FORCES, links: { ...DEFAULT_FORCES.links, tag: { strength: 0.9, distance: 200 } } }).sim;
    expect(meanLength(longTags, "tag")).toBeGreaterThan(meanLength(shortTags, "tag") * 1.5);
    // A line with no strength does not pull.
    const slack = settled({ ...DEFAULT_FORCES, links: { related: { strength: 0, distance: 10 }, tag: { strength: 0, distance: 10 } } }).sim;
    expect(meanLength(slack, "related")).toBeGreaterThan(meanLength(with60, "related"));
  });

  it("holds pinned points where they were put; the rest settles around them", () => {
    const { sim } = settled();
    const before = new Map(sim.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    sim.pin("p0", 400, -300);
    sim.reheat(1);
    sim.settle();
    const held = sim.node("p0")!;
    expect([held.x, held.y]).toEqual([400, -300]);
    // Its neighbours were pulled towards it.
    const neighbour = sim.node("p1")!;
    expect(Math.hypot(neighbour.x - 400, neighbour.y + 300)).toBeLessThan(Math.hypot(before.get("p1")!.x - 400, before.get("p1")!.y + 300));
    expect(sim.releaseAll()).toBe(1);
    expect(sim.releaseAll()).toBe(0);
    sim.reheat(0.5);
    sim.settle();
    expect(Math.hypot(sim.node("p0")!.x - 400, sim.node("p0")!.y + 300)).toBeGreaterThan(50);
  });

  it("keeps known points where they are when data changes, and puts a newcomer beside its neighbour", () => {
    const { sim } = settled();
    const before = sim.node("p3")!;
    const at = { x: before.x, y: before.y };
    const data = sample();
    const change = sim.setData([...data.nodes, point("new")], [...data.links, { from: "new", to: "p3", kind: "related" }]);
    expect(change).toEqual({ added: 1, removed: 0, fresh: false });
    expect({ x: sim.node("p3")!.x, y: sim.node("p3")!.y }).toEqual(at);
    const newcomer = sim.node("new")!;
    expect(Math.hypot(newcomer.x - at.x, newcomer.y - at.y)).toBeLessThan(40);
    // Positions remembered from before (the graph opened again) come back as they were, pins too.
    const again = new Simulation();
    const known = new Map(sim.nodes.map((node) => [node.id, { x: node.x, y: node.y, pinned: node.id === "p5" }]));
    expect(again.setData(data.nodes, data.links, { known }).fresh).toBe(false);
    expect(again.node("p3")!.x).toBe(at.x);
    expect(again.node("p5")!.fx).toBe(sim.node("p5")!.x);
  });

  it("runs 300 points and 600 lines fast enough for a frame", () => {
    const nodes = Array.from({ length: 300 }, (_, at) => point(`n${at}`, 5 + (at % 7)));
    const links: SimLinkInput[] = Array.from({ length: 600 }, (_, at) => ({ from: `n${at % 300}`, to: `n${(at * 37 + 11) % 300}`, kind: at % 3 ? "related" : "tag" }));
    const sim = new Simulation();
    sim.setData(nodes, links);
    const start = performance.now();
    const ticks = sim.settle();
    const perTick = (performance.now() - start) / ticks;
    console.log(`graph simulation: 300 points, ${sim.links.length} lines — ${ticks} ticks, ${perTick.toFixed(2)} ms a tick`);
    expect(perTick).toBeLessThan(8);
  });

  it("zooms at the pointer and fits a box", () => {
    const view = zoomAt({ x: 100, y: 50, k: 1 }, 300, 200, 2);
    expect(view).toEqual({ k: 2, x: -100, y: -100 });
    // The world point under the pointer stays under it.
    expect((300 - view.x) / view.k).toBe((300 - 100) / 1);
    expect(zoomAt(view, 0, 0, 100).k).toBe(4);
    expect(fitView({ x0: -50, y0: -25, x1: 50, y1: 25 }, { width: 400, height: 200 }, 0, 10)).toEqual({ k: 4, x: 200, y: 100 });
    expect(fitView(null, { width: 400, height: 200 })).toEqual({ k: 1, x: 200, y: 100 });
  });
});
