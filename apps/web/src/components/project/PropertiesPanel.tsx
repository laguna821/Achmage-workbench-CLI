import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { PROPERTY_TYPES, type ProjectStage, type ProjectSummary, type PropertyRow, type PropertyType } from "@workbench/contracts";
import type { MenuEntry, MenuRequest } from "../ContextMenu.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import { ListLayer, Menu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { SectionLabel, useSectionCollapsed } from "../ui/SectionLabel.tsx";
import { hintOptions } from "../../groups.ts";
import { asLink, knownTags, linkLabel } from "../../project.ts";
import type { Note } from "../../top-notice.ts";
import { keepField, readField, useField, useKeptFields, type FieldDraft } from "./field-drafts.ts";

// The note's properties as Obsidian shows a note's: one block under the title that folds, a row per
// key — its kind's icon, the key, the value — in the note's order: the template's fields (an empty
// one says so, quietly), then the note's other keys, then "+ 속성 추가". Every key of the front
// matter is a row; one the page does not change in place is shown with "원문에서 고치기", the
// app's own key as plain text. Each row is changed where it is shown, with the app's own fields
// and pickers. The stage and the tags
// are also chips on the line under the title: a chip and its row are one field with one picker.

export const KIND_ICON: Record<PropertyType, IconName> = {
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
const KINDS = PROPERTY_TYPES.filter((entry) => entry.type !== "stage");

/** How a key reads on screen: the YAML keys Obsidian has in English get their Korean names. */
export const keyLabel = (key: string) => ({ tags: "태그", aliases: "별칭", "date created": "만든 날" })[key.trim().replace(/:$/, "").toLowerCase()] ?? key;

/** What a row says in place of a value it does not have. */
const EMPTY = "비어 있음";

const valuesOf = (row: PropertyRow) => (row.values ?? []).map((value) => value.trim()).filter(Boolean);
export const hasValue = (row: PropertyRow) => row.present && valuesOf(row).length > 0;

/** A value as people say it: "11월 20일" (the year only when it is not this one), "예"/"아니오". */
export function shownValue(row: PropertyRow, now = new Date()): string {
  const values = valuesOf(row);
  const first = values[0] ?? "";
  if (row.type === "date" || row.type === "datetime") {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(first);
    if (!match) return first;
    const year = Number(match[1]) === now.getFullYear() ? "" : `${match[1]}년 `;
    return `${year}${Number(match[2])}월 ${Number(match[3])}일${row.type === "datetime" && match[4] ? ` ${match[4]}` : ""}`;
  }
  if (row.type === "checkbox") return first === "true" ? "예" : "아니오";
  if (row.type === "links") return values.map(linkLabel).join(", ");
  if (row.type === "tags") return values.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
  return values.join(", ");
}

/** A text longer than this is a sentence: it is edited as text, never offered as a pick-one list. */
const LONG = 24;

const MACHINE_KEY = "workbench_id";
const MACHINE_WHY = "앱이 이 노트를 알아보는 값입니다. 바꾸지 마세요.";

/** A one-line YAML scalar as its text: quotes and a trailing comment left out; null for anything else (a block, a list, a map, an anchor). */
function scalarText(raw: string): string | null {
  const text = raw.trim();
  const quoted = /^"([^"\\]*)"[ \t]*(?:#.*)?$/.exec(text) ?? /^'([^']*)'[ \t]*(?:#.*)?$/.exec(text);
  if (quoted) return quoted[1] || null;
  const plain = text.replace(/[ \t]+#.*$/, "");
  return plain && !/^[#|>[\]{}&*!%@`"',?-]/.test(plain) && !/:(?:[ \t]|$)/.test(plain) ? plain : null;
}

/**
 * The app's own key of a note (`workbench_id`, by which the gateway finds the file again when it is
 * moved or renamed): the gateway leaves it out of the rows, so it is read here to be shown with
 * the others — last, as plain text, never changed from the page. Only the front matter is read, as
 * the gateway bounded it (the note's body is the file after it), and only a value that is surely
 * the key's: one top-level line, a plain or quoted scalar. Anything else: no row.
 */
export function machineRow(note: { source?: string | null; body: string }): PropertyRow | null {
  const { source, body } = note;
  if (typeof source !== "string" || !source.endsWith(body)) return null;
  const lines = source.slice(0, source.length - body.length).replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 2 || !/^---[ \t]*$/.test(lines[0]!) || !/^(?:---|\.\.\.)[ \t]*$/.test(lines.at(-1)!)) return null;
  const found = lines.slice(1, -1).flatMap((line) => {
    const match = /^(?:workbench_id|"workbench_id"|'workbench_id')[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    return match ? [match[1] ?? ""] : [];
  });
  const value = found.length === 1 ? scalarText(found[0]!) : null;
  return value ? { key: MACHINE_KEY, type: "text", values: [value], present: true, fromTemplate: false, editable: false } : null;
}

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

/** What a write came to: the revision it left the note at, or why it was refused (`shown`: the revision the page shows since, when the note had changed). */
/** `asked`: the refusal is a question answered elsewhere (the conflict band), not said in the field. */
export type WriteOutcome = { revision: number | null } | { refused: string; shown?: number | null; asked?: boolean };

/**
 * A one-line editor in place of a value: Enter (not while Hangul is composed) or leaving it writes,
 * Esc puts the value back (a changed one behind a 되살리기 notice, `onDiscard`). A value the note
 * refuses keeps the field open with the typed text and why. Its text is what the draft store keeps
 * for `field` of `note` — both bound when the field opens, so what is typed stays with the note it
 * was typed for whatever the page shows later — with the revision the person saw while typing, which
 * is the base it is written from (also after a reload). Text typed while a write is on its way stays
 * in the field, from the revision that write made.
 */
export function LineInput({ note, field, initial, added, placeholder, label, revision, onCommit, onClose, onDiscard, onProblem }: {
  note: string;
  field: string;
  initial: string;
  /** The key had no value when this field opened ("+ 속성"): its kind, kept with what is typed. */
  added?: PropertyType;
  placeholder?: string;
  label: string;
  /** The note's revision as shown now (null: no file). */
  revision: number | null;
  onCommit: (value: string, base: number | null, note: string) => Promise<WriteOutcome>;
  /** The field is done: written, unchanged, or put away. */
  onClose: () => void;
  onDiscard?: (draft: FieldDraft) => void;
  /** Given: why a value was refused is said by the caller (a band under the rows), not under the field. */
  onProblem?: (problem: string | null) => void;
}) {
  // Text kept from before (a reload, another tab) is restored without taking the focus: several
  // restored fields must not steal it from each other (leaving a field writes it).
  const [bound] = useState(() => ({ note, field, restored: readField(note, field) !== null }));
  const kept = useField(bound.note, bound.field);
  const value = kept?.text ?? initial;
  const [problem, setProblem] = useState<string | null>(null);
  // The refusal is asked about in the band under the rows: the field says nothing (the row keeps its height).
  const [asked, setAsked] = useState(false);
  const busy = useRef(false);
  // The original value is nothing to keep — except while a write is on its way: then it is what the person typed after it.
  const setValue = (text: string) => keepField(bound.note, bound.field, text === initial && !busy.current ? null : { text, baseRevision: kept ? kept.baseRevision : revision, ...(added ? { added } : {}) });
  const done = useRef(false);
  // The value last refused: leaving the field does not send it again (Enter does).
  const refusedValue = useRef<string | null>(null);
  const finish = async (commit: boolean, leaving = false) => {
    if (done.current || busy.current) return;
    const current = readField(bound.note, bound.field);
    const text = current?.text ?? initial;
    if (leaving && refusedValue.current === text) return;
    if (!commit || text.trim() === initial.trim()) {
      done.current = true;
      keepField(bound.note, bound.field, null);
      if (!commit && current && text.trim() !== initial.trim()) onDiscard?.(current);
      return onClose();
    }
    busy.current = true;
    const outcome = await onCommit(text, current ? current.baseRevision : revision, bound.note);
    busy.current = false;
    const now = readField(bound.note, bound.field);
    if ("refused" in outcome) {
      refusedValue.current = text;
      setProblem(outcome.refused);
      setAsked(Boolean(outcome.asked));
      onProblem?.(outcome.asked ? null : outcome.refused);
      // Typed back to the value the note still has while it was refused: nothing to keep.
      if (now && now.text === initial) keepField(bound.note, bound.field, null);
      return;
    }
    // Typed on while it was being written: the field stays with it, from the revision that write made.
    if (now && now.text !== text) return keepField(bound.note, bound.field, { text: now.text, baseRevision: outcome.revision });
    done.current = true;
    keepField(bound.note, bound.field, null);
    onClose();
  };
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void finish(false);
    }
  };
  return (
    <span className="pn-field">
      <input className="pn-input" autoFocus={!bound.restored} aria-label={label} aria-invalid={problem ? true : undefined} title={problem ?? undefined} value={value} placeholder={placeholder}
        onChange={(event) => { setValue(event.target.value); setProblem(null); onProblem?.(null); }} onKeyDown={onKey} onBlur={() => void finish(true, true)} />
      {problem && !asked && !onProblem ? <span className="pn-field-problem" role="alert">{problem}</span> : null}
    </span>
  );
}

type PickOption = { value: string; label: string; icon?: IconName | ReactNode; hint?: ReactNode; checked?: boolean };

/**
 * A searchable list beside its trigger (the shared menu layer): pick one value, or — `multi` —
 * tick several, each tick written at once. What is typed and not listed can be added as it is.
 */
export function ValuePicker({ open, anchor, label, options, multi = false, placeholder, createLabel, onPick, onCreate, onClose, createKeepsOpen = false }: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  options: PickOption[];
  multi?: boolean;
  placeholder?: string;
  /** The row that adds what was typed (e.g. "「평가」 추가"); none: only listed values. */
  createLabel?: (typed: string) => string;
  onPick: (value: string) => void;
  onCreate?: (typed: string) => void;
  onClose: () => void;
  /** The create row leads to a next step in the same picker (a new property's kind). */
  createKeepsOpen?: boolean;
}) {
  const [query, setQuery] = useState("");
  // A new opening, or the next step of the same picker (a name, then its kind), starts unfiltered.
  useEffect(() => {
    setQuery("");
  }, [open, label]);
  const needle = query.trim().replace(/^\[\[|\]\]$/g, "").replace(/^#/, "").toLocaleLowerCase("ko");
  const shown = needle ? options.filter((option) => option.label.toLocaleLowerCase("ko").replace(/^#/, "").includes(needle)) : options;
  const exact = options.some((option) => option.label.toLocaleLowerCase("ko").replace(/^#/, "") === needle);
  const creating = Boolean(onCreate && createLabel && needle && !exact);
  return (
    <ListLayer
      role="listbox"
      open={open}
      anchor={anchor}
      label={label}
      onClose={onClose}
      minWidth={240}
      className="pn-picker"
      search={{ query, onQuery: setQuery, label: `${label} 찾기`, placeholder }}
      resetKey={query}
      footer={!shown.length && !creating ? <div className="ui-menu-empty" role="status">{needle || !onCreate ? "맞는 값이 없습니다." : "입력해서 추가합니다."}</div> : null}
    >
      {shown.map((option) => (
        <MenuItem key={option.value} value={option.value} textValue={option.label} icon={option.icon} hint={option.hint} checked={option.checked ?? false} keepOpen={multi} onSelect={() => onPick(option.value)}>
          {option.label}
        </MenuItem>
      ))}
      {creating ? (
        <>
          {shown.length ? <MenuSeparator /> : null}
          <MenuItem value={`create:${query}`} textValue={query} icon="plus" checked={false} keepOpen={multi || createKeepsOpen} onSelect={() => { onCreate!(query.trim()); setQuery(""); }}>
            {createLabel!(query.trim())}
          </MenuItem>
        </>
      ) : null}
    </ListLayer>
  );
}

/** One list item added, removed or renamed (a list changes one item per write). */
export type PropertyChange = { add?: string; remove?: string; rename?: [string, string] };

/** A property write as the page asks for it. */
export type PropertyWrite = {
  /** The note it is for: the one its field was opened on. */
  note: string;
  key: string;
  type: PropertyType;
  /** The value(s) to set (null: remove the key); left out with `change`. */
  values?: string[] | null;
  change?: PropertyChange;
  /** The refusal is shown where it was typed, not in the top bar. */
  inline?: boolean;
  /** The revision the person saw (left out: the one the page shows now). */
  base?: number | null;
};

/** A write refused because the note changed since the person saw it: the write, why, and the key's value at revision `shown`. */
export type PropertyConflict = { write: PropertyWrite; message: string; theirs: string; shown: number | null };

export type PropertyProps = {
  rows: PropertyRow[];
  /** The app's own key of the note (see `machineRow`), shown last; none: the note has none, or does not read. */
  machine?: PropertyRow | null;
  knownKeys: { key: string; type: PropertyType }[];
  stages: ProjectStage[];
  tagChoices: string[];
  projectNames: string[];
  /** Write a property in its kind; resolves to the revision it made, or why it was refused. */
  onWrite: (write: PropertyWrite) => Promise<WriteOutcome>;
  /** The note these properties are of (what is typed is kept per note and field). */
  workId: string;
  /** An action notice in the top bar ("되살리기"). */
  onNotice: (note: Note) => void;
  /** The note's revision as shown (null: no file); what is typed is kept with it. */
  revision: number | null;
  /** Open the whole note as source with the caret at this key ("원문에서 고치기"). */
  onSource: (key: string) => void;
  /** Open the whole note as source (the block's "원문"); left out: not offered. */
  onRaw?: () => void;
  /** The note cannot be written now (its front matter does not read): values are shown, changed in the source. */
  readOnly?: boolean;
  onKind: (key: string, type: PropertyType) => void;
  /** The stage settings (names and colours). */
  onStages: () => void;
  /** The vault's tags, asked for the first time tags are edited. */
  onWantTags: () => void;
  openMenu: (request: MenuRequest) => void;
  /** The questions about refused writes, by key, each answered by itself (`onSettle`: mine, or theirs). */
  conflicts: Record<string, PropertyConflict>;
  onSettle: (key: string, mine: boolean) => void;
};

/** How many blocks this window has drawn: each names its rows apart from the others'. */
let blocks = 0;

/** How a row is changed: not at all, in the source, with the picker of its kind, by a tick, or in a one-line field. */
type Mode = "static" | "source" | "stage" | "values" | "choice" | "check" | "line";
/** Where a picker was opened from: the chip under the title, or the row of the block. */
type Place = "chip" | "row";

const MULTI = new Set<PropertyType>(["tags", "links", "list"]);
/** The kinds whose value is typed as one line (the others have pickers of their own). */
const LINE_KINDS = new Set<PropertyType>(["text", "number", "date", "datetime"]);

/** What the person asked for in a refused write, as the conflict line says it. */
const mineOf = ({ key, type, change, values }: PropertyWrite) =>
  change ? (change.add !== undefined ? `${change.add} 더하기` : change.remove !== undefined ? `${change.remove} 빼기` : `${change.rename![0]} → ${change.rename![1]}`)
    : values == null ? "지움" : shownValue({ key, type, values, present: true, fromTemplate: false }) || "값 없음";

/** A row's value as it reads: the stage with its dot, several values as pills, text as it is, "비어 있음" for none. */
function ValueText({ row, stages }: { row: PropertyRow; stages: ProjectStage[] }) {
  const values = valuesOf(row);
  if (!values.length) return <span className="pn-prop-empty">{EMPTY}</span>;
  if (row.type === "stage") {
    const stage = stages.find((entry) => entry.name === values[0]);
    return <span className="pn-prop-stage" style={stage ? ({ "--stage": stage.color } as CSSProperties) : undefined}><span className="pn-stage-dot" aria-hidden />{values[0]}</span>;
  }
  if (MULTI.has(row.type)) {
    return (
      <span className="pn-pills">
        {values.map((value, index) => (
          <span key={`${index}:${value}`} className="pn-pill">
            {row.type === "links" ? <Icon name="link" size={12} /> : null}
            {row.type === "tags" ? `#${value.replace(/^#/, "")}` : row.type === "links" ? linkLabel(value) : value}
          </span>
        ))}
      </span>
    );
  }
  return <span className="pn-prop-text">{shownValue(row)}</span>;
}

type PickerProps = { row: PropertyRow; anchor: RefObject<HTMLElement | null>; props: PropertyProps; choices: string[]; onClose: () => void };

/** The stage: a menu of the stages from the app's settings. */
function StagePicker({ row, anchor, props, onClose }: PickerProps) {
  const name = valuesOf(row)[0] ?? null;
  const write = (next: string | null) => props.onWrite({ note: props.workId, key: row.key, values: next ? [next] : null, type: "stage" });
  return (
    <Menu open anchor={anchor} label="단계" minWidth={240} onClose={onClose}>
      {props.stages.map((entry) => (
        <MenuItem key={entry.name} value={entry.name} type="radio" checked={entry.name === name} icon={<span className="pn-stage-dot" style={{ "--stage": entry.color } as CSSProperties} aria-hidden />} hint={entry.archive ? "보관함으로" : undefined} onSelect={() => entry.name !== name && write(entry.name)}>
          {entry.name}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem value="none" type="radio" checked={!name} onSelect={() => name && write(null)}>값 없음</MenuItem>
      <MenuSeparator />
      <MenuItem value="settings" icon="palette" more onSelect={props.onStages}>단계 이름·색 바꾸기…</MenuItem>
    </Menu>
  );
}

/** Tags, links or a list: a picker ticks values on and off and adds new ones, one item per write. */
function ValuesPicker({ row, anchor, props, choices, onClose }: PickerProps) {
  const values = valuesOf(row);
  // One item per write: each tick adds or removes one, each written after the one before it.
  const change = (one: PropertyChange) => void props.onWrite({ note: props.workId, key: row.key, type: row.type, change: one });
  const same = (a: string, b: string) => (row.type === "links" ? linkLabel(a) === linkLabel(b) : row.type === "tags" ? a.replace(/^#/, "").toLowerCase() === b.replace(/^#/, "").toLowerCase() : a === b);
  const pool = row.type === "tags" ? props.tagChoices : row.type === "links" ? props.projectNames.map((name) => `[[${name}]]`) : choices;
  const options: PickOption[] = [...values, ...pool.filter((choice) => !values.some((value) => same(value, choice)))].map((value) => ({
    value,
    label: row.type === "tags" ? `#${value.replace(/^#/, "")}` : row.type === "links" ? linkLabel(value) : value,
    icon: row.type === "links" ? "link" : row.type === "tags" ? "tag" : undefined,
    checked: values.some((have) => same(have, value)),
  }));
  const toggle = (value: string) => {
    // An item already there is removed as written (its own text, e.g. "#회의").
    const have = values.find((entry) => same(entry, value));
    change(have !== undefined ? { remove: have } : { add: value });
  };
  const create = (typed: string) => {
    if (row.type === "tags") {
      for (const tag of knownTags(typed, props.tagChoices).filter((tag) => !values.some((have) => same(have, tag)))) change({ add: tag });
    } else if (row.type === "links") change({ add: asLink(typed) });
    else for (const part of typed.split(",").map((entry) => entry.trim()).filter(Boolean)) change({ add: part });
  };
  return (
    <ValuePicker
      open
      anchor={anchor}
      label={keyLabel(row.key)}
      options={options}
      multi
      placeholder={row.type === "tags" ? "태그 찾기·추가" : row.type === "links" ? "[[프로젝트·노트 이름" : "값 찾기·추가"}
      createLabel={(typed) => (row.type === "tags" ? `#${typed.replace(/^#/, "")} 추가` : row.type === "links" ? `[[${typed.replace(/^\[\[|\]\]$/g, "")}]] 추가` : `「${typed}」 추가`)}
      onPick={toggle}
      onCreate={create}
      onClose={onClose}
    />
  );
}

/** A text property that has values to pick (the template's options, what other projects wrote): one of them, or what is typed. */
function ChoicePicker({ row, anchor, props, choices, onClose }: PickerProps) {
  const first = valuesOf(row)[0] ?? "";
  const write = (value: string) => void props.onWrite({ note: props.workId, key: row.key, values: value.trim() ? [value.trim()] : null, type: row.type });
  return (
    <ValuePicker
      open
      anchor={anchor}
      label={keyLabel(row.key)}
      options={choices.map((choice) => ({ value: choice, label: choice, checked: choice === first }))}
      placeholder="값 찾기·쓰기"
      createLabel={(typed) => `「${typed}」 쓰기`}
      onPick={(value) => { if (value !== first) write(value); }}
      onCreate={write}
      onClose={onClose}
    />
  );
}

/** "+ 속성 추가": a name the vault knows, or a new one, which then picks its kind. */
function AddProperty({ props, onChosen }: { props: PropertyProps; onChosen: (key: string, type: PropertyType) => void }) {
  const [open, setOpen] = useState(false);
  const [named, setNamed] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const known = props.knownKeys.filter((entry) => !props.rows.some((row) => row.key === entry.key) && entry.type !== "stage");
  const options: PickOption[] = named
    ? KINDS.map((entry) => ({ value: entry.type, label: entry.label, icon: KIND_ICON[entry.type] }))
    : known.map((entry) => ({ value: entry.key, label: keyLabel(entry.key), icon: KIND_ICON[entry.type], hint: KIND_LABEL[entry.type] }));
  const close = () => {
    setOpen(false);
    setNamed(null);
  };
  const pick = (value: string) => {
    if (named) onChosen(named, value as PropertyType);
    else onChosen(value, known.find((entry) => entry.key === value)!.type);
    close();
  };
  return (
    <>
      <button ref={anchor} type="button" className="pn-prop-add" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="plus" size={14} /> 속성 추가
      </button>
      <ValuePicker
        open={open}
        anchor={anchor}
        label={named ? `「${named}」의 형식` : "속성 추가"}
        options={options}
        placeholder={named ? "형식" : "속성 이름"}
        createLabel={named ? undefined : (typed) => `「${typed}」 새 속성`}
        createKeepsOpen
        onCreate={named ? undefined : (typed) => {
          // A name the note already has goes to its row (the app's own key is answered there too).
          const existing = props.rows.find((row) => row.key === typed);
          if (existing || typed === MACHINE_KEY) {
            onChosen(typed, existing?.type ?? "text");
            close();
          } else setNamed(typed);
        }}
        onPick={pick}
        onClose={close}
      />
    </>
  );
}

/**
 * The properties of the note in their two places: `chips` (the stage and the tags, on the line under
 * the title) and `block` (every key as a row, under a head that folds). One state spans both — which
 * row's field is open, and the one picker, opened from a chip or from its row. A field is open when
 * the person opened it or when text is kept for it, and the block is shown open while such text
 * waits, however it was left folded. Kept text that has no field to return into (a "+ 속성 추가" key
 * after a reload, a key that became a picker or unreadable or was deleted outside, a note that does
 * not read) is a line under the rows, as are a refused value and a question about a changed key —
 * those lines stay when the block is folded: nothing kept or asked is ever out of sight. `close`
 * closes a key's field (the page settled a conflict about it).
 */
export function useNoteProperties(props: PropertyProps) {
  const choices = useValueChoices(props.rows);
  const note = props.workId;
  // What is kept on this device for this note's properties, by key.
  const kept = useKeptFields(note, "prop:");
  const drafts = new Map(kept.map((entry) => [entry.field.slice("prop:".length), entry.draft] as const));
  // The one-line fields the person opened.
  const [editing, setEditingSet] = useState<Set<string>>(() => new Set());
  const openField = (key: string) => setEditingSet((current) => new Set(current).add(key));
  const closeField = (key: string) => setEditingSet((current) => {
    const next = new Set(current);
    next.delete(key);
    return next;
  });
  // The one picker that is open, and which of the key's two triggers it hangs from.
  const [picking, setPicking] = useState<{ key: string; place: Place } | null>(null);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const triggers = useRef(new Map<string, HTMLElement>());
  const trigger = (place: Place, key: string) => (element: HTMLElement | null) => {
    if (element) triggers.current.set(`${place}:${key}`, element);
    else triggers.current.delete(`${place}:${key}`);
  };
  const anchor = useMemo(() => ({
    get current() {
      const at = pickingRef.current;
      return at ? (triggers.current.get(`${at.place}:${at.key}`) ?? null) : null;
    },
  }) as RefObject<HTMLElement | null>, []);
  // A key named in "+ 속성 추가" that the note does not have yet: a last row with its editor open until written or left.
  const [adding, setAdding] = useState<{ key: string; type: PropertyType } | null>(null);
  // Why a kept line's 쓰기 was refused, by key.
  const [problems, setProblems] = useState<Record<string, string>>({});
  // Why a row's typed value was refused, by key: said in a band under the rows, so the row keeps its height.
  const [fieldProblems, setFieldProblems] = useState<Record<string, string>>({});
  const setFieldProblem = (key: string, problem: string | null) => setFieldProblems((current) => {
    if ((current[key] ?? null) === problem) return current;
    const { [key]: _gone, ...rest } = current;
    return problem ? { ...rest, [key]: problem } : rest;
  });
  const [folded, toggleFold] = useSectionCollapsed("project.properties");
  // What the head folds, by an id of this block's own: the same note can be open in two panes (or
  // two React roots, where `useId` would repeat).
  const [rowsId] = useState(() => `pn-prop-rows-${(blocks += 1)}`);
  /** Typed text put away (Esc, 버리기): a notice brings it back to where it was. */
  const discarded = (key: string) => (draft: FieldDraft) => props.onNotice({ text: "고치던 내용을 버렸습니다", action: { label: "되살리기", run: () => keepField(note, `prop:${key}`, draft) } });
  const rows = props.rows;
  const machine = props.machine ?? null;
  const added = adding && !rows.some((row) => row.key === adding.key) ? adding : null;
  const pendingRow: PropertyRow | null = added ? { key: added.key, type: added.type, values: [], present: false, fromTemplate: false } : null;
  const lines = pendingRow ? [...rows, pendingRow] : rows;
  const modeOf = (row: PropertyRow): Mode => {
    if (props.readOnly || row === machine) return "static";
    if (row.editable === false) return "source";
    if (row.type === "stage") return "stage";
    if (MULTI.has(row.type)) return "values";
    if (row.type === "checkbox") return "check";
    if (row.type !== "text" || !(choices.get(row.key)?.length ?? 0)) return "line";
    // A sentence, or text the person typed and has not written yet, is edited as text. Only a short
    // value is picked from what the key offers (the template's options, other projects' values).
    return valuesOf(row).join(", ").length > LONG || drafts.has(row.key) ? "line" : "choice";
  };
  /** Whether this row is changed in a one-line field (where kept text returns to). */
  const takesLine = (row: PropertyRow) => modeOf(row) === "line";
  // A field is open when the person opened it, and for its kept text too. Kept text opens nothing
  // else (never a picker by itself).
  const isEditing = (row: PropertyRow) => takesLine(row) && (editing.has(row.key) || drafts.has(row.key));
  // Kept text without a field to return into.
  const orphans = [...drafts].filter(([key]) => !lines.some((row) => row.key === key && takesLine(row)));
  // Text kept for a row is never folded away.
  const open = !folded || drafts.size > orphans.length;
  const done = (key?: string) => {
    // Only the key that is done: a field closing late must not take a newer "+ 속성 추가" with it.
    setAdding((current) => (!key || current?.key === key ? null : current));
    if (key) {
      closeField(key);
      setFieldProblem(key, null);
      setPicking((current) => (current?.key === key ? null : current));
    }
  };
  /** The picker of a key, from one of its two triggers (again from the same one: shut). */
  const pick = (row: PropertyRow, place: Place) => {
    if (picking?.key === row.key && picking.place === place) return done(row.key);
    if (row.type === "tags") props.onWantTags();
    setPicking({ key: row.key, place });
  };
  const picked = picking ? lines.find((row) => row.key === picking.key) : undefined;
  const pickedMode = picked ? modeOf(picked) : null;
  const picks = pickedMode === "stage" || pickedMode === "values" || pickedMode === "choice";
  const pickedChipGone = Boolean(picking?.place === "chip" && picked && !hasValue(picked));
  useEffect(() => {
    if (!picking) return;
    // The picker follows what it hangs from: its row when the chip went with the last value, nothing when there is neither.
    if (!picks || (picking.place === "row" && !open)) setPicking(null);
    else if (pickedChipGone) setPicking(open ? { key: picking.key, place: "row" } : null);
  }, [picking, picks, open, pickedChipGone]);
  // A new key whose kind has a picker: it opens once its row is there to hang from.
  const pendingPicks = pendingRow && modeOf(pendingRow) === "values" ? pendingRow : null;
  useEffect(() => {
    if (!pendingPicks) return;
    if (pendingPicks.type === "tags") props.onWantTags();
    setPicking({ key: pendingPicks.key, place: "row" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPicks?.key]);
  /** Open a row's own editor. */
  const activate = (row: PropertyRow) => {
    const mode = modeOf(row);
    if (mode === "line") openField(row.key);
    else if (mode === "source") props.onSource(row.key);
    else if (mode !== "static" && mode !== "check" && !(picking?.key === row.key && picking.place === "row")) pick(row, "row");
  };
  const choose = (key: string, type: PropertyType) => {
    if (key === MACHINE_KEY) return props.onNotice({ text: `${MACHINE_KEY}는 앱이 이 노트를 알아보는 값이라 바꾸지 않습니다` });
    const row = rows.find((entry) => entry.key === key);
    if (row) return activate(row);
    // A new name, or a known one given another kind, is recorded with its kind (`.obsidian/types.json`).
    if (props.knownKeys.find((entry) => entry.key === key)?.type !== type && type !== "stage") props.onKind(key, type);
    if (type === "checkbox") {
      void props.onWrite({ note, key, values: ["true"], type });
      return;
    }
    setAdding({ key, type });
    if (LINE_KINDS.has(type)) openField(key);
  };
  const fold = () => {
    if (open && folded) return props.onNotice({ text: "쓰던 값이 남아 있어 속성을 접지 않았습니다" });
    // What was merely opened (nothing typed) is put away with the rows; a new key with typed text keeps its row.
    if (open) {
      setEditingSet(new Set());
      setAdding((current) => (current && readField(note, `prop:${current.key}`) ? current : null));
    }
    toggleFold();
  };

  /** A row's kind and removal (its kind icon, or a right click). */
  const menuOf = (row: PropertyRow): MenuEntry[] => {
    if (props.readOnly || row === machine) return [];
    const kinds: MenuEntry[] = KINDS.map((entry) => ({ kind: "item", label: entry.label, icon: KIND_ICON[entry.type], checked: entry.type === row.type, onSelect: () => props.onKind(row.key, entry.type) }));
    return [
      ...(row.type === "stage" ? [] : [{ kind: "submenu" as const, label: "형식", icon: KIND_ICON[row.type], items: kinds }]),
      // A key the note does not have (an empty template field, a new one) has nothing to remove.
      ...(row.present ? [{ kind: "separator" as const }, { kind: "item" as const, label: row.fromTemplate ? "값 지우기" : "속성 지우기", icon: "x" as const, danger: !row.fromTemplate, onSelect: () => void props.onWrite({ note, key: row.key, values: null, type: row.type }) }] : []),
    ];
  };
  const openMenuAt = (row: PropertyRow, x: number, y: number) => {
    const items = menuOf(row);
    if (items.length) props.openMenu({ x, y, title: keyLabel(row.key), items });
  };
  const arrowOpens = (row: PropertyRow, place: Place) => (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!(picking?.key === row.key && picking.place === place)) pick(row, place);
  };

  // The line under the title keeps what tells the note apart at a glance: its stage and its tags.
  const chips = rows.filter((row) => (row.type === "stage" || row.type === "tags") && hasValue(row)).map((row) => {
    const mode = modeOf(row);
    const shown = shownValue(row);
    const stage = row.type === "stage" ? props.stages.find((entry) => entry.name === shown) : undefined;
    const className = row.type === "stage" ? "note-prop pn-stage" : "note-prop pn-values kind-tags";
    const style = stage ? ({ "--stage": stage.color } as CSSProperties) : undefined;
    const inner = row.type === "stage" ? <><span className="pn-stage-dot" aria-hidden />{shown}</> : <span>{shown}</span>;
    if (mode === "static") return <span key={row.key} className={className} style={style}>{inner}</span>;
    const menu = (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault();
      openMenuAt(row, event.clientX, event.clientY);
    };
    if (mode === "source") {
      return <button key={row.key} type="button" className={className} style={style} aria-label={`${keyLabel(row.key)}: ${shown} — 원문에서 고치기`} onClick={() => props.onSource(row.key)} onContextMenu={menu}>{inner}</button>;
    }
    return (
      <button key={row.key} ref={trigger("chip", row.key)} type="button" className={className} style={style} aria-haspopup={row.type === "stage" ? "menu" : "listbox"} aria-expanded={picking?.key === row.key && picking.place === "chip"}
        aria-label={`${keyLabel(row.key)}: ${shown} — 바꾸기`} onClick={() => pick(row, "chip")} onKeyDown={arrowOpens(row, "chip")} onContextMenu={menu}>
        {inner}
      </button>
    );
  });

  const line = (row: PropertyRow) => {
    const mode = modeOf(row);
    const label = keyLabel(row.key);
    const values = valuesOf(row);
    const first = values[0] ?? "";
    const name = (action: string) => `${label}: ${values.length ? shownValue(row) : EMPTY} — ${action}`;
    const text = <ValueText row={row} stages={props.stages} />;
    const toSource = <button type="button" className="pn-prop-source" aria-label={name("원문에서 고치기")} onClick={() => props.onSource(row.key)}>원문에서 고치기</button>;
    let value: ReactNode;
    if (row.type === "checkbox") {
      value = (
        <>
          <input type="checkbox" className="pn-prop-check" aria-label={label} checked={first === "true"} disabled={mode !== "check"}
            onChange={() => void props.onWrite({ note, key: row.key, values: [first === "true" ? "false" : "true"], type: row.type })} />
          {mode === "source" ? toSource : null}
        </>
      );
    } else if (mode === "static") value = text;
    else if (mode === "source") value = <>{text}{toSource}</>;
    else if (mode === "line" && isEditing(row)) {
      const placeholder = row.type === "date" ? "2026-11-20, 11-20, 오늘" : row.type === "datetime" ? "2026-11-20 14:30, 지금" : row.type === "number" ? "숫자" : (row.hint ?? "");
      value = (
        <LineInput note={note} field={`prop:${row.key}`} initial={row.type === "text" ? values.join(", ") : first} added={row === pendingRow ? row.type : undefined} label={label} placeholder={placeholder} revision={props.revision}
          onDiscard={discarded(row.key)} onProblem={(problem) => setFieldProblem(row.key, problem)}
          onCommit={(typed, base, bound) => props.onWrite({ note: bound, key: row.key, values: typed.trim() ? [typed.trim()] : null, type: row.type, inline: true, base })} onClose={() => done(row.key)} />
      );
    } else if (mode === "line") {
      value = <button type="button" className="pn-prop-button" aria-label={name("고치기")} onClick={() => openField(row.key)}>{text}</button>;
    } else {
      value = (
        <button ref={trigger("row", row.key)} type="button" className="pn-prop-button" aria-haspopup={mode === "stage" ? "menu" : "listbox"} aria-expanded={picking?.key === row.key && picking.place === "row"}
          aria-label={name(row.type === "list" || mode === "choice" ? "고치기" : "바꾸기")} onClick={() => pick(row, "row")} onKeyDown={arrowOpens(row, "row")}>
          {text}
        </button>
      );
    }
    const menu = menuOf(row).length > 0;
    return (
      <div key={row.key} className="pn-prop" data-key={row.key} data-kind={row.type} data-machine={row === machine ? "" : undefined} title={row === machine ? MACHINE_WHY : undefined}
        onContextMenu={menu ? (event) => {
          // A field keeps the browser's own menu (paste).
          if ((event.target as HTMLElement).closest("input[type=text], input:not([type])")) return;
          event.preventDefault();
          openMenuAt(row, event.clientX, event.clientY);
        } : undefined}>
        <dt className="pn-prop-key" title={row.key !== label ? row.key : row.hint}>
          {menu ? (
            <button type="button" className="pn-prop-kind" aria-haspopup="menu" aria-label={`${label} 형식: ${KIND_LABEL[row.type]}`} title={row.type === "stage" ? KIND_LABEL[row.type] : `${KIND_LABEL[row.type]} · 형식 바꾸기`}
              onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); openMenuAt(row, box.left, box.bottom + 4); }}>
              <Icon name={KIND_ICON[row.type]} size={14} />
            </button>
          ) : <span className="pn-prop-kind" aria-hidden><Icon name={KIND_ICON[row.type]} size={14} /></span>}
          <span className="pn-prop-name">{label}</span>
        </dt>
        <dd className="pn-prop-value">{value}</dd>
      </div>
    );
  };

  // A refused value: its reason and the ways out, in a band (고치기 goes back to the field, 버리기 puts the text away).
  const refusedLines = lines.filter((row) => fieldProblems[row.key] && isEditing(row)).map((row) => {
    const label = keyLabel(row.key);
    const away = () => {
      const draft = readField(note, `prop:${row.key}`);
      keepField(note, `prop:${row.key}`, null);
      done(row.key);
      if (draft) discarded(row.key)(draft);
    };
    return (
      <div key={`refused:${row.key}`} className="pn-band" data-refused={row.key}>
        <span className="dot dot-error" aria-hidden />
        <strong>{label}</strong>
        <span className="pn-band-text" role="alert">{fieldProblems[row.key]}</span>
        <span className="pn-edit-actions">
          <button type="button" className="button small" aria-label={`${label} 고치기`} onClick={(event) => event.currentTarget.closest(".pn-props")?.querySelector<HTMLInputElement>(`.pn-prop[data-key="${CSS.escape(row.key)}"] input`)?.focus()}>고치기</button>
          <button type="button" className="button small" aria-label={`${label} 버리기`} onMouseDown={(event) => event.preventDefault()} onClick={away}>버리기</button>
        </span>
      </div>
    );
  });
  // Kept text without a field: a line under the rows, never one of them.
  const keptLines = orphans.map(([key, draft]) => {
    const row = rows.find((entry) => entry.key === key);
    const label = keyLabel(key);
    // "쓰기" only where the text can still become this key's one line: a key the person was adding, still without a value.
    const kind = draft.added;
    const writable = !props.readOnly && kind !== undefined && LINE_KINDS.has(kind) && !(row && hasValue(row)) && row?.editable !== false && !(kind === "text" && (choices.get(key)?.length ?? 0) > 0);
    const write = async () => {
      const outcome = await props.onWrite({ note, key, values: draft.text.trim() ? [draft.text.trim()] : null, type: kind!, inline: true, base: draft.baseRevision });
      setProblems((current) => {
        const { [key]: _gone, ...rest } = current;
        return "refused" in outcome ? { ...rest, [key]: outcome.refused } : rest;
      });
      // Written: nothing is kept for it any more (unless something else was kept meanwhile).
      if ("revision" in outcome && readField(note, `prop:${key}`)?.text === draft.text) keepField(note, `prop:${key}`, null);
    };
    return (
      <div key={`kept:${key}`} className="pn-band" data-kept={key} title={writable ? undefined : "지금은 이 속성을 여기서 한 줄로 쓸 수 없습니다. 복사해 두거나 버릴 수 있습니다."}>
        <span className="pn-meta-key">{`쓰다 만 속성 · ${label}`}</span>
        <span className="pn-kept-text" title={draft.text}>{draft.text || "(비움)"}</span>
        <span className="pn-edit-actions">
          {writable
            ? <button type="button" className="button small" aria-label={`${label} 쓰기`} onClick={() => void write()}>쓰기</button>
            : <button type="button" className="button small" aria-label={`${label} 복사`} onClick={() => { void navigator.clipboard?.writeText(draft.text); props.onNotice({ text: "복사했습니다" }); }}>복사</button>}
          <button type="button" className="button small" aria-label={`${label} 버리기`} onClick={() => { keepField(note, `prop:${key}`, null); discarded(key)(draft); }}>버리기</button>
        </span>
        {problems[key] ? <span className="pn-field-problem" role="alert">{problems[key]}</span> : null}
      </div>
    );
  });
  // A key changed elsewhere since the person saw it: both values on one line, and the choice.
  const conflictLines = Object.entries(props.conflicts).map(([key, conflict]) => (
    <div key={`conflict:${key}`} className="pn-band pn-key-conflict" role="alert" aria-label="속성 충돌">
      <span className="dot dot-attention" aria-hidden />
      <span className="pn-band-text">
        <strong>{keyLabel(key)}</strong> · {conflict.message} 저쪽: <strong>{conflict.theirs}</strong> · 내 것: <strong>{mineOf(conflict.write)}</strong>
      </span>
      <span className="pn-edit-actions">
        <button type="button" className="button small" onClick={() => props.onSettle(key, true)}>내 것으로 쓰기</button>
        <button type="button" className="button small" onClick={() => props.onSettle(key, false)}>저쪽 것 받기</button>
      </span>
    </div>
  ));
  const bands = [...refusedLines, ...keptLines, ...conflictLines];

  const pickerProps = picked && picks ? { row: picked, anchor, props, choices: choices.get(picked.key) ?? [], onClose: () => done(picked.key) } : null;
  const block = (
    <section className="pn-props" aria-label="속성">
      <SectionLabel
        collapsed={!open}
        onToggle={fold}
        controls={rowsId}
        // The rows drawn: what the person would count.
        count={lines.length + (machine ? 1 : 0)}
        action={props.onRaw ? <button type="button" className="link small" title="노트의 속성과 본문을 원문(YAML·Markdown) 그대로 엽니다" onClick={props.onRaw}>원문</button> : null}
      >
        속성
      </SectionLabel>
      <div id={rowsId} hidden={!open}>
        {open ? (
          <>
            <dl className="pn-prop-rows">
              {lines.map(line)}
              {machine ? line(machine) : null}
            </dl>
            {props.readOnly ? null : <AddProperty props={props} onChosen={choose} />}
          </>
        ) : null}
      </div>
      {bands.length ? <div className="pn-bands">{bands}</div> : null}
      {!pickerProps ? null : pickedMode === "stage" ? <StagePicker key={picked!.key} {...pickerProps} /> : pickedMode === "values" ? <ValuesPicker key={picked!.key} {...pickerProps} /> : <ChoicePicker key={picked!.key} {...pickerProps} />}
    </section>
  );
  return { chips, block, close: done };
}
