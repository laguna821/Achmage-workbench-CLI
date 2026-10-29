import {
  FORMAT_LABEL,
  PROVIDER_LABEL,
  isHexColor,
  isUnseen,
  type DocFormat,
  type Folder,
  type ProjectStage,
  type ProjectSummary,
  type PropertyField,
  type PropertyType,
  type Provider,
  type Session,
  type Work,
} from "@workbench/contracts";
import { hintOptions, type KeyDef, type KnownValue, type SortDef } from "../../groups.ts";
import { bucketOf, recency, type DocEntry } from "../../overview.ts";
import { linkLabel } from "../../project.ts";
import { queryProject, type QueryProject } from "../../project-query.ts";
import type { State } from "../../state.ts";
import { folderHidden, workHidden } from "../../tree.ts";
import { keyLabel } from "../project/PropertiesPanel.tsx";

// What home's views group, sort and show, mode by mode: projects (프로젝트), sessions (지금) and
// documents (문서). Each key says how its values read and whether a board card may be dragged
// between its groups (and if not, why — said to the person when they try).

/** A project as home's views see it: the work, what its note says, and what its sessions are doing. */
export type ProjectRow = {
  work: Work;
  summary: ProjectSummary | undefined;
  sessions: Session[];
  attention: number;
  proposals: number;
  unseen: number;
  /** Latest activity: the work's or a session's change. */
  last: number;
  /** In the archive (the archive stage's group) or in an archived folder. */
  archived: boolean;
};

export type ProjectContext = {
  state: State;
  summaries: Map<string, ProjectSummary>;
  stages: ProjectStage[];
  template: PropertyField[];
  engineColor: (provider: Provider) => string;
};

/** Every project (archived ones too: the archive stage's group and the graph show them). */
export function projectRows(state: State, summaries: Map<string, ProjectSummary>): ProjectRow[] {
  const pending = new Map<string, number>();
  for (const proposal of Object.values(state.proposals)) {
    if (proposal.status !== "pending") continue;
    const workId = state.artifacts[proposal.artifactId]?.workId;
    if (workId) pending.set(workId, (pending.get(workId) ?? 0) + 1);
  }
  const byWork = new Map<string, Session[]>();
  for (const session of Object.values(state.sessions)) {
    if (session.archivedAt) continue;
    const list = byWork.get(session.workId);
    if (list) list.push(session);
    else byWork.set(session.workId, [session]);
  }
  return Object.values(state.works).map((work) => {
    const sessions = byWork.get(work.id) ?? [];
    let last = work.updatedAt;
    let attention = 0;
    let unseen = 0;
    for (const session of sessions) {
      last = Math.max(last, session.updatedAt);
      if (session.status === "awaitingApproval") attention += 1;
      if (isUnseen(session)) unseen += 1;
    }
    return { work, summary: summaries.get(work.id), sessions, attention, proposals: pending.get(work.id) ?? 0, unseen, last, archived: workHidden(state, work) };
  });
}

/** What the shared query reads of a project. */
export const projectQuery = (row: ProjectRow, folders: State["folders"]): QueryProject => queryProject(row.work, row.summary, folders);

/** A folder's own colour, when the navigator gave it one (an optional field of `Folder`). */
const folderColor = (folder: Folder | undefined) => {
  const value = (folder as { color?: unknown } | undefined)?.color;
  return isHexColor(value) ? value : null;
};

/** Visible folders in the tree's order, each with its path as its name and its depth. */
function folderValues(state: State): KnownValue[] {
  const out: KnownValue[] = [];
  const walk = (parentId: string | null, path: string[], depth: number) => {
    const children = Object.values(state.folders)
      .filter((folder) => folder.parentId === parentId && !folder.archivedAt)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ko"));
    for (const folder of children) {
      const names = [...path, folder.name];
      out.push({ id: folder.id, label: names.join(" / "), color: folderColor(folder), depth });
      walk(folder.id, names, depth + 1);
    }
  };
  walk(null, [], 0);
  return out;
}

const visibleFolder = (state: State, folderId: string | null) => (folderId && state.folders[folderId] && !folderHidden(state, folderId) ? [folderId] : []);

/** How a property key reads: Korean names for Obsidian's English ones, without the colon some vault keys end in. */
export const propLabel = (key: string) => keyLabel(key).replace(/:$/, "");

/**
 * Properties to group, sort and show by: the template's, then every other key the notes have, each
 * with its kind and how it reads ("DIKM_단계:" → "DIKM_단계"; a key keeps its colon when the same
 * name without one is there too, so "종류" and the vault's "종류:" stay apart).
 */
export function propertyKeys(summaries: Iterable<ProjectSummary>, template: PropertyField[]): { key: string; type: PropertyType; label: string; hint?: string }[] {
  const kinds = new Map<string, PropertyType>();
  for (const summary of summaries) for (const property of summary.properties) if (!kinds.has(property.key)) kinds.set(property.key, property.type);
  const out: { key: string; type: PropertyType; label: string; hint?: string }[] = [];
  const seen = new Set<string>();
  const add = (key: string, type: PropertyType, hint?: string) => {
    // The stage and the tags have keys of their own ("단계", "태그").
    if (seen.has(key) || type === "stage" || key === "tags") return;
    seen.add(key);
    out.push({ key, type, label: propLabel(key), ...(hint ? { hint } : {}) });
  };
  for (const field of template) add(field.key, kinds.get(field.key) ?? field.type, field.hint);
  for (const [key, type] of kinds) add(key, type);
  for (const entry of out) if (entry.key.endsWith(":") && seen.has(entry.key.slice(0, -1))) entry.label = keyLabel(entry.key);
  return out;
}

const valuesOf = (row: ProjectRow, key: string) => row.summary?.properties.find((property) => property.key === key)?.values ?? [];

const MANY = "태그처럼 값이 여럿인 속성은 끌어서 바꾸지 않습니다. 프로젝트 속성에서 고칩니다.";

/** The topic particle after a word: "은" after a final consonant (마감일은), "는" after a vowel (날짜는), "은(는)" after anything else. */
export function topicParticle(word: string) {
  const code = word.trim().slice(-1).charCodeAt(0) - 0xac00;
  if (Number.isNaN(code) || code < 0 || code > 11171) return "은(는)";
  return code % 28 ? "은" : "는";
}
const ENGINE = "엔진은 세션이 정하므로 끌어서 바꿀 수 없습니다.";

/** A property as a key; a text or list field whose hint lists options ("높음 · 보통 · 낮음") knows them, in that order. */
export function propertyKey(key: string, type: PropertyType, hint?: string, label = propLabel(key)): KeyDef<ProjectRow> {
  const options = type === "text" || type === "list" ? hintOptions(hint) : [];
  const base = { key: `prop:${key}`, label, values: (row: ProjectRow) => valuesOf(row, key), ...(options.length ? { known: options.map((option) => ({ id: option, label: option })) } : {}) };
  switch (type) {
    case "number":
      return { ...base, kind: "number", fixed: null };
    case "checkbox":
      return { ...base, kind: "checkbox", fixed: null };
    case "date":
    case "datetime":
      return { ...base, kind: "date", fixed: `'${base.label}'${topicParticle(base.label)} 기간으로 묶여 있어 끌어서 정할 수 없습니다. 날짜는 프로젝트 속성에서 고칩니다.` };
    case "tags":
      return { ...base, kind: "list", fixed: MANY };
    case "links":
      return { ...base, kind: "list", fixed: MANY, show: linkLabel };
    case "list":
      return { ...base, kind: "list", fixed: null };
    default:
      return { ...base, kind: "text", fixed: null };
  }
}

const ENGINE_BOTH = "both";

/** Keys a project can be grouped by: 단계, 폴더, 태그, every property, 최근 활동, 만든 날, 엔진. */
export function projectKeys(context: ProjectContext): KeyDef<ProjectRow>[] {
  const { state, stages, engineColor } = context;
  const archive = stages.find((stage) => stage.archive)?.name ?? null;
  return [
    {
      key: "stage",
      label: "단계",
      kind: "choice",
      known: [...stages.filter((stage) => !stage.archive), ...stages.filter((stage) => stage.archive)].map((stage) => ({ id: stage.name, label: stage.name, color: stage.color })),
      values: (row) => (row.work.archivedAt && archive ? [archive] : row.summary?.stage ? [row.summary.stage] : []),
      fixed: null,
    },
    { key: "folder", label: "폴더", kind: "choice", known: folderValues(state), none: "폴더 밖", values: (row) => visibleFolder(state, row.work.folderId), fixed: null },
    { key: "tags", label: "태그", kind: "list", values: (row) => (row.summary?.tags.length ? row.summary.tags : (row.work.tags ?? [])), fixed: MANY, show: (tag) => `#${tag}` },
    ...propertyKeys(context.summaries.values(), context.template).map((entry) => propertyKey(entry.key, entry.type, entry.hint, entry.label)),
    { key: "activity", label: "최근 활동", kind: "past", values: (row) => [row.last], fixed: "최근 활동은 기록에서 오므로 끌어서 바꿀 수 없습니다." },
    { key: "created", label: "만든 날", kind: "past", values: (row) => [row.work.createdAt], fixed: "만든 날은 끌어서 바꿀 수 없습니다." },
    {
      key: "engine",
      label: "엔진",
      kind: "choice",
      known: [
        { id: "claude", label: PROVIDER_LABEL.claude, color: engineColor("claude") },
        { id: "codex", label: PROVIDER_LABEL.codex, color: engineColor("codex") },
        { id: ENGINE_BOTH, label: "둘 다" },
      ],
      none: "세션 없음",
      values: (row) => {
        const engines = new Set(row.sessions.map((session) => session.provider));
        return engines.size > 1 ? [ENGINE_BOTH] : [...engines];
      },
      fixed: ENGINE,
    },
  ];
}

/** A property's value to sort by (dates and names as text, numbers as numbers, a hint's options in their order). */
const sortValue = (values: string[], type: PropertyType, options: string[]): string | number | null => {
  const first = values[0]?.trim();
  if (!first) return null;
  if (type === "number") return Number.isFinite(Number(first)) ? Number(first) : first;
  if (type === "links") return linkLabel(first);
  const at = options.indexOf(first);
  return options.length ? `${String(at < 0 ? 999 : at).padStart(3, "0")} ${first}` : first;
};

/** What projects sort by. */
export function projectSorts(context: Pick<ProjectContext, "stages" | "summaries" | "template">): SortDef<ProjectRow>[] {
  const order = new Map(context.stages.map((stage, index) => [stage.name, index] as const));
  return [
    { key: "activity", label: "최근 활동", value: (row) => row.last },
    { key: "created", label: "만든 날", value: (row) => row.work.createdAt },
    { key: "title", label: "이름", value: (row) => row.work.title },
    { key: "stage", label: "단계", value: (row) => (row.summary?.stage ? (order.get(row.summary.stage) ?? order.size) : null) },
    { key: "sessions", label: "세션 수", value: (row) => row.sessions.length },
    { key: "attention", label: "확인 필요", value: (row) => row.attention },
    { key: "proposals", label: "수정안", value: (row) => row.proposals },
    ...propertyKeys(context.summaries.values(), context.template).map((entry) => {
      const options = entry.type === "text" || entry.type === "list" ? hintOptions(entry.hint) : [];
      return { key: `prop:${entry.key}`, label: entry.label, value: (row: ProjectRow) => sortValue(valuesOf(row, entry.key), entry.type, options) };
    }),
  ];
}

/** Fields a project shows, beside its name. */
export function projectFields(context: Pick<ProjectContext, "summaries" | "template">): { id: string; label: string }[] {
  return [
    { id: "stage", label: "단계" },
    { id: "folder", label: "폴더" },
    { id: "tags", label: "태그" },
    { id: "preview", label: "미리보기" },
    { id: "chips", label: "세션·문서" },
    { id: "sessions", label: "세션" },
    { id: "attention", label: "확인 필요" },
    { id: "proposals", label: "수정안" },
    { id: "activity", label: "마지막 활동" },
    { id: "created", label: "만든 날" },
    ...propertyKeys(context.summaries.values(), context.template).map((entry) => ({ id: `prop:${entry.key}`, label: entry.label })),
  ];
}

/** What each layout shows when the view has not chosen (today's table, kanban cards, cards and rows). */
export const DEFAULT_PROJECT_FIELDS: Record<"table" | "board" | "cards" | "list", string[]> = {
  table: ["stage", "tags", "sessions", "attention", "proposals", "activity"],
  board: ["tags", "attention", "proposals", "sessions", "activity"],
  cards: ["stage", "chips", "sessions", "activity"],
  list: ["stage", "preview", "tags", "activity"],
};

// ── 지금: sessions ──────────────────────────────────────────────────────────

export function sessionKeys(state: State, engineColor: (provider: Provider) => string): KeyDef<Session>[] {
  const fixed = "세션은 프로젝트에 딸려 있어 여기서 옮기지 않습니다.";
  return [
    {
      key: "status",
      label: "상태",
      kind: "choice",
      known: [
        { id: "attention", label: "확인 필요", color: "var(--amber)" },
        { id: "trouble", label: "오류·멈춤", color: "var(--danger)" },
        { id: "unseen", label: "새 답", color: "var(--accent)" },
        { id: "running", label: "진행", color: "var(--ok)" },
        { id: "queued", label: "예약 있음" },
      ],
      none: "조용함",
      values: (session) => {
        const bucket = bucketOf(session);
        return bucket ? [bucket] : [];
      },
      fixed: "상태는 엔진이 정하므로 끌어서 바꿀 수 없습니다.",
    },
    { key: "folder", label: "폴더", kind: "choice", known: folderValues(state), none: "폴더 밖", values: (session) => visibleFolder(state, state.works[session.workId]?.folderId ?? null), fixed },
    { key: "project", label: "프로젝트", kind: "text", values: (session) => [session.workId], show: (id) => state.works[id]?.title ?? id, fixed },
    {
      key: "engine",
      label: "엔진",
      kind: "choice",
      known: (["claude", "codex"] as const).map((provider) => ({ id: provider, label: PROVIDER_LABEL[provider], color: engineColor(provider) })),
      values: (session) => [session.provider],
      fixed: ENGINE,
    },
    { key: "activity", label: "최근 활동", kind: "past", values: (session) => [recency(session)], fixed: "최근 활동은 기록에서 오므로 끌어서 바꿀 수 없습니다." },
  ];
}

export function sessionSorts(state: State): SortDef<Session>[] {
  return [
    { key: "activity", label: "최근 활동", value: recency },
    { key: "title", label: "이름", value: (session) => session.purpose },
    { key: "project", label: "프로젝트", value: (session) => state.works[session.workId]?.title ?? null },
  ];
}

// ── 문서 ────────────────────────────────────────────────────────────────────

const FORMATS = Object.keys(FORMAT_LABEL) as DocFormat[];

export function docKeys(state: State): KeyDef<DocEntry>[] {
  const fixed = "문서는 끌어서 옮기지 않습니다.";
  return [
    { key: "project", label: "프로젝트", kind: "text", values: (entry) => [entry.work.id], show: (id) => state.works[id]?.title ?? id, fixed },
    { key: "folder", label: "폴더", kind: "choice", known: folderValues(state), none: "폴더 밖", values: (entry) => visibleFolder(state, entry.work.folderId), fixed },
    { key: "format", label: "형식", kind: "choice", known: FORMATS.map((format) => ({ id: format, label: FORMAT_LABEL[format] })), values: (entry) => [entry.artifact.format], fixed },
    { key: "modified", label: "고친 때", kind: "past", values: (entry) => [entry.artifact.updatedAt], fixed },
  ];
}

export function docSorts(): SortDef<DocEntry>[] {
  return [
    { key: "modified", label: "고친 때", value: (entry) => entry.artifact.updatedAt },
    { key: "name", label: "이름", value: (entry) => entry.artifact.name },
    { key: "project", label: "프로젝트", value: (entry) => entry.work.title },
    { key: "format", label: "형식", value: (entry) => FORMAT_LABEL[entry.artifact.format] },
    { key: "revision", label: "판", value: (entry) => entry.artifact.revision },
  ];
}

export const DOC_FIELDS: { id: string; label: string }[] = [
  { id: "project", label: "프로젝트" },
  { id: "folder", label: "폴더" },
  { id: "format", label: "형식" },
  { id: "revision", label: "판" },
  { id: "modified", label: "고친 때" },
  { id: "proposals", label: "수정안" },
];

export const DEFAULT_DOC_FIELDS: Record<"list" | "table", string[]> = {
  list: ["project", "revision", "modified"],
  table: ["project", "format", "revision", "modified", "proposals"],
};
