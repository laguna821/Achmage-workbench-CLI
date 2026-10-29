// The filter boxes' language for projects (the sidebar's project list and home's views share it).
// No model is asked: words are read here, the same way everywhere.

import type { Folder, ProjectSummary, Work } from "@workbench/contracts";

/** What a query reads of one project. */
export type QueryProject = {
  title: string;
  stage: string | null;
  tags: string[];
  properties: { key: string; values: string[] }[];
  /** The project folder's path of names ("강의/2026-2"), or null outside any folder. */
  folder: string | null;
};

type Term = { not: boolean } & ({ kind: "word"; text: string } | { kind: "tag"; tag: string } | { kind: "prop"; key: string; quoted: boolean; value: string });

/** Words of a query: spaces split, double quotes keep spaces together. */
function words(query: string) {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of query) {
    if (character === '"') quoted = !quoted;
    if (!quoted && /\s/.test(character)) {
      if (current) out.push(current);
      current = "";
    } else current += character;
  }
  if (current) out.push(current);
  return out;
}

const unquote = (text: string) => (text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text);
const lower = (text: string) => text.toLocaleLowerCase("ko");

function term(raw: string): Term {
  const not = raw.length > 1 && raw.startsWith("-");
  const word = not ? raw.slice(1) : raw;
  if (word.startsWith("#") && word.length > 1) return { not, kind: "tag", tag: lower(word.slice(1)) };
  // `"키":값` keeps a key with its own colon (the vault's "종류:"); `키:값` otherwise.
  const quotedKey = /^"([^"]+)":(.*)$/.exec(word);
  if (quotedKey) return { not, kind: "prop", key: quotedKey[1]!, quoted: true, value: lower(unquote(quotedKey[2]!)) };
  const colon = word.indexOf(":");
  if (colon > 0) return { not, kind: "prop", key: word.slice(0, colon), quoted: false, value: lower(unquote(word.slice(colon + 1))) };
  return { not, kind: "word", text: lower(unquote(word)) };
}

function holds(term: Term, project: QueryProject): boolean {
  if (term.kind === "word") return lower(project.title).includes(term.text);
  // A tag as it is being typed finds the tags it begins (and so the ones under it, "강의/2026-2").
  if (term.kind === "tag") return project.tags.some((tag) => lower(tag).startsWith(term.tag));
  const key = term.key;
  if (key === "단계" || key === "stage") return term.value ? lower(project.stage ?? "") === term.value : Boolean(project.stage);
  if (key === "폴더" || key === "folder") {
    const folder = lower(project.folder ?? "");
    return term.value ? folder === term.value || folder.startsWith(`${term.value}/`) || folder.split("/").includes(term.value) : Boolean(project.folder);
  }
  // A key written without its colon also finds the vault's keys that end in one ("종류" → "종류:").
  const values = project.properties.filter((entry) => entry.key === key || (!term.quoted && entry.key === `${key}:`)).flatMap((entry) => entry.values);
  if (!term.value) return values.some((value) => value.trim() !== "");
  return values.some((value) => lower(value).includes(term.value));
}

/**
 * A query as the filter boxes take it: words match the name; `#태그` a tag (or one under it);
 * `단계:진행중`; `폴더:강의` (that folder or one inside it); `키:값` any property (part of a value,
 * `키:` = has a value; `"종류:":강의` for a key with its own colon); `-` in front negates.
 */
export function projectMatcher(query: string): (project: QueryProject) => boolean {
  const terms = words(query.trim()).map(term);
  if (!terms.length) return () => true;
  return (project) => terms.every((entry) => holds(entry, project) !== entry.not);
}

/** A folder's path of names from the top ("강의/2026-2"); null for none or one no longer there. */
export function folderPath(folders: Record<string, Pick<Folder, "name" | "parentId">>, id: string | null): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let at = id; at && folders[at] && !seen.has(at); at = folders[at]!.parentId) {
    seen.add(at);
    names.unshift(folders[at]!.name);
  }
  return names.length ? names.join("/") : null;
}

/** What a query reads of a work and its note's summary (the note's tags first, else the work's). */
export function queryProject(work: Pick<Work, "title" | "tags" | "folderId">, summary: ProjectSummary | undefined, folders: Record<string, Pick<Folder, "name" | "parentId">>): QueryProject {
  return {
    title: work.title,
    stage: summary?.stage ?? null,
    tags: summary?.tags.length ? summary.tags : (work.tags ?? []),
    properties: summary?.properties ?? [],
    folder: folderPath(folders, work.folderId),
  };
}
