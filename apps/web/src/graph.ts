// The projects' graph (P4): projects and, optionally, their tags as points; "관련" links and shared
// tags as lines. Laid out once by a small force simulation run to rest (no animation, so it also
// suits reduced motion), deterministic for the same input. No AI, no library.

export type GraphNode = { id: string; kind: "project" | "tag"; label: string; weight: number };
export type GraphEdge = { from: string; to: string; kind: "related" | "tag" };
export type Placed = GraphNode & { x: number; y: number };

export type GraphInput = { id: string; title: string; tags: string[]; related: string[]; sessions: number }[];

const linkName = (value: string) => value.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.split("#")[0]!.trim().toLowerCase();

/** Points and lines: a project per entry, a tag node per tag (when asked), "관련" resolved by title. */
export function buildGraph(projects: GraphInput, withTags: boolean): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byTitle = new Map(projects.map((project) => [project.title.trim().toLowerCase(), project.id] as const));
  const nodes: GraphNode[] = projects.map((project) => ({ id: `p:${project.id}`, kind: "project", label: project.title, weight: 1 + Math.min(project.sessions, 12) }));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: GraphEdge["kind"]) => {
    const key = [from, to].sort().join("|");
    if (from === to || seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };
  for (const project of projects) {
    for (const value of project.related) {
      const target = byTitle.get(linkName(value));
      if (target) add(`p:${project.id}`, `p:${target}`, "related");
    }
  }
  if (withTags) {
    const tags = new Map<string, number>();
    for (const project of projects) for (const tag of project.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    for (const [tag, count] of tags) nodes.push({ id: `t:${tag}`, kind: "tag", label: `#${tag}`, weight: 1 + Math.min(count, 8) * 0.5 });
    for (const project of projects) for (const tag of project.tags) add(`p:${project.id}`, `t:${tag}`, "tag");
  }
  return { nodes, edges };
}

/**
 * Positions at rest (Fruchterman–Reingold): points push apart, lines pull together, a pull to the
 * middle gathers unlinked points into a disc; then the whole drawing is fitted into the frame
 * (scaled, never piled against its edges). Starts on a spiral, so the result is the same each time.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[], size: { width: number; height: number }, rounds = 300): Placed[] {
  const n = nodes.length;
  if (!n) return [];
  const cx = size.width / 2;
  const cy = size.height / 2;
  const k = Math.sqrt((size.width * size.height) / n) * 0.7;
  // A golden-angle spiral: spread out, no randomness.
  const pos = nodes.map((_, index) => {
    const radius = k * 0.5 * Math.sqrt(index + 0.5);
    const angle = index * 2.399963229728653;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  const at = new Map(nodes.map((node, index) => [node.id, index] as const));
  const links = edges.flatMap((edge) => {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    return a === undefined || b === undefined ? [] : [[a, b] as const];
  });
  let heat = Math.max(size.width, size.height) / 8;
  for (let round = 0; round < rounds; round += 1) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = pos[i]!.x - pos[j]!.x;
        const dy = pos[i]!.y - pos[j]!.y;
        const distance = Math.max(0.5, Math.hypot(dx, dy));
        const force = (k * k) / distance;
        disp[i]!.x += (dx / distance) * force;
        disp[i]!.y += (dy / distance) * force;
        disp[j]!.x -= (dx / distance) * force;
        disp[j]!.y -= (dy / distance) * force;
      }
    }
    for (const [a, b] of links) {
      const dx = pos[a]!.x - pos[b]!.x;
      const dy = pos[a]!.y - pos[b]!.y;
      const distance = Math.max(0.5, Math.hypot(dx, dy));
      const force = (distance * distance) / k;
      disp[a]!.x -= (dx / distance) * force;
      disp[a]!.y -= (dy / distance) * force;
      disp[b]!.x += (dx / distance) * force;
      disp[b]!.y += (dy / distance) * force;
    }
    for (let i = 0; i < n; i += 1) {
      // The pull to the middle grows with the distance: unlinked points settle as a disc.
      disp[i]!.x += (cx - pos[i]!.x) * 0.9;
      disp[i]!.y += (cy - pos[i]!.y) * 0.9;
      const length = Math.max(0.01, Math.hypot(disp[i]!.x, disp[i]!.y));
      const step = Math.min(length, heat);
      pos[i]!.x += (disp[i]!.x / length) * step;
      pos[i]!.y += (disp[i]!.y / length) * step;
    }
    heat = Math.max(0.5, heat * 0.97);
  }
  // Fit the drawing into the frame, centred, with room for the labels.
  const margin = 44;
  const xs = pos.map((point) => point.x);
  const ys = pos.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(1, Math.max(...xs) - minX);
  const height = Math.max(1, Math.max(...ys) - minY);
  const scale = Math.min((size.width - margin * 2) / width, (size.height - margin * 2) / height, 1.6);
  const offsetX = cx - (minX + width / 2) * scale;
  const offsetY = cy - (minY + height / 2) * scale;
  return nodes.map((node, index) => ({ ...node, x: pos[index]!.x * scale + offsetX, y: pos[index]!.y * scale + offsetY }));
}

/** Projects joined to this one: by "관련" (either way) and by shared tags. */
export function neighbours(projects: GraphInput, id: string): { id: string; by: "related" | "tag"; tags: string[] }[] {
  const me = projects.find((project) => project.id === id);
  if (!me) return [];
  const { edges } = buildGraph(projects, false);
  const related = new Set(edges.flatMap((edge) => (edge.from === `p:${id}` ? [edge.to.slice(2)] : edge.to === `p:${id}` ? [edge.from.slice(2)] : [])));
  const out: { id: string; by: "related" | "tag"; tags: string[] }[] = [...related].map((other) => ({ id: other, by: "related", tags: [] }));
  for (const other of projects) {
    if (other.id === id || related.has(other.id)) continue;
    const shared = other.tags.filter((tag) => me.tags.includes(tag));
    if (shared.length) out.push({ id: other.id, by: "tag", tags: shared });
  }
  return out;
}
