// The projects' graph (P4): projects and, optionally, their tags as points; "관련" links and shared
// tags as lines. What is shown follows the graph's filters (graph-settings.ts); where the points go
// is the force simulation (graph-sim.ts). No AI, no library.

export type GraphNode = { id: string; kind: "project" | "tag"; label: string; weight: number; archived?: true };
/** `from` → `to`: the project whose note names the other under "관련"; `mutual` when both do. */
export type GraphEdge = { from: string; to: string; kind: "related" | "tag"; mutual?: true };

export type GraphInput = { id: string; title: string; tags: string[]; related: string[]; sessions: number; archived?: boolean }[];

const linkName = (value: string) => value.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.split("#")[0]!.trim().toLowerCase();

/** Points and lines: a project per entry, a tag node per tag (when asked), "관련" resolved by title. */
export function buildGraph(projects: GraphInput, withTags: boolean): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byTitle = new Map(projects.map((project) => [project.title.trim().toLowerCase(), project.id] as const));
  const nodes: GraphNode[] = projects.map((project) => ({ id: `p:${project.id}`, kind: "project", label: project.title, weight: 1 + Math.min(project.sessions, 12), ...(project.archived ? { archived: true as const } : {}) }));
  const edges: GraphEdge[] = [];
  const known = new Map<string, GraphEdge>();
  const add = (from: string, to: string, kind: GraphEdge["kind"]) => {
    if (from === to) return;
    const key = [from, to].sort().join("|");
    const seen = known.get(key);
    if (seen) {
      // Named from both notes: one line, both ways.
      if (kind === "related" && seen.kind === "related" && seen.from === to) seen.mutual = true;
      return;
    }
    const edge: GraphEdge = { from, to, kind };
    known.set(key, edge);
    edges.push(edge);
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
 * The graph's own filter, words separated by spaces: a name has each word in it, "#태그" asks for a
 * tag starting so, and "-말" (or "-#태그") leaves those out.
 */
export function matchesSearch(project: GraphInput[number], search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const title = project.title.toLowerCase();
  const tags = project.tags.map((tag) => tag.replace(/^#/, "").toLowerCase());
  return words.every((word) => {
    const not = word.length > 1 && word.startsWith("-");
    const term = not ? word.slice(1) : word;
    const hit = term.startsWith("#") ? tags.some((tag) => tag.startsWith(term.slice(1))) : title.includes(term);
    return not ? !hit : hit;
  });
}

export type GraphFilter = { tags: boolean; archived: boolean; orphans: boolean; search: string };

/** The graph as the filters show it: archived projects and unlinked ones only when asked. */
export function filterGraph(projects: GraphInput, filter: GraphFilter): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const shown = projects.filter((project) => (filter.archived || !project.archived) && matchesSearch(project, filter.search));
  const graph = buildGraph(shown, filter.tags);
  if (filter.orphans) return graph;
  const linked = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  return { nodes: graph.nodes.filter((node) => node.kind === "tag" || linked.has(node.id)), edges: graph.edges };
}

/** The label under a point: long names end in "…" (the whole name is its tooltip). */
export const shortLabel = (label: string) => (label.length > 18 ? `${label.slice(0, 17)}…` : label);

const WIDE = /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦…]/;

/** About how wide a label is at `size` px, without measuring: Hangul and CJK a full em, Latin about half. */
export function labelWidth(text: string, size: number): number {
  let em = 0;
  for (const char of text) em += WIDE.test(char) ? 1 : char === " " ? 0.3 : /[A-Z0-9#@%&]/.test(char) ? 0.62 : 0.52;
  return em * size;
}

/** A point's radius and the half axes of the ellipse it keeps clear for itself and its label (below it). */
export function pointShape(node: GraphNode, scale: number, labelSize: number) {
  const r = (node.kind === "project" ? 5 + node.weight * 0.9 : 4 + node.weight) * scale;
  const half = Math.min(labelWidth(shortLabel(node.label), labelSize) / 2, labelSize * 5.5);
  return { r, rx: Math.max(r, half) + 4, ry: r + labelSize + 4 };
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
