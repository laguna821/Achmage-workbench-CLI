import type { Artifact } from "@workbench/contracts";

// Pages phase 2: a page `A.md` with an `A/` folder beside it holds subpages (as Obsidian folder
// notes do); the tree shows them nested under it. `A.md` never moves, so revisions and the
// sessions that read it keep pointing at it.

const stemPath = (path: string) => path.replace(/\.(md|markdown)$/i, "");
const parentDir = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/** Documents of a work in tree order: each page followed by its subpages (sorted by name), with their depth. */
export function nestDocs(docs: Artifact[]): { artifact: Artifact; depth: number }[] {
  const pages = new Map(docs.filter((doc) => doc.format === "markdown").map((doc) => [stemPath(doc.path), doc]));
  const children = new Map<string, Artifact[]>();
  const roots: Artifact[] = [];
  for (const doc of docs) {
    const parent = pages.get(parentDir(doc.path));
    if (parent && parent.id !== doc.id) children.set(parent.id, [...(children.get(parent.id) ?? []), doc]);
    else roots.push(doc);
  }
  const out: { artifact: Artifact; depth: number }[] = [];
  const visit = (doc: Artifact, depth: number, seen: Set<string>) => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    out.push({ artifact: doc, depth });
    for (const child of [...(children.get(doc.id) ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }))) visit(child, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const root of roots) visit(root, 0, seen);
  return out;
}
