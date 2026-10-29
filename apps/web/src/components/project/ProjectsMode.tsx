import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { GroupRule, HomeView, ModeViews, Provider, Session, Work } from "@workbench/contracts";
import { baseMatcher } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { useAppearance } from "../../appearance.ts";
import { boardOf, colorOf, foldKey, groupItems, localDay, moveOf, nestGroups, sortItems, type Group, type KeyDef, type NestedGroup } from "../../groups.ts";
import { mindmapSource } from "../../overview.ts";
import { projectMatcher } from "../../project-query.ts";
import type { State } from "../../state.ts";
import { Diagram } from "../Diagram.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import { DEFAULT_PROJECT_FIELDS, projectFields, projectKeys, projectQuery, projectRows, projectSorts, propertyKey, propertyKeys, type ProjectRow } from "../views/keys.ts";
import { GroupBoard, GroupSections, type Cell } from "../views/layouts.tsx";
import { GroupHead, More, groupStyle, lookProps, toggleFold, usePaint } from "../views/parts.tsx";
import { BoardCardBody, ListRow, TableHead, TableRow, WorkCard, tableColumns, useWorkContents, type OpenThings } from "../views/ProjectBits.tsx";
import { useProjectData } from "../views/useProjectData.ts";
import { ViewHead, ViewTabs, ViewTools, type ShownGroups } from "../views/ViewHead.tsx";
import { ProjectsGraph } from "./ProjectsGraph.tsx";
import "../../styles/projects-mode.css";
import "../../styles/groups.css";

// Home "프로젝트": every project by what people wrote in its note, in views the person names and
// shapes (프로젝트-내비게이터-그룹보기-설계 §3) — cards, a table, boards and lists grouped by any key
// (stage, folder, tags, a property, a period), with groups inside groups, and the graph. On a
// board, moving a card writes the grouped value: the stage (undoable, as the kanban did), the
// folder (the work moves), or a one-value property; dates, tags, the engine say why they cannot.

/** Cards per group before "더 보기" (카드), lines per group (목록). */
const CARD_CAP = 12;
const LINE_CAP = 40;

const manual = (a: ProjectRow, b: ProjectRow) => a.work.sort - b.work.sort || b.work.createdAt - a.work.createdAt;

export function ProjectsMode({
  api,
  state,
  views,
  onViews,
  openProject,
  open,
}: {
  api: Api;
  state: State;
  views: ModeViews;
  onViews: (next: ModeViews) => void;
  openProject: (work: Work) => void;
  open: { session: (session: Session) => void; doc: (artifactId: string) => void };
}) {
  const pkm = useOptionalPkm();
  const { lookOf } = useAppearance();
  const data = useProjectData(api, state);
  const { summaries, stages, template } = data;
  const view = views.views.find((entry) => entry.id === views.current) ?? views.views[0]!;
  const setView = useCallback((next: HomeView) => onViews({ ...views, views: views.views.map((entry) => (entry.id === next.id ? next : entry)) }), [views, onViews]);
  const { paint, panel } = usePaint(view, setView);
  const contents = useWorkContents(state);
  const things: OpenThings = useMemo(() => ({ session: open.session, doc: open.doc, project: openProject }), [open, openProject]);

  const claude = lookOf("claude").palette.accent;
  const codex = lookOf("codex").palette.accent;
  const engineColor = useCallback((provider: Provider) => (provider === "claude" ? claude : codex), [claude, codex]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const keys = useMemo(() => projectKeys({ state, summaries, stages, template, engineColor }), [state.folders, summaries, stages, template, engineColor]);
  const sorts = useMemo(() => projectSorts({ stages, summaries, template }), [stages, summaries, template]);
  const kinds = useMemo(() => new Map(propertyKeys(summaries.values(), template).map((entry) => [entry.key, entry.type] as const)), [summaries, template]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => projectRows(state, summaries), [state.works, state.sessions, state.proposals, state.artifacts, state.folders, summaries]);

  /** A rule's key; a property no project has yet (a view made elsewhere) reads as text, or a date when grouped by period. */
  const keyOf = (rule: GroupRule | null): KeyDef<ProjectRow> | null =>
    rule ? (keys.find((entry) => entry.key === rule.key) ?? (rule.key.startsWith("prop:") ? propertyKey(rule.key.slice(5), rule.dates ? "date" : "text") : null)) : null;
  // A board is read by its columns: without a group it shows the stages.
  const groupRule: GroupRule | null = view.group ?? (view.layout === "board" ? { key: "stage" } : null);
  const groupDef = keyOf(groupRule);
  const subDef = groupDef ? keyOf(view.subgroup) : null;
  const byStage = groupDef?.key === "stage" || subDef?.key === "stage";

  const matcher = useMemo(() => projectMatcher(view.filter), [view.filter]);
  const base = useMemo(() => {
    if (view.baseFilters === undefined) return null;
    try { return { test: baseMatcher(view.baseFilters), error: null }; }
    catch (error) { return { test: () => false, error: error instanceof Error ? error.message : String(error) }; }
  }, [view.baseFilters]);
  // Archived projects: in the archive stage's group of a board by stage, and in the graph (its own filter).
  const visible = rows.filter((row) => (view.layout === "graph" || (view.layout === "board" && byStage) || !row.archived) && matcher(projectQuery(row, state.folders)) && (!base || (row.summary?.base && base.test(row.summary.base))));
  const sortRule = view.sort ?? (view.layout === "cards" ? null : ({ key: "activity", dir: "desc" } as const));
  const sortDef = sortRule ? (sorts.find((entry) => entry.key === sortRule.key) ?? null) : null;
  const ordered = sortDef ? sortItems(visible, sortDef, sortRule!.dir, (row) => row.work.title) : [...visible].sort(manual);
  const today = localDay(Date.now());
  const fields = view.layout === "graph" ? [] : (view.fields ?? DEFAULT_PROJECT_FIELDS[view.layout as keyof typeof DEFAULT_PROJECT_FIELDS] ?? []);

  // ── writes: a stage, a folder, a property; each with a way back ───────────────────────────
  const notice = useCallback((text: string, undo?: () => Promise<unknown>) => pkm?.onToast(undo ? { text, action: { label: "되돌리기", run: () => void undo().then(data.reload).catch((error: Error) => pkm?.onToast(error.message)) } } : text), [pkm, data.reload]);
  const moveStage = useCallback(
    (work: Work, stage: string | null) =>
      api.setProjectStage(work.id, stage).then((write) => {
        data.reload();
        if (write.token) notice(`${work.title}: ${write.summary}`, () => api.undoProject(work.id, write.token));
      }),
    [api, data, notice],
  );
  const moveFolder = useCallback(
    (work: Work, folderId: string | null) => {
      const before = work.folderId;
      const name = (id: string | null) => (id && state.folders[id] ? state.folders[id]!.name : "폴더 밖");
      return api.updateWork(work.id, { folderId }).then(() => notice(`${work.title}: ${name(before)} → ${name(folderId)}`, () => api.updateWork(work.id, { folderId: before })));
    },
    [api, notice, state.folders],
  );
  const writeProperty = useCallback(
    (work: Work, key: string, value: string | null) =>
      api.setProjectProperty(work.id, key, value === null ? null : [value], kinds.get(key)).then((write) => {
        data.reload();
        if (write.token) notice(`${work.title}: ${write.summary}`, () => api.undoProject(work.id, write.token));
      }),
    [api, data, kinds, notice],
  );
  const write = (work: Work, def: KeyDef<ProjectRow>, value: string | null) =>
    def.key === "stage" ? moveStage(work, value) : def.key === "folder" ? moveFolder(work, value) : def.key.startsWith("prop:") ? writeProperty(work, def.key.slice(5), value) : Promise.resolve();

  /** What a move would write, or why it cannot be made. */
  const plan = (row: ProjectRow, from: Cell, to: Cell): { writes: [KeyDef<ProjectRow>, string | null][] } | { reason: string } => {
    const writes: [KeyDef<ProjectRow>, string | null][] = [];
    if (groupDef && to.col !== from.col) {
      const move = moveOf(groupDef, row, to.col);
      if (!move.ok) return { reason: move.reason };
      writes.push([groupDef, move.value]);
    }
    if (subDef && to.lane !== from.lane) {
      const move = moveOf(subDef, row, to.lane ?? "");
      if (!move.ok) return { reason: move.reason };
      writes.push([subDef, move.value]);
    }
    return { writes };
  };
  const onMove = (row: ProjectRow, from: Cell, to: Cell) => {
    const steps = plan(row, from, to);
    if ("reason" in steps) return void pkm?.onToast(steps.reason);
    void steps.writes.reduce<Promise<unknown>>((chain, [def, value]) => chain.then(() => write(row.work, def, value)), Promise.resolve()).catch((error: Error) => pkm?.onToast(error.message));
  };

  const stageMenu = (work: Work, x: number, y: number) => {
    const current = summaries.get(work.id)?.stage ?? null;
    pkm?.openMenu({
      x,
      y,
      title: `${work.title} · 단계`,
      items: [
        ...stages.map((stage) => ({ kind: "item" as const, label: stage.name, checked: stage.name === current, onSelect: () => void moveStage(work, stage.name).catch((error: Error) => pkm?.onToast(error.message)) })),
        { kind: "separator" as const },
        { kind: "item" as const, label: "값 없음", checked: !current, onSelect: () => void moveStage(work, null).catch((error: Error) => pkm?.onToast(error.message)) },
      ],
    });
  };

  // ── groups ─────────────────────────────────────────────────────────────────────────────
  const board = view.layout === "board" && groupDef ? boardOf(ordered, groupDef, groupRule, subDef, view.subgroup, today) : null;
  const nested: NestedGroup<ProjectRow>[] =
    view.layout === "board" || view.layout === "graph"
      ? []
      : groupDef
        ? nestGroups(groupItems(ordered, groupDef, groupRule, today), subDef, view.subgroup, today)
        : [{ id: "", label: "", color: null, items: ordered, depth: 0, sub: null }];
  const shown: ShownGroups[] = [];
  const listOf = (groups: Group<ProjectRow>[]) => groups.map((group) => ({ id: group.id, label: group.label, color: group.color }));
  if (board && groupDef) {
    shown.push({ key: groupDef.key, label: groupDef.label, list: listOf(board.columns) });
    if (board.lanes && subDef) shown.push({ key: subDef.key, label: subDef.label, list: listOf(board.lanes) });
  } else if (groupDef && view.layout !== "graph") {
    shown.push({ key: groupDef.key, label: groupDef.label, list: listOf(nested) });
    if (subDef) {
      const seen = new Map<string, Group<ProjectRow>>();
      for (const group of nested) for (const sub of group.sub ?? []) if (!seen.has(sub.id)) seen.set(sub.id, sub);
      shown.push({ key: subDef.key, label: subDef.label, list: listOf([...seen.values()]) });
    }
  } else if (groupDef && view.layout === "graph") {
    shown.push({ key: groupDef.key, label: groupDef.label, list: listOf(groupItems(ordered, groupDef, groupRule, today)) });
  }

  // Sessions and documents as chips are the cards' own.
  const layoutFields = projectFields({ summaries, template }).filter((field) => field.id !== "chips" || view.layout === "cards");
  const head = (
    <ViewHead
      tabs={<ViewTabs mode="projects" views={views} onViews={onViews} className="projects-layouts" />}
      tools={
        <ViewTools
          mode="projects"
          view={view}
          onView={setView}
          groupKeys={keys.map((entry) => ({ key: entry.key, label: entry.label, dated: entry.kind === "date" || entry.kind === "past" }))}
          sortKeys={sorts.map((entry) => ({ key: entry.key, label: entry.label, dated: entry.key === "activity" || entry.key === "created" }))}
          fields={layoutFields}
          defaultFields={DEFAULT_PROJECT_FIELDS[view.layout as keyof typeof DEFAULT_PROJECT_FIELDS]}
          groups={shown}
        />
      }
    />
  );

  const empty = base?.error ? <div role="alert" className="projects-empty">Bases 필터를 적용하지 못했습니다: {base.error}</div> : !visible.length ? <div className="projects-empty">{rows.length ? "맞는 프로젝트가 없습니다." : "프로젝트가 없습니다."}</div> : null;
  let body;
  if (view.layout === "graph") {
    const colorFor = groupDef && view.group ? new Map(ordered.map((row) => [row.work.id, groupColorOf(view, groupDef, row, today)] as const)) : null;
    body = (
      <ProjectsGraph
        items={ordered.map((row) => ({ work: row.work, stage: row.summary?.stage ?? null, tags: row.summary?.tags ?? row.work.tags ?? [], related: row.summary?.related ?? [], sessions: row.sessions.length, archived: row.archived }))}
        stages={stages}
        openProject={openProject}
        loading={!data.loaded}
        groupColor={colorFor ? (workId) => colorFor.get(workId) ?? null : undefined}
      />
    );
  } else if (board && groupDef) {
    body = (
      <>
        <GroupBoard
          view={view}
          onView={setView}
          paint={paint}
          board={board}
          colKey={groupDef.key}
          laneKey={subDef?.key ?? null}
          stageColumns={groupDef.key === "stage"}
          itemId={(row) => row.work.id}
          itemAttr="work"
          itemTitle={(row) => row.work.title}
          card={(row) => <BoardCardBody row={row} fields={fields} stages={stages} showStage={groupDef.key !== "stage" && subDef?.key !== "stage"} folders={state.folders} />}
          onOpen={(row) => openProject(row.work)}
          canMove={(row, from, to) => {
            const steps = plan(row, from, to);
            return "reason" in steps ? steps.reason : null;
          }}
          onMove={onMove}
          cardHint={`누르면 프로젝트 페이지 · 끌거나 Alt+←/→${subDef ? "·↑/↓" : ""}로 ${groupDef.label}${subDef ? `·${subDef.label}` : ""} 바꾸기`}
        />
        {!rows.length ? empty : null}
      </>
    );
  } else if (view.layout === "table") {
    body = <GroupedTable view={view} setView={setView} paint={paint} groups={nested} grouped={Boolean(groupDef)} ruleKey={groupDef?.key ?? ""} subKey={subDef?.key} columns={tableColumns(fields, stages, state, stageMenu, kinds)} openProject={openProject} empty={empty} />;
  } else if (view.layout === "list") {
    body = (
      <>
        <GroupSections
          view={view}
          onView={setView}
          paint={paint}
          ruleKey={groupDef?.key ?? ""}
          subKey={subDef?.key}
          groups={nested}
          heading={Boolean(groupDef)}
          sectionClass="list-section"
          body={(items, _group, path) => <CappedLines key={path} items={items} cap={LINE_CAP} line={(row) => <ListRow key={row.work.id} row={row} fields={fields} stages={stages} openProject={openProject} />} />}
        />
        {empty}
      </>
    );
  } else {
    // 카드: folders › cards by default (today's cards), or one mind map of the groups.
    const sections = nested.map((group) => ({ folderId: group.id || null, path: groupDef ? [group.label] : [], works: group.items.map((row) => row.work) }));
    body = (
      <div className="map">
        <div className="mode-head">
          <div className="segmented small" role="radiogroup" aria-label="카드 보기">
            {(["cards", "mindmap"] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={Boolean(view.mindmap) === (value === "mindmap")} className={Boolean(view.mindmap) === (value === "mindmap") ? "active" : ""} onClick={() => setView({ ...view, mindmap: value === "mindmap" || undefined })}>
                {value === "cards" ? "카드" : "마인드맵"}
              </button>
            ))}
          </div>
          <span className="muted">
            {groupDef ? `${groupDef.label} ${nested.filter((group) => group.items.length).length} · ` : ""}프로젝트 {visible.length}
          </span>
        </div>
        {view.mindmap ? (
          <div className="map-mind">
            <Diagram source={mindmapSource(state, sections)} />
          </div>
        ) : (
          <GroupSections
            view={view}
            onView={setView}
            paint={paint}
            ruleKey={groupDef?.key ?? ""}
            subKey={subDef?.key}
            groups={nested}
            heading={Boolean(groupDef)}
            sectionClass="map-section"
            body={(items, _group, path) => (
              <CappedCards
                key={path}
                items={items}
                card={(row) => (
                  <WorkCard
                    key={row.work.id}
                    state={state}
                    work={row.work}
                    sessions={contents.sessions(row.work.id)}
                    docs={contents.docs(row.work.id)}
                    pending={contents.pending}
                    stage={row.summary?.stage ?? null}
                    stages={stages}
                    fields={fields}
                    row={row}
                    open={things}
                  />
                )}
              />
            )}
          />
        )}
        {empty}
      </div>
    );
  }

  return (
    <div className={`projects-mode layout-${view.layout}`}>
      {head}
      {body}
      {panel}
    </div>
  );
}

/** A project's colour under a view's group (its first group), for the graph's points. */
function groupColorOf(view: HomeView, def: KeyDef<ProjectRow>, row: ProjectRow, today: ReturnType<typeof localDay>): string | null {
  const group = groupItems([row], def, { ...(view.group ?? { key: def.key }), hideEmpty: true }, today)[0];
  return group ? colorOf(view.look, def.key, group) : null;
}

function CappedCards({ items, card }: { items: ProjectRow[]; card: (row: ProjectRow) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, CARD_CAP);
  return (
    <>
      <div className="map-grid">{shown.map(card)}</div>
      <More hidden={items.length - shown.length} onMore={() => setAll(true)} />
    </>
  );
}

function CappedLines({ items, cap, line }: { items: ProjectRow[]; cap: number; line: (row: ProjectRow) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, cap);
  return (
    <>
      <div className="project-lines">{shown.map(line)}</div>
      <More hidden={items.length - shown.length} onMore={() => setAll(true)} />
    </>
  );
}

/** The table, with a heading row per group (and per group inside it) that folds its rows. */
function GroupedTable({
  view,
  setView,
  paint,
  groups,
  grouped,
  ruleKey,
  subKey,
  columns,
  openProject,
  empty,
}: {
  view: HomeView;
  setView: (view: HomeView) => void;
  paint: ReturnType<typeof usePaint>["paint"];
  groups: NestedGroup<ProjectRow>[];
  grouped: boolean;
  ruleKey: string;
  subKey?: string;
  columns: ReturnType<typeof tableColumns>;
  openProject: (work: Work) => void;
  empty: ReactNode;
}) {
  const look = lookProps(view.look);
  const span = columns.length + 1;
  const head = <TableHead columns={columns} sort={view.sort} onSort={(sort) => setView({ ...view, sort })} />;
  const rows = (items: ProjectRow[]) => items.map((row) => <TableRow key={row.work.id} row={row} columns={columns} openProject={openProject} />);
  return (
    <div className={`projects-table-wrap ${grouped ? look.className : ""}`} style={grouped ? look.style : undefined}>
      <table className="projects-table">
        {head}
        {grouped ? (
          groups.map((group) => {
            const color = colorOf(view.look, ruleKey, group);
            const fold = foldKey(ruleKey, group.id);
            const folded = view.collapsed.includes(fold);
            return (
              <tbody key={group.id || "none"} className={`group-body${color ? " has-color" : ""}`} style={groupStyle(color)} data-group={group.id}>
                <tr className="group-row">
                  <td colSpan={span}>
                    <GroupHead as="div" label={group.label} count={group.items.length} color={color} folded={folded} onToggle={() => setView(toggleFold(view, fold))} onPaint={(x, y) => paint(ruleKey, group, x, y)} />
                  </td>
                </tr>
                {folded
                  ? null
                  : group.sub && subKey
                    ? group.sub.map((sub) => {
                        const subColor = colorOf(view.look, subKey, sub);
                        const subFold = foldKey(subKey, sub.id, fold);
                        const subFolded = view.collapsed.includes(subFold);
                        return [
                          <tr key={`h:${sub.id}`} className={`group-row sub${subColor ? " has-color" : ""}`} style={groupStyle(subColor)}>
                            <td colSpan={span}>
                              <GroupHead as="div" label={sub.label} count={sub.items.length} color={subColor} folded={subFolded} onToggle={() => setView(toggleFold(view, subFold))} onPaint={(x, y) => paint(subKey, sub, x, y)} />
                            </td>
                          </tr>,
                          ...(subFolded ? [] : rows(sub.items)),
                        ];
                      })
                    : rows(group.items)}
              </tbody>
            );
          })
        ) : (
          <tbody>{rows(groups[0]?.items ?? [])}</tbody>
        )}
      </table>
      {empty}
    </div>
  );
}
