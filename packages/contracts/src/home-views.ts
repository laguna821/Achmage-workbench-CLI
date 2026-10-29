// Home's views (프로젝트-내비게이터-그룹보기-설계 §3): each of the four home modes has named views,
// like the views of an Obsidian `.base` file — a layout, a filter in the shared project query, a
// sort, a group and a subgroup (Notion-like), the fields shown, how groups look (Bases Look: a
// colour per group, borders, a light tint, emphasized headings) and which groups are folded.
// Kept in the screen preferences (`homeViews`), so every window shows the same.

export type HomeViewMode = "now" | "projects" | "flow" | "docs";

export type ViewLayout = "board" | "table" | "cards" | "list" | "graph" | "calendar";

/** The layouts each mode offers (the first is a new view's). */
export const VIEW_LAYOUTS: Record<HomeViewMode, ViewLayout[]> = {
  now: ["list", "board"],
  projects: ["board", "table", "cards", "list", "graph"],
  flow: ["calendar"],
  docs: ["cards", "list", "table"],
};

export const LAYOUT_LABEL: Record<ViewLayout, string> = { board: "보드", table: "표", cards: "카드", list: "목록", graph: "그래프", calendar: "달력" };

/** Dates as Korean periods (지남·오늘·내일… or 오늘·어제·…), by month, or by week (Monday first). */
export type DateBuckets = "period" | "month" | "week";

/** The group id of "값 없음" (no value). */
export const NO_VALUE = "";

export type GroupRule = {
  /**
   * What to group by: "stage", "folder", "tags", "activity", "created", "engine", "status",
   * "project", "format", "modified", or a project property as written in the note, "prop:<key>".
   */
  key: string;
  /** For dates. */
  dates?: DateBuckets;
  /** The key's own order, reversed ("값 없음" stays last). */
  reverse?: boolean;
  /** Leave out groups with nothing in them. */
  hideEmpty?: boolean;
};

export type SortRule = { key: string; dir: "asc" | "desc" };

/**
 * How groups look (Bases Look): a colour per group (`<key>=<group id>` → `#rrggbb`), borders in that
 * colour (a band on top of board columns), a light tint of it (0–30 %), and emphasized headings.
 */
export type GroupLook = { colors: Record<string, string>; border: boolean; tint: number; heading: boolean };

export type HomeView = {
  id: string;
  name: string;
  layout: ViewLayout;
  /** The shared project query (`apps/web/src/project-query.ts`); empty shows everything. */
  filter: string;
  sort: SortRule | null;
  group: GroupRule | null;
  /** Board rows (swimlanes), or groups inside groups elsewhere. */
  subgroup: GroupRule | null;
  /** Fields shown (table columns, lines of cards and rows); null: the layout's own. */
  fields: string[] | null;
  look: GroupLook;
  /** Folded groups: `<key>=<id>`, or `<key>=<id>\n<subkey>=<subid>` for a group inside a group. */
  collapsed: string[];
  /** "흐름": what colours the calendar ("engine", or a group key). */
  colorBy?: string;
  /** "카드": one mind map of the cards instead. */
  mindmap?: boolean;
};

export type ModeViews = { views: HomeView[]; current: string };

export type HomeViews = { v: 1; modes: Record<HomeViewMode, ModeViews> };

export const HOME_VIEW_MODES: HomeViewMode[] = ["now", "projects", "flow", "docs"];

/** Bounds, so the screen preferences stay small (the gateway keeps them under 64 KB). */
export const VIEW_LIMITS = { views: 12, name: 40, filter: 300, key: 120, fields: 24, colors: 80, collapsed: 120 } as const;

export const plainLook = (patch: Partial<GroupLook> = {}): GroupLook => ({ colors: {}, border: false, tint: 0, heading: false, ...patch });

/** A view with nothing set but its layout. */
export const plainView = (id: string, name: string, layout: ViewLayout, patch: Partial<HomeView> = {}): HomeView => ({
  id,
  name,
  layout,
  filter: "",
  sort: null,
  group: null,
  subgroup: null,
  fields: null,
  look: plainLook(),
  collapsed: [],
  ...patch,
});

/**
 * The views each mode starts with (all can be renamed, changed and deleted, and brought back).
 * Today's screens are the first ones; 프로젝트 adds "마감 × 중요도" and "폴더별".
 */
export function defaultViews(mode: HomeViewMode): HomeView[] {
  switch (mode) {
    case "now":
      return [plainView("d-now", "상태", "list", { group: { key: "status" } })];
    case "projects":
      return [
        plainView("d-cards", "카드", "cards", { group: { key: "folder", hideEmpty: true } }),
        plainView("d-table", "표", "table", { sort: { key: "activity", dir: "desc" } }),
        plainView("d-stage", "단계", "board", { group: { key: "stage" }, look: plainLook({ border: true }) }),
        plainView("d-graph", "그래프", "graph"),
        // Periods without a deadline in them are left out: a date is not set by dragging anyway.
        plainView("d-due", "마감 × 중요도", "board", {
          group: { key: "prop:마감일", dates: "period", hideEmpty: true },
          subgroup: { key: "prop:중요도" },
          look: plainLook({
            border: true,
            heading: true,
            colors: { "prop:마감일=overdue": "#e5484d", "prop:마감일=today": "#f76b15", "prop:마감일=tomorrow": "#e2a400", "prop:중요도=높음": "#e5484d", "prop:중요도=보통": "#e2a400", "prop:중요도=낮음": "#8b8d98" },
          }),
        }),
        plainView("d-folders", "폴더별", "table", { group: { key: "folder" }, sort: { key: "activity", dir: "desc" }, fields: ["stage", "prop:중요도", "prop:마감일", "tags", "sessions", "activity"] }),
      ];
    case "flow":
      return [plainView("d-flow", "달력", "calendar", { colorBy: "engine" })];
    case "docs":
      return [plainView("d-docs", "전체", "cards", { sort: { key: "modified", dir: "desc" } })];
  }
}

/** A view back to how it started: a default one as shipped, one the person made as a plain view of its layout. */
export function resetView(mode: HomeViewMode, view: HomeView): HomeView {
  const shipped = defaultViews(mode).find((entry) => entry.id === view.id);
  return shipped ?? plainView(view.id, view.name, view.layout, mode === "flow" ? { colorBy: "engine" } : {});
}

export const isHexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

const text = (value: unknown, limit: number) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

function rule(value: unknown): GroupRule | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const key = text(raw.key, VIEW_LIMITS.key);
  if (!key) return null;
  const out: GroupRule = { key };
  if (raw.dates === "period" || raw.dates === "month" || raw.dates === "week") out.dates = raw.dates;
  if (raw.reverse === true) out.reverse = true;
  if (raw.hideEmpty === true) out.hideEmpty = true;
  return out;
}

function look(value: unknown): GroupLook {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const colors: Record<string, string> = {};
  if (raw.colors && typeof raw.colors === "object" && !Array.isArray(raw.colors)) {
    for (const [key, color] of Object.entries(raw.colors as Record<string, unknown>).slice(0, VIEW_LIMITS.colors)) {
      if (key.length <= VIEW_LIMITS.key * 2 && isHexColor(color)) colors[key] = color.toLowerCase();
    }
  }
  const tint = typeof raw.tint === "number" && Number.isFinite(raw.tint) ? Math.round(Math.min(30, Math.max(0, raw.tint))) : 0;
  return { colors, border: raw.border === true, tint, heading: raw.heading === true };
}

/** One saved view as it can be trusted, or null when it is not one. */
export function cleanView(mode: HomeViewMode, value: unknown): HomeView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 40);
  if (!id) return null;
  const layouts = VIEW_LAYOUTS[mode];
  const layout = layouts.includes(raw.layout as ViewLayout) ? (raw.layout as ViewLayout) : layouts[0]!;
  const group = rule(raw.group);
  const sort = raw.sort && typeof raw.sort === "object" ? (raw.sort as Record<string, unknown>) : null;
  const sortKey = sort ? text(sort.key, VIEW_LIMITS.key) : "";
  const view: HomeView = {
    id,
    name: text(raw.name, VIEW_LIMITS.name) || LAYOUT_LABEL[layout],
    layout,
    filter: typeof raw.filter === "string" ? raw.filter.slice(0, VIEW_LIMITS.filter) : "",
    sort: sortKey ? { key: sortKey, dir: sort!.dir === "asc" ? "asc" : "desc" } : null,
    group,
    // A subgroup only means something inside a group.
    subgroup: group ? rule(raw.subgroup) : null,
    fields: Array.isArray(raw.fields) ? [...new Set(raw.fields.map((field) => text(field, VIEW_LIMITS.key)).filter(Boolean))].slice(0, VIEW_LIMITS.fields) : null,
    look: look(raw.look),
    collapsed: Array.isArray(raw.collapsed) ? [...new Set(raw.collapsed.filter((entry): entry is string => typeof entry === "string" && entry.length <= VIEW_LIMITS.key * 4))].slice(-VIEW_LIMITS.collapsed) : [],
  };
  if (mode === "flow") view.colorBy = text(raw.colorBy, VIEW_LIMITS.key) || "engine";
  if (layout === "cards" && raw.mindmap === true) view.mindmap = true;
  return view;
}

/** What the screen preferences held before views: the projects' layout and the cards' mind map (this device). */
export type LegacyHomePrefs = { projectsLayout?: string | null; homeMap?: string | null };

const LEGACY_LAYOUT: Record<string, string> = { cards: "d-cards", table: "d-table", kanban: "d-stage", graph: "d-graph" };

/**
 * The saved views as they can be trusted. Without any yet (or with a broken value), every mode
 * starts with its default views, and what the screen kept before — the projects' layout and the
 * cards' mind map — becomes the current view, once (the result is saved with the next change).
 */
export function readHomeViews(raw: unknown, legacy: LegacyHomePrefs = {}): HomeViews {
  const saved = raw && typeof raw === "object" && (raw as { v?: unknown }).v === 1 ? ((raw as { modes?: unknown }).modes as Record<string, unknown> | undefined) : undefined;
  const modes = {} as Record<HomeViewMode, ModeViews>;
  for (const mode of HOME_VIEW_MODES) {
    const entry = saved?.[mode] && typeof saved[mode] === "object" ? (saved[mode] as Record<string, unknown>) : null;
    const views: HomeView[] = [];
    if (entry && Array.isArray(entry.views)) {
      for (const value of entry.views) {
        const view = cleanView(mode, value);
        if (view && !views.some((other) => other.id === view.id)) views.push(view);
        if (views.length >= VIEW_LIMITS.views) break;
      }
    }
    if (!views.length) {
      const fresh = defaultViews(mode);
      let current = fresh[0]!.id;
      if (!saved && mode === "projects") {
        const wanted = LEGACY_LAYOUT[legacy.projectsLayout ?? ""];
        if (wanted) current = wanted;
        if (legacy.homeMap === "mindmap") fresh.find((view) => view.id === "d-cards")!.mindmap = true;
      }
      modes[mode] = { views: fresh, current };
      continue;
    }
    const current = typeof entry?.current === "string" && views.some((view) => view.id === entry.current) ? entry.current : views[0]!.id;
    modes[mode] = { views, current };
  }
  return { v: 1, modes };
}

/** The view a mode shows now. */
export const currentView = (views: HomeViews, mode: HomeViewMode): HomeView => {
  const entry = views.modes[mode];
  return entry.views.find((view) => view.id === entry.current) ?? entry.views[0]!;
};

/** The colour key of a group in `look.colors` and the entries of `collapsed`. */
export const groupKey = (key: string, id: string) => `${key}=${id}`;
