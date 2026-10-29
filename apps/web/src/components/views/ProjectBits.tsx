import { useMemo, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { BASE_FILE_LABELS, isUnseen, type Artifact, type ProjectStage, type PropertyType, type Session, type SortRule, type Work } from "@workbench/contracts";
import { accentStyle, useAppearance } from "../../appearance.ts";
import { ago, statusText, statusTone } from "../../format.ts";
import { isWorking, recency } from "../../overview.ts";
import { linkLabel, stageOf } from "../../project.ts";
import { folderPath } from "../../project-query.ts";
import type { State } from "../../state.ts";
import { workDocs } from "../../tree.ts";
import { FormatBadge } from "../DocCards.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import { ProjectThumbnail } from "../project/ProjectThumbnail.tsx";
import type { ProjectRow } from "./keys.ts";
import { fileValues, propLabel } from "./keys.ts";

// How a project reads in each layout of home "프로젝트": a card with its sessions and documents
// (카드), a card on a board, a row of a table and a line of a list. Which details show is the view's
// "속성" choice; a property shows as written (a date with its weekday, a link without brackets).

export type OpenThings = { session: (session: Session) => void; doc: (artifactId: string) => void; project: (work: Work) => void };

/** A project's stage as a small seal (button to change it, or a plain tag). */
export function StagePill({ stages, name, onClick }: { stages: ProjectStage[]; name: string | null; onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
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

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** A property value as shown: "2026-11-02 (월)", "가을 특강" for a link, "예" for a checkbox. */
export function propText(value: string, type: PropertyType | undefined): string {
  if (type === "links") return linkLabel(value);
  if (type === "checkbox") return value === "true" ? "예" : "아니오";
  if (type === "tags") return `#${value}`;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(value.trim());
  if (match && (type === "date" || type === "datetime")) {
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return `${Number(match[2])}월 ${Number(match[3])}일 (${WEEKDAYS[day.getDay()]})${match[4] ? ` ${match[4]}` : ""}`;
  }
  return value;
}

const property = (row: ProjectRow, key: string) => row.summary?.properties.find((entry) => entry.key === key);

/** The property fields chosen (`prop:<key>`), as small "이름 값" chips. */
function PropChips({ row, fields }: { row: ProjectRow; fields: string[] }) {
  const chips = fields
    .filter((field) => field.startsWith("prop:") || Object.hasOwn(BASE_FILE_LABELS, field))
    .flatMap((field) => {
      if (field.startsWith("file.")) { const values = fileValues(row, field); return values.length ? [{ field, label: BASE_FILE_LABELS[field]!, text: values.join(", ") }] : []; }
      const entry = property(row, field.slice(5));
      const values = (entry?.values ?? []).filter((value) => value.trim());
      return values.length ? [{ field, label: propLabel(field.slice(5)), text: values.map((value) => propText(value, entry?.type)).join(", ") }] : [];
    });
  if (!chips.length) return null;
  return (
    <span className="view-props">
      {chips.map((chip) => (
        <span key={chip.field} className="view-prop" title={`${chip.label}: ${chip.text}`}>
          <span className="view-prop-key">{chip.label}</span> {chip.text}
        </span>
      ))}
    </span>
  );
}

const tagsOf = (row: ProjectRow) => (row.summary?.tags.length ? row.summary.tags : (row.work.tags ?? []));

/** Per work: its live sessions in the tree's order and its documents, counted once for a whole layout. */
export function useWorkContents(state: State) {
  return useMemo(() => {
    const sessions = new Map<string, Session[]>();
    for (const session of Object.values(state.sessions)) {
      if (session.archivedAt) continue;
      const list = sessions.get(session.workId);
      if (list) list.push(session);
      else sessions.set(session.workId, [session]);
    }
    for (const list of sessions.values()) list.sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
    const pending = new Map<string, number>();
    for (const proposal of Object.values(state.proposals)) if (proposal.status === "pending") pending.set(proposal.artifactId, (pending.get(proposal.artifactId) ?? 0) + 1);
    return { sessions: (workId: string) => sessions.get(workId) ?? [], docs: (workId: string) => workDocs(state, workId), pending };
  }, [state]);
}

/**
 * A project as a card ("카드", and "지금"'s latest works): its name, its stage, where it is, its
 * sessions and documents as chips, and the details the view shows.
 */
export function WorkCard({
  state,
  work,
  sessions,
  docs,
  pending,
  stage,
  stages,
  fields,
  row,
  open,
}: {
  state: State;
  work: Work;
  sessions: Session[];
  docs: Artifact[];
  pending: Map<string, number>;
  /** The note's stage (undefined: not shown). */
  stage?: string | null;
  stages: ProjectStage[];
  fields: string[];
  row?: ProjectRow;
  open: OpenThings;
}) {
  const { lookOf } = useAppearance();
  const chips = fields.includes("chips");
  const last = Math.max(work.updatedAt, ...sessions.map(recency));
  const path = fields.includes("folder") ? folderPath(state.folders, work.folderId)?.replaceAll("/", " / ") : null;
  return (
    <div className={`work-card${chips ? " with-chips" : ""}`} data-flip={`w:${work.id}`} data-work={work.id}>
      {fields.includes("thumbnail") ? <ProjectThumbnail summary={row?.summary} /> : null}
      <button type="button" className="work-card-title" onClick={() => open.project(work)} title={work.cwd}>
        <Icon name="project" size={14} />
        <span>{work.title}</span>
      </button>
      {stage !== undefined && fields.includes("stage") ? <StagePill stages={stages} name={stage} /> : null}
      {fields.includes("folder") ? <span className="work-card-path">{path || "폴더 밖"}</span> : null}
      {row && fields.includes("preview") && row.summary?.preview ? <span className="work-card-preview">{row.summary.preview}</span> : null}
      {row && fields.includes("tags") && tagsOf(row).length ? <span className="kanban-card-tags">{tagsOf(row).map((tag) => `#${tag}`).join(" ")}</span> : null}
      {row ? <PropChips row={row} fields={fields} /> : null}
      {chips && sessions.length ? (
        <div className="work-chips">
          {sessions.slice(0, 6).map((session) => (
            <button
              key={session.id}
              type="button"
              className={`work-chip session tone-${statusTone(session)}`}
              data-flip={`s:${session.id}`}
              style={accentStyle(lookOf(session.provider))}
              onClick={() => open.session(session)}
              title={`${session.purpose} · ${statusText(session)}`}
            >
              {isWorking(session) || session.status === "awaitingApproval" ? <span className={`dot dot-${statusTone(session)}`} /> : <EngineMark provider={session.provider} size={12} />}
              <span className="work-chip-text">{session.purpose}</span>
              {isUnseen(session) ? <span className="new-dot" title="새 답" /> : null}
            </button>
          ))}
          {sessions.length > 6 ? <span className="work-chip more">+{sessions.length - 6}</span> : null}
        </div>
      ) : null}
      {chips && docs.length ? (
        <div className="work-chips">
          {docs.slice(0, 4).map((artifact) => (
            <button key={artifact.id} type="button" className="work-chip doc" data-flip={`d:${artifact.id}`} onClick={() => open.doc(artifact.id)} title={artifact.path}>
              <FormatBadge format={artifact.format} />
              <span className="work-chip-text">{artifact.name}</span>
              {pending.get(artifact.id) ? <span className="work-chip-count" title="검토할 수정안">{pending.get(artifact.id)}</span> : null}
            </button>
          ))}
          {docs.length > 4 ? <span className="work-chip more">+{docs.length - 4}</span> : null}
        </div>
      ) : null}
      {fields.includes("sessions") || fields.includes("activity") ? (
        <span className="work-card-meta">
          {[fields.includes("sessions") ? `세션 ${sessions.length}${docs.length ? ` · 문서 ${docs.length}` : ""}` : "", fields.includes("activity") ? ago(last) : ""].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

/** What a project's card on a board shows. */
export function BoardCardBody({ row, fields, stages, showStage, folders }: { row: ProjectRow; fields: string[]; stages: ProjectStage[]; showStage: boolean; folders: State["folders"] }) {
  const tags = tagsOf(row);
  const path = fields.includes("folder") ? folderPath(folders, row.work.folderId) : null;
  return (
    <>
      <span className="kanban-card-title">{row.work.title}</span>
      {fields.includes("thumbnail") ? <ProjectThumbnail summary={row.summary} /> : null}
      {showStage && fields.includes("stage") ? <StagePill stages={stages} name={row.summary?.stage ?? null} /> : null}
      {path ? <span className="kanban-card-tags">{path.replaceAll("/", " / ")}</span> : null}
      {fields.includes("preview") && row.summary?.preview ? <span className="kanban-card-preview">{row.summary.preview}</span> : null}
      {fields.includes("tags") && tags.length ? <span className="kanban-card-tags">{tags.slice(0, 3).map((tag) => `#${tag}`).join(" ")}</span> : null}
      <PropChips row={row} fields={fields} />
      <span className="kanban-card-meta">
        {fields.includes("attention") && row.attention ? <span className="kanban-badge hot">확인 필요 {row.attention}</span> : null}
        {fields.includes("proposals") && row.proposals ? <span className="kanban-badge">수정안 {row.proposals}</span> : null}
        {row.unseen ? <span className="kanban-badge">새 답 {row.unseen}</span> : null}
        {fields.includes("sessions") || fields.includes("activity") || fields.includes("created") ? (
          <span className="muted">
            {[fields.includes("sessions") ? `세션 ${row.sessions.length}` : "", fields.includes("activity") ? ago(row.last) : "", fields.includes("created") ? `만듦 ${ago(row.work.createdAt)}` : ""].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
    </>
  );
}

/** Table columns: heading, the key it sorts by (none: not sortable), number or not, and the cell. */
type Column = { id: string; label: string; sort: string | null; num?: boolean; cell: (row: ProjectRow) => ReactNode; className?: (row: ProjectRow) => string };

export function tableColumns(fields: string[], stages: ProjectStage[], state: State, stageMenu: (work: Work, x: number, y: number) => void, kinds: Map<string, PropertyType>): Column[] {
  const out: Column[] = [];
  for (const field of fields) {
    switch (field) {
      case "thumbnail":
        out.push({ id: field, label: "썸네일", sort: null, cell: (row) => <ProjectThumbnail summary={row.summary} small /> });
        break;
      case "stage":
        out.push({
          id: field,
          label: "단계",
          sort: "stage",
          cell: (row) => (
            <StagePill
              stages={stages}
              name={row.summary?.stage ?? null}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                stageMenu(row.work, box.left, box.bottom + 4);
              }}
            />
          ),
        });
        break;
      case "folder":
        out.push({ id: field, label: "폴더", sort: null, cell: (row) => <span className="muted">{folderPath(state.folders, row.work.folderId)?.replaceAll("/", " / ") ?? "폴더 밖"}</span> });
        break;
      case "tags":
        out.push({ id: field, label: "태그", sort: null, cell: (row) => tagsOf(row).map((tag) => `#${tag}`).join(" "), className: () => "projects-tags" });
        break;
      case "preview":
        out.push({ id: field, label: "미리보기", sort: null, cell: (row) => <span className="projects-preview">{row.summary?.preview ?? ""}</span> });
        break;
      case "sessions":
        out.push({ id: field, label: "세션", sort: "sessions", num: true, cell: (row) => row.sessions.length });
        break;
      case "attention":
        out.push({ id: field, label: "확인 필요", sort: "attention", num: true, cell: (row) => row.attention || "", className: (row) => (row.attention ? "hot" : "") });
        break;
      case "proposals":
        out.push({ id: field, label: "수정안", sort: "proposals", num: true, cell: (row) => row.proposals || "" });
        break;
      case "activity":
        out.push({ id: field, label: "마지막 활동", sort: "activity", cell: (row) => ago(row.last), className: () => "muted" });
        break;
      case "created":
        out.push({ id: field, label: "만든 날", sort: "created", cell: (row) => ago(row.work.createdAt), className: () => "muted" });
        break;
      default:
        if (Object.hasOwn(BASE_FILE_LABELS, field)) out.push({ id: field, label: BASE_FILE_LABELS[field]!, sort: field, cell: (row) => fileValues(row, field).join(", ") });
        if (field.startsWith("prop:")) {
          const key = field.slice(5);
          const type = kinds.get(key);
          out.push({
            id: field,
            label: propLabel(key),
            sort: field,
            num: type === "number",
            cell: (row) =>
              (property(row, key)?.values ?? [])
                .filter((value) => value.trim())
                .map((value) => propText(value, type))
                .join(", "),
          });
        }
    }
  }
  return out;
}

/** The table's head: a sortable column is a button (press again to turn the order round). */
export function TableHead({ columns, sort, onSort }: { columns: Column[]; sort: SortRule | null; onSort: (sort: SortRule) => void }) {
  const head = (id: string, label: string, key: string | null) => (
    <th key={id} aria-sort={key && sort?.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      {key ? (
        <button type="button" onClick={() => onSort({ key, dir: sort?.key === key ? (sort.dir === "asc" ? "desc" : "asc") : key === "title" || key === "stage" ? "asc" : "desc" })}>
          {label}
          {sort?.key === key ? <Icon name={sort.dir === "asc" ? "chevronUp" : "chevronDown"} size={11} /> : null}
        </button>
      ) : (
        <span className="projects-th">{label}</span>
      )}
    </th>
  );
  return (
    <thead>
      <tr>
        {head("title", "이름", "title")}
        {columns.map((column) => head(column.id, column.label, column.sort))}
      </tr>
    </thead>
  );
}

export function TableRow({ row, columns, openProject }: { row: ProjectRow; columns: Column[]; openProject: (work: Work) => void }) {
  return (
    <tr data-work={row.work.id}>
      <td>
        <button type="button" className="projects-name" onClick={() => openProject(row.work)} title={row.work.cwd}>
          {row.work.title}
        </button>
      </td>
      {columns.map((column) => (
        <td key={column.id} className={`${column.num ? "num" : ""} ${column.className?.(row) ?? ""}`.trim() || undefined}>
          {column.cell(row)}
        </td>
      ))}
    </tr>
  );
}

/** A project as one line of a list: name, stage, its first words, details, when. */
export function ListRow({ row, fields, stages, openProject }: { row: ProjectRow; fields: string[]; stages: ProjectStage[]; openProject: (work: Work) => void }) {
  const tags = tagsOf(row);
  return (
    <div className="project-line" data-work={row.work.id} data-flip={`w:${row.work.id}`}>
      {fields.includes("thumbnail") ? <ProjectThumbnail summary={row.summary} small /> : null}
      <button type="button" className="project-line-main" onClick={() => openProject(row.work)} title={row.work.cwd}>
        <span className="project-line-title">{row.work.title}</span>
        {fields.includes("preview") && row.summary?.preview ? <span className="project-line-preview">{row.summary.preview}</span> : null}
      </button>
      <span className="project-line-side">
        <PropChips row={row} fields={fields} />
        {fields.includes("tags") && tags.length ? <span className="kanban-card-tags">{tags.slice(0, 3).map((tag) => `#${tag}`).join(" ")}</span> : null}
        {fields.includes("stage") ? <StagePill stages={stages} name={row.summary?.stage ?? null} /> : null}
        {row.attention ? <span className="kanban-badge hot">확인 필요 {row.attention}</span> : null}
        {fields.includes("activity") ? <span className="project-line-date">{ago(row.last)}</span> : null}
      </span>
    </div>
  );
}
