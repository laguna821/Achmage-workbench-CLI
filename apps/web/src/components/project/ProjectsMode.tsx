import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { isUnseen, type ProjectStage, type ProjectSummary, type Session, type Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { ago } from "../../format.ts";
import { stageOf } from "../../project.ts";
import { projectMatcher, queryProject } from "../../project-query.ts";
import type { State } from "../../state.ts";
import { workHidden } from "../../tree.ts";
import { Icon } from "../Icon.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import { ProjectsGraph } from "./ProjectsGraph.tsx";
import "../../styles/projects-mode.css";

// Home "프로젝트": every project by what people wrote in its note. Cards (folders › projects, with
// their sessions and documents), a table to sort and filter, and a kanban by stage where moving a
// card writes that one line of its note (undoable). The stage is the person's; the session states
// the engines report stay in "지금".

type Layout = "cards" | "table" | "kanban" | "graph";
type Sort = { key: "title" | "stage" | "sessions" | "attention" | "proposals" | "last"; dir: 1 | -1 };
const LAYOUT_KEY = "workbench.projectsLayout";
const NO_STAGE = "";

type Row = { work: Work; summary: ProjectSummary | undefined; sessions: Session[]; attention: number; proposals: number; last: number };

export function ProjectsMode({
  api,
  state,
  openProject,
  cards,
}: {
  api: Api;
  state: State;
  openProject: (work: Work) => void;
  cards: (summaries: Map<string, ProjectSummary>, stages: ProjectStage[]) => ReactNode;
}) {
  const pkm = useOptionalPkm();
  const [layout, setLayoutState] = useState<Layout>(() => {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved === "table" || saved === "kanban" || saved === "graph" ? saved : "cards";
  });
  const setLayout = (next: Layout) => {
    localStorage.setItem(LAYOUT_KEY, next);
    setLayoutState(next);
  };
  const [summaries, setSummaries] = useState<Map<string, ProjectSummary>>(new Map());
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "last", dir: -1 });
  const version = Object.entries(state.pkm)
    .filter(([key]) => key.startsWith("project:"))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const worksKey = Object.values(state.works)
    .map((work) => `${work.id}:${work.archivedAt ?? 0}`)
    .join(",");
  // The graph waits for the first summaries (its "관련" lines), so it is laid out once, not twice.
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    void Promise.all([api.projects(), api.projectStages()])
      .then(([list, nextStages]) => {
        setSummaries(new Map(list.map((entry) => [entry.workId, entry])));
        setStages(nextStages);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [api]);
  useEffect(load, [load, version, worksKey]);

  const rows: Row[] = useMemo(() => {
    const pending = new Map<string, number>();
    for (const proposal of Object.values(state.proposals)) {
      if (proposal.status !== "pending") continue;
      const workId = state.artifacts[proposal.artifactId]?.workId;
      if (workId) pending.set(workId, (pending.get(workId) ?? 0) + 1);
    }
    return Object.values(state.works).map((work) => {
      const sessions = Object.values(state.sessions).filter((session) => session.workId === work.id && !session.archivedAt);
      return {
        work,
        summary: summaries.get(work.id),
        sessions,
        attention: sessions.filter((session) => session.status === "awaitingApproval").length,
        proposals: pending.get(work.id) ?? 0,
        last: Math.max(work.updatedAt, ...sessions.map((session) => session.updatedAt)),
      };
    });
  }, [state.works, state.sessions, state.proposals, state.artifacts, summaries]);

  /** The filter box's query (`project-query.ts`): words, "#태그", "단계:값", "폴더:이름", any "속성:값". */
  const matcher = useMemo(() => projectMatcher(filter), [filter]);
  const matches = (row: Row) => matcher(queryProject(row.work, row.summary, state.folders));

  /** Move a project to a stage (or none), with a way back in the notice. */
  const moveTo = useCallback(
    (work: Work, stage: string | null) => {
      void api
        .setProjectStage(work.id, stage)
        .then((write) => {
          load();
          if (!write.token) return;
          pkm?.onToast({
            text: `${work.title}: ${write.summary}`,
            action: { label: "되돌리기", run: () => void api.undoProject(work.id, write.token).then(load).catch((error: Error) => pkm?.onToast(error.message)) },
          });
        })
        .catch((error: Error) => pkm?.onToast(error.message));
    },
    [api, load, pkm],
  );

  const stageMenu = (work: Work, x: number, y: number) => {
    const current = summaries.get(work.id)?.stage ?? null;
    pkm?.openMenu({
      x,
      y,
      title: `${work.title} · 단계`,
      items: [
        ...stages.map((stage) => ({ kind: "item" as const, label: stage.name, checked: stage.name === current, onSelect: () => moveTo(work, stage.name) })),
        { kind: "separator" as const },
        { kind: "item" as const, label: "값 없음", checked: !current, onSelect: () => moveTo(work, null) },
      ],
    });
  };

  return (
    <div className="projects-mode">
      <div className="projects-bar">
        <div className="segmented projects-layouts" role="radiogroup" aria-label="보기">
          {(
            [
              ["cards", "카드"],
              ["table", "표"],
              ["kanban", "칸반"],
              ["graph", "그래프"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={layout === id} className={layout === id ? "on" : ""} onClick={() => setLayout(id)}>
              {label}
            </button>
          ))}
        </div>
        {layout !== "cards" ? (
          <input className="projects-filter" value={filter} placeholder="이름 · #태그 · 단계:진행중" title="이름 · #태그 · 단계:진행중 · 폴더:이름 · 속성:값(마감일:2026-11, 중요도:높음) · 앞에 -는 빼기" aria-label="프로젝트 거르기" onChange={(event) => setFilter(event.target.value)} />
        ) : null}
      </div>
      {layout === "cards" ? (
        cards(summaries, stages)
      ) : layout === "table" ? (
        <ProjectsTable rows={rows.filter((row) => !workHidden(state, row.work) && matches(row))} stages={stages} sort={sort} onSort={setSort} openProject={openProject} stageMenu={stageMenu} />
      ) : layout === "kanban" ? (
        <ProjectsKanban rows={rows.filter(matches)} stages={stages} state={state} openProject={openProject} moveTo={moveTo} />
      ) : (
        <ProjectsGraph
          items={rows
            .filter(matches)
            // Archived projects come too (the graph's filter shows them when asked).
            .map((row) => ({ work: row.work, stage: row.summary?.stage ?? null, tags: row.summary?.tags ?? row.work.tags ?? [], related: row.summary?.related ?? [], sessions: row.sessions.length, archived: workHidden(state, row.work) }))}
          stages={stages}
          openProject={openProject}
          loading={!loaded}
        />
      )}
    </div>
  );
}

function StagePill({ stages, name, onClick }: { stages: ProjectStage[]; name: string | null; onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  const stage = stageOf(stages, name);
  const style = stage ? ({ "--stage": stage.color } as CSSProperties) : undefined;
  const body = (
    <>
      <span className="projects-stage-dot" aria-hidden />
      {stage ? stage.name : "값 없음"}
    </>
  );
  return onClick ? (
    <button type="button" className={`projects-stage${stage ? "" : " empty"}`} style={style} onClick={onClick} title="단계 바꾸기">
      {body}
    </button>
  ) : (
    <span className={`projects-stage${stage ? "" : " empty"}`} style={style}>
      {body}
    </span>
  );
}

function ProjectsTable({
  rows,
  stages,
  sort,
  onSort,
  openProject,
  stageMenu,
}: {
  rows: Row[];
  stages: ProjectStage[];
  sort: Sort;
  onSort: (sort: Sort) => void;
  openProject: (work: Work) => void;
  stageMenu: (work: Work, x: number, y: number) => void;
}) {
  const order = (row: Row) => {
    switch (sort.key) {
      case "title":
        return row.work.title;
      case "stage":
        return String(stages.findIndex((stage) => stage.name === row.summary?.stage) + 1).padStart(3, "0");
      case "sessions":
        return row.sessions.length;
      case "attention":
        return row.attention;
      case "proposals":
        return row.proposals;
      default:
        return row.last;
    }
  };
  const sorted = [...rows].sort((a, b) => {
    const x = order(a);
    const y = order(b);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko")) * sort.dir;
  });
  const head = (key: Sort["key"], label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : key === "title" || key === "stage" ? 1 : -1 })}>
        {label}
        {sort.key === key ? <Icon name={sort.dir === 1 ? "chevronUp" : "chevronDown"} size={11} /> : null}
      </button>
    </th>
  );
  return (
    <div className="projects-table-wrap">
      <table className="projects-table">
        <thead>
          <tr>
            {head("title", "이름")}
            {head("stage", "단계")}
            <th>태그</th>
            {head("sessions", "세션")}
            {head("attention", "확인 필요")}
            {head("proposals", "수정안")}
            {head("last", "마지막 활동")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.work.id}>
              <td>
                <button type="button" className="projects-name" onClick={() => openProject(row.work)} title={row.work.cwd}>
                  {row.work.title}
                </button>
              </td>
              <td>
                <StagePill
                  stages={stages}
                  name={row.summary?.stage ?? null}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    stageMenu(row.work, box.left, box.bottom + 4);
                  }}
                />
              </td>
              <td className="projects-tags">{(row.summary?.tags ?? row.work.tags ?? []).map((tag) => `#${tag}`).join(" ")}</td>
              <td className="num">{row.sessions.length}</td>
              <td className={`num${row.attention ? " hot" : ""}`}>{row.attention || ""}</td>
              <td className="num">{row.proposals || ""}</td>
              <td className="muted">{ago(row.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!sorted.length ? <div className="projects-empty">맞는 프로젝트가 없습니다.</div> : null}
    </div>
  );
}

type Drag = { workId: string; x0: number; y0: number; x: number; y: number; active: boolean; over: string | null };

function ProjectsKanban({
  rows,
  stages,
  state,
  openProject,
  moveTo,
}: {
  rows: Row[];
  stages: ProjectStage[];
  state: State;
  openProject: (work: Work) => void;
  moveTo: (work: Work, stage: string | null) => void;
}) {
  const archive = stages.find((stage) => stage.archive)?.name ?? null;
  // "값 없음" first, the stages in their order, the archive stage last.
  const columns = [NO_STAGE, ...stages.filter((stage) => !stage.archive).map((stage) => stage.name), ...(archive ? [archive] : [])];
  const columnOf = (row: Row) => (row.work.archivedAt ? (archive ?? NO_STAGE) : row.summary?.stage && columns.includes(row.summary.stage) ? row.summary.stage : NO_STAGE);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const active = current.active || Math.hypot(event.clientX - current.x0, event.clientY - current.y0) > 5;
      const target = active ? (document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-stage-column]") as HTMLElement | null) : null;
      setDrag({ ...current, x: event.clientX, y: event.clientY, active, over: target ? (target.dataset.stageColumn ?? null) : null });
    };
    const onUp = () => {
      const current = dragRef.current;
      setDrag(null);
      if (!current) return;
      const row = rows.find((entry) => entry.work.id === current.workId);
      if (!row) return;
      if (!current.active) return openProject(row.work);
      if (current.over !== null && current.over !== columnOf(row)) moveTo(row.work, current.over || null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.workId]);

  const dragged = drag?.active ? rows.find((row) => row.work.id === drag.workId) : null;
  return (
    <div className="projects-kanban">
      {columns.map((column) => {
        const stage = column ? stageOf(stages, column) : null;
        const cards = rows.filter((row) => columnOf(row) === column).sort((a, b) => b.last - a.last);
        // Every column stays put while a card is dragged (a column appearing mid-drag would move the targets).
        return (
          <section
            key={column || "none"}
            className={`kanban-column${drag?.active && drag.over === column ? " over" : ""}${cards.length ? "" : " empty"}`}
            data-stage-column={column}
            style={stage ? ({ "--stage": stage.color } as CSSProperties) : undefined}
            aria-label={column || "값 없음"}
          >
            <header className="kanban-head">
              <span className="projects-stage-dot" aria-hidden />
              <span className="kanban-title">{column || "값 없음"}</span>
              <span className="home-count">{cards.length}</span>
            </header>
            <div className="kanban-cards">
              {cards.map((row) => {
                const unseen = row.sessions.filter(isUnseen).length;
                return (
                  <div
                    key={row.work.id}
                    role="button"
                    tabIndex={0}
                    className={`kanban-card${drag?.active && drag.workId === row.work.id ? " lifted" : ""}`}
                    data-work={row.work.id}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      setDrag({ workId: row.work.id, x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, active: false, over: null });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") return openProject(row.work);
                      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                      event.preventDefault();
                      const at = columns.indexOf(columnOf(row));
                      const next = columns[at + (event.key === "ArrowLeft" ? -1 : 1)];
                      if (next !== undefined) moveTo(row.work, next || null);
                    }}
                    title="누르면 프로젝트 페이지 · 끌거나 Alt+←/→로 단계 옮기기"
                  >
                    <span className="kanban-card-title">{row.work.title}</span>
                    {(row.summary?.tags ?? []).length ? <span className="kanban-card-tags">{row.summary!.tags.slice(0, 3).map((tag) => `#${tag}`).join(" ")}</span> : null}
                    <span className="kanban-card-meta">
                      {row.attention ? <span className="kanban-badge hot">확인 필요 {row.attention}</span> : null}
                      {row.proposals ? <span className="kanban-badge">수정안 {row.proposals}</span> : null}
                      {unseen ? <span className="kanban-badge">새 답 {unseen}</span> : null}
                      <span className="muted">
                        세션 {row.sessions.length} · {ago(row.last)}
                      </span>
                    </span>
                  </div>
                );
              })}
              {!cards.length ? <div className="kanban-empty">{drag?.active ? "여기로 옮기기" : "없음"}</div> : null}
            </div>
          </section>
        );
      })}
      {dragged && drag ? (
        <div className="kanban-ghost" style={{ left: drag.x + 12, top: drag.y + 8 }} aria-hidden>
          {dragged.work.title}
        </div>
      ) : null}
      {state.works && !rows.length ? <div className="projects-empty">프로젝트가 없습니다.</div> : null}
    </div>
  );
}
