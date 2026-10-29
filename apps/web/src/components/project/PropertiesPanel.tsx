import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PROPERTY_TYPES, type ProjectStage, type ProjectSummary, type PropertyRow, type PropertyType } from "@workbench/contracts";
import type { MenuEntry, MenuRequest } from "../ContextMenu.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import { emojiColor, hintOptions } from "../../groups.ts";
import { asLink, knownTags, linkLabel } from "../../project.ts";
import "../../styles/groups.css";

// The project's properties, as Obsidian shows a note's: one block at the top, a row per key with
// its kind's icon, the key and an editor made for that kind. The template's fields are always
// there (empty until filled), the note's other keys follow, and "+ 속성 추가" picks a name and a kind.

const KIND_ICON: Record<PropertyType, IconName> = {
  text: "text",
  list: "list",
  number: "hash",
  checkbox: "checkSquare",
  date: "calendar",
  datetime: "clock",
  tags: "tag",
  links: "link",
  stage: "stage",
};

const KIND_LABEL = Object.fromEntries(PROPERTY_TYPES.map((entry) => [entry.type, entry.label])) as Record<PropertyType, string>;

/** How a key reads on screen: the YAML keys Obsidian has in English get their Korean names. */
export const keyLabel = (key: string) => ({ tags: "태그", aliases: "별칭", "date created": "만든 날" })[key.trim().replace(/:$/, "").toLowerCase()] ?? key;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 2026-10-29 → "2026-10-29 (목)"; anything else as it is. */
function dateText(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(value);
  if (!match) return value;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return `${match[1]}-${match[2]}-${match[3]} (${WEEKDAYS[day.getDay()]})${match[4] ? ` ${match[4]}` : ""}`;
}

type Props = {
  rows: PropertyRow[];
  knownKeys: { key: string; type: PropertyType }[];
  stages: ProjectStage[];
  tagChoices: string[];
  projectNames: string[];
  /** Write a property (values null: remove the key) in its kind. */
  onWrite: (key: string, values: string[] | null, type: PropertyType) => void;
  onKind: (key: string, type: PropertyType) => void;
  onStageMenu: (x: number, y: number) => void;
  onTemplate: () => void;
  /** The vault's tags, asked for the first time tags are edited. */
  onWantTags: () => void;
  openMenu: (request: MenuRequest) => void;
};

/**
 * Values to pick for each text or list property, as Notion's select offers its options: the
 * template hint's options first ("높음 · 보통 · 낮음"), then what other projects wrote, most used
 * first. Read from the projects' summaries (no other request), again when a project changes.
 */
function useValueChoices(rows: PropertyRow[]): Map<string, string[]> {
  const pkm = useOptionalPkm();
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const version = pkm
    ? Object.entries(pkm.state.pkm)
        .filter(([key]) => key.startsWith("project:"))
        .map(([key, value]) => `${key}=${value}`)
        .join(",")
    : "";
  const api = pkm?.api;
  useEffect(() => {
    if (!api) return;
    let active = true;
    api
      .projects()
      .then((list) => active && setSummaries(list))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, version]);
  return useMemo(() => {
    const counts = new Map<string, Map<string, number>>();
    for (const summary of summaries) {
      for (const property of summary.properties) {
        if (property.type !== "text" && property.type !== "list") continue;
        let values = counts.get(property.key);
        if (!values) counts.set(property.key, (values = new Map()));
        for (const value of property.values) if (value.trim()) values.set(value.trim(), (values.get(value.trim()) ?? 0) + 1);
      }
    }
    const out = new Map<string, string[]>();
    for (const row of rows) {
      if (row.type !== "text" && row.type !== "list") continue;
      const used = [...(counts.get(row.key) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko")).map(([value]) => value);
      const choices = [...new Set([...hintOptions(row.hint), ...used])].slice(0, 24);
      if (choices.length) out.set(row.key, choices);
    }
    return out;
  }, [summaries, rows]);
}

/** Choices under an open editor: press one to write it (the field keeps the focus until then). */
function Choices({ choices, typed, onPick }: { choices: string[]; typed: string; onPick: (value: string) => void }) {
  const text = typed.trim().toLocaleLowerCase("ko");
  const shown = (text ? choices.filter((choice) => choice.toLocaleLowerCase("ko").includes(text)) : choices).slice(0, 12);
  if (!shown.length) return null;
  return (
    <div className="prop-choices" role="listbox" aria-label="다른 프로젝트가 쓴 값">
      {shown.map((choice) => {
        const color = emojiColor(choice);
        return (
          <button
            key={choice}
            type="button"
            role="option"
            aria-selected={false}
            className="prop-choice"
            style={color ? ({ "--group": color } as CSSProperties) : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(choice)}
          >
            {choice}
          </button>
        );
      })}
    </div>
  );
}

/** A one-line editor that commits on Enter or leaving it, cancels on Esc, and ignores Enter while Hangul is composed. */
function LineInput({
  initial,
  placeholder,
  list,
  choices,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  list?: string;
  /** Values to pick from below the field (other projects' values, the template's options). */
  choices?: string[];
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (commit: boolean, picked?: string) => {
    if (done) return;
    setDone(true);
    if (picked !== undefined) onCommit(picked);
    else if (commit) onCommit(value);
    else onCancel();
  };
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };
  const input = <input className="prop-input" autoFocus value={value} placeholder={placeholder} list={list} onChange={(event) => setValue(event.target.value)} onKeyDown={onKey} onBlur={() => finish(value !== initial)} />;
  if (!choices?.length) return input;
  const offered = choices.filter((choice) => choice !== initial);
  return (
    <span className="prop-pick">
      {input}
      <Choices choices={offered} typed={value === initial ? "" : value} onPick={(choice) => finish(true, choice)} />
    </span>
  );
}

/** Chips for a list kind (list, tags, links) with a field to add more. */
function Chips({ row, values, adding, setAdding, onWrite, tagChoices, projectNames, onWantTags, choices }: {
  row: PropertyRow;
  values: string[];
  adding: boolean;
  setAdding: (on: boolean) => void;
  onWrite: Props["onWrite"];
  tagChoices: string[];
  projectNames: string[];
  onWantTags: () => void;
  /** A list's values used elsewhere, to pick (Notion's multi-select). */
  choices?: string[];
}) {
  const label = (value: string) => (row.type === "tags" ? `#${value}` : row.type === "links" ? linkLabel(value) : value);
  const listId = row.type === "tags" ? "prop-tags" : row.type === "links" ? "prop-links" : undefined;
  const add = (typed: string) => {
    setAdding(false);
    if (!typed.trim()) return;
    if (row.type === "tags") {
      const added = knownTags(typed, tagChoices).filter((tag) => !values.some((have) => have.toLowerCase() === tag.toLowerCase()));
      if (added.length) onWrite(row.key, [...values, ...added], row.type);
    } else if (row.type === "links") {
      onWrite(row.key, [...values, asLink(typed)], row.type);
    } else {
      onWrite(row.key, [...values, ...typed.split(",").map((part) => part.trim()).filter(Boolean)], row.type);
    }
  };
  return (
    <div className="prop-chips">
      {values.map((value) => (
        <span key={value} className={`prop-chip kind-${row.type}`} title={value}>
          {row.type === "links" ? <Icon name="link" size={11} /> : null}
          {label(value)}
          <button type="button" className="prop-chip-x" aria-label={`${label(value)} 빼기`} onClick={() => onWrite(row.key, values.filter((entry) => entry !== value), row.type)}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <LineInput
          initial=""
          placeholder={row.type === "tags" ? "태그 (쉼표로 여럿)" : row.type === "links" ? "프로젝트·노트 이름" : "값 (쉼표로 여럿)"}
          list={listId ?? (choices?.length ? `prop-choices-${row.key}` : undefined)}
          choices={choices?.filter((choice) => !values.includes(choice))}
          onCommit={add}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          className={`prop-add-value${values.length ? "" : " empty"}`}
          onClick={() => {
            if (row.type === "tags") onWantTags();
            setAdding(true);
          }}
        >
          {values.length ? <Icon name="plus" size={12} /> : (row.hint ?? "비어 있음")}
        </button>
      )}
      {listId === "prop-tags" ? (
        <datalist id="prop-tags">
          {tagChoices.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      ) : listId === "prop-links" ? (
        <datalist id="prop-links">
          {projectNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

export function PropertiesPanel(props: Props) {
  const { rows, knownKeys, stages, onWrite, onKind, onStageMenu, onTemplate, openMenu } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [newType, setNewType] = useState<PropertyType>("text");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("workbench.propertiesCollapsed") === "1");
  const toggle = () => {
    localStorage.setItem("workbench.propertiesCollapsed", collapsed ? "0" : "1");
    setCollapsed(!collapsed);
  };
  const filled = rows.filter((row) => row.present && (row.values?.length ?? 0) > 0).length;
  const choices = useValueChoices(rows);

  const rowMenu = (row: PropertyRow, x: number, y: number) => {
    const kinds: MenuEntry[] = PROPERTY_TYPES.filter((entry) => entry.type !== "stage").map((entry) => ({
      kind: "item",
      label: entry.label,
      icon: KIND_ICON[entry.type],
      checked: entry.type === row.type,
      onSelect: () => onKind(row.key, entry.type),
    }));
    const items: MenuEntry[] = [
      ...(row.type === "stage" ? [] : [{ kind: "submenu" as const, label: "형식", icon: KIND_ICON[row.type], items: kinds }]),
      ...(row.present ? [{ kind: "separator" as const }, { kind: "item" as const, label: row.fromTemplate ? "값 지우기" : "속성 지우기", icon: "x" as IconName, danger: !row.fromTemplate, onSelect: () => onWrite(row.key, null, row.type) }] : []),
    ];
    if (items.length) openMenu({ x, y, title: keyLabel(row.key), items });
  };

  const editor = (row: PropertyRow) => {
    const values = (row.values ?? []).filter((value) => value !== "");
    const first = values[0] ?? "";
    const isEditing = editing === row.key;
    switch (row.type) {
      case "stage": {
        const stage = stages.find((entry) => entry.name === first) ?? null;
        return (
          <button
            type="button"
            className={`project-stage${stage ? "" : " empty"}`}
            style={stage ? ({ "--stage": stage.color } as CSSProperties) : undefined}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onStageMenu(box.left, box.bottom + 4);
            }}
            title="단계 바꾸기"
          >
            <span className="project-stage-dot" aria-hidden />
            {stage ? stage.name : first || "단계 없음"}
          </button>
        );
      }
      case "checkbox":
        return (
          <label className="prop-check">
            <input type="checkbox" checked={first === "true"} onChange={(event) => onWrite(row.key, [event.target.checked ? "true" : "false"], row.type)} />
            <span className="muted">{first === "true" ? "예" : row.present ? "아니오" : (row.hint ?? "")}</span>
          </label>
        );
      case "list":
      case "tags":
      case "links":
        return (
          <Chips
            row={row}
            values={values}
            adding={isEditing}
            setAdding={(on) => setEditing(on ? row.key : null)}
            onWrite={onWrite}
            tagChoices={props.tagChoices}
            projectNames={props.projectNames}
            onWantTags={props.onWantTags}
            choices={choices.get(row.key)}
          />
        );
      default: {
        if (isEditing) {
          const placeholder = row.type === "date" ? "2026-10-29, 10-29, 오늘" : row.type === "datetime" ? "2026-10-29 14:30, 지금" : row.type === "number" ? "숫자" : (row.hint ?? "");
          return (
            <LineInput
              initial={first}
              placeholder={placeholder}
              list={row.type === "text" && choices.get(row.key) ? `prop-choices-${row.key}` : undefined}
              choices={row.type === "text" ? choices.get(row.key) : undefined}
              onCommit={(value) => {
                setEditing(null);
                onWrite(row.key, value.trim() ? [value] : [], row.type);
              }}
              onCancel={() => setEditing(null)}
            />
          );
        }
        const shown = row.type === "date" || row.type === "datetime" ? dateText(first) : first;
        return (
          <span className="prop-line">
            <button type="button" className={`prop-value${first ? "" : " empty"}`} onClick={() => setEditing(row.key)}>
              {shown || (row.hint ?? "비어 있음")}
            </button>
            {!first && (row.type === "date" || row.type === "datetime") ? (
              <button type="button" className="prop-quick" onClick={() => onWrite(row.key, [row.type === "date" ? "오늘" : "지금"], row.type)}>
                {row.type === "date" ? "오늘" : "지금"}
              </button>
            ) : null}
          </span>
        );
      }
    }
  };

  const addKey = () => {
    const key = (newKey ?? "").trim();
    setNewKey(null);
    if (!key) return;
    if (rows.some((row) => row.key === key)) {
      setEditing(key);
      return;
    }
    const known = knownKeys.find((entry) => entry.key === key)?.type;
    if (known !== newType) onKind(key, newType);
    onWrite(key, [], newType);
  };

  return (
    <section className={`properties-panel${collapsed ? " collapsed" : ""}`} aria-label="속성">
      <div className="properties-head">
        <button type="button" className="properties-title" aria-expanded={!collapsed} onClick={toggle}>
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} />
          속성
          <span className="properties-count">{filled}/{rows.length}</span>
        </button>
        <button type="button" className="link small" onClick={onTemplate} title="모든 프로젝트에 미리 보일 속성(이름과 형식)을 정합니다">
          템플릿…
        </button>
      </div>
      {collapsed ? null : (
        <>
          <div className="properties-rows">
            {rows.map((row) => (
              <div key={row.key} className={`prop-row kind-${row.type}${row.present ? "" : " absent"}`} data-key={row.key}>
                <button
                  type="button"
                  className="prop-kind"
                  title={`${KIND_LABEL[row.type]}${row.type === "stage" ? "" : " · 형식 바꾸기"}`}
                  aria-label={`${keyLabel(row.key)} 형식: ${KIND_LABEL[row.type]}`}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    rowMenu(row, box.left, box.bottom + 4);
                  }}
                >
                  <Icon name={KIND_ICON[row.type]} size={14} />
                </button>
                <span className="prop-key" title={row.key}>
                  {keyLabel(row.key)}
                </span>
                <div className="prop-value-cell">{editor(row)}</div>
              </div>
            ))}
          </div>
          {/* The same choices for the keyboard: the field completes from them. */}
          {[...choices].map(([key, list]) => (
            <datalist key={key} id={`prop-choices-${key}`}>
              {list.map((choice) => (
                <option key={choice} value={choice} />
              ))}
            </datalist>
          ))}
          {newKey !== null ? (
            <div className="prop-new">
              <input
                className="prop-input"
                autoFocus
                placeholder="속성 이름"
                list="prop-known-keys"
                value={newKey}
                onChange={(event) => {
                  setNewKey(event.target.value);
                  const known = knownKeys.find((entry) => entry.key === event.target.value.trim());
                  if (known) setNewType(known.type === "stage" ? "text" : known.type);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") addKey();
                  else if (event.key === "Escape") setNewKey(null);
                }}
              />
              <datalist id="prop-known-keys">
                {knownKeys
                  .filter((entry) => !rows.some((row) => row.key === entry.key))
                  .map((entry) => (
                    <option key={entry.key} value={entry.key} />
                  ))}
              </datalist>
              <select className="sheet-select prop-new-kind" value={newType} onChange={(event) => setNewType(event.target.value as PropertyType)} aria-label="형식">
                {PROPERTY_TYPES.filter((entry) => entry.type !== "stage").map((entry) => (
                  <option key={entry.type} value={entry.type}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <button type="button" className="button small primary" onClick={addKey}>
                추가
              </button>
              <button type="button" className="button small" onClick={() => setNewKey(null)}>
                그만두기
              </button>
            </div>
          ) : (
            <button type="button" className="prop-add" onClick={() => setNewKey("")}>
              <Icon name="plus" size={13} /> 속성 추가
            </button>
          )}
        </>
      )}
    </section>
  );
}
