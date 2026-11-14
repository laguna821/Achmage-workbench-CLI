import { useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { ListLayer, MenuGroup, MenuItem, MenuSeparator } from "./Menu.tsx";
import { matchesWord, type Align, type Side } from "./overlay.ts";

export type SelectOption<T> = {
  value: T;
  label: string;
  /** Right-aligned secondary text (a status, a folder, a number). */
  hint?: ReactNode;
  icon?: IconName | ReactNode;
  /** Options with the same group are listed together under that heading, in first-seen order. */
  group?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Extra words a search matches. */
  keywords?: string[];
  /** Tooltip of the row (e.g. a folder path). */
  title?: string;
};

/** A row pinned after the options that runs an action instead of choosing a value (e.g. "새 프로젝트"). */
export type SelectAction = {
  key: string;
  label: string;
  onSelect: () => void;
  hint?: ReactNode;
  icon?: IconName | ReactNode;
  /** Shown with ✓ and active on opening, as the current choice (e.g. "새 프로젝트" when no project is picked). */
  checked?: boolean;
  title?: string;
};

export type SelectProps<T> = {
  value: T | null;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name of the trigger and the list. */
  label: string;
  /** Shown when no option has `value`. */
  placeholder?: string;
  /** A search field at the top. */
  searchable?: boolean;
  /**
   * How the search narrows `options` (default: label, group or keyword contains the query, or a word
   * starts with it). `false`: the caller already narrowed them, e.g. ranked from `onQueryChange`.
   */
  filter?: ((option: SelectOption<T>, query: string) => boolean) | false;
  /** The search text as it changes (it starts empty on every opening). */
  onQueryChange?: (query: string) => void;
  searchPlaceholder?: string;
  /** Shown when no option matches (pinned actions stay below it). */
  emptyText?: string;
  /**
   * Action rows after the options. Arrows reach them; after the search text changes the first
   * matching option is active instead, so Enter takes a match, never an action you did not move to.
   */
  actions?: readonly SelectAction[];
  disabled?: boolean;
  /** Leading icon on the trigger. */
  icon?: ReactNode;
  /** What the trigger shows for the chosen option (default: its label). */
  renderValue?: (option: SelectOption<T>) => ReactNode;
  side?: Side;
  align?: Align;
  title?: string;
  className?: string;
};

const fold = (text: string) => text.normalize("NFC").toLocaleLowerCase();

/** The default search: label, group or keyword contains the query, or one of their words starts with it. */
export function matchesOption<T>(option: SelectOption<T>, query: string) {
  const needle = fold(query.trim());
  if (!needle) return true;
  const fields = [option.label, option.group ?? "", ...(option.keywords ?? [])];
  return fields.some(field => fold(field).includes(needle) || matchesWord(field, needle));
}

/** A single choice from a list, drawn as the shared menu instead of the native (GTK) popup. */
export function Select<T extends string | number>({
  value, options, onChange, label, placeholder = "선택", searchable = false, filter = matchesOption, onQueryChange,
  searchPlaceholder, emptyText = "맞는 항목이 없습니다.", actions = [], disabled, icon, renderValue, side, align, title, className = "",
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<"checked" | "first" | "last">("checked");
  const [query, setQueryState] = useState("");
  const setQuery = (next: string) => { setQueryState(next); onQueryChange?.(next); };
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find(option => option.value === value);
  const shown = useMemo(() => (filter ? options.filter(option => filter(option, query)) : options), [options, query, filter]);
  const groups = useMemo(() => {
    const order: (string | undefined)[] = [];
    for (const option of shown) if (!order.includes(option.group)) order.push(option.group);
    return order.map(group => ({ group, options: shown.filter(option => option.group === group) }));
  }, [shown]);

  const show = (from: "checked" | "first" | "last") => {
    if (disabled) return;
    if (query) setQuery("");
    setInitial(from);
    setOpen(true);
  };
  const item = (option: SelectOption<T>) => (
    <MenuItem key={String(option.value)} checked={option.value === value} icon={option.icon} hint={option.hint}
      disabled={option.disabled} disabledReason={option.disabledReason} textValue={option.label} value={String(option.value)} title={option.title}
      onSelect={() => { if (option.value !== value) onChange(option.value); }}>
      {option.label}
    </MenuItem>
  );

  return <>
    <button ref={trigger} type="button" className={`ui-select ${className}`} aria-haspopup="listbox" aria-expanded={open} aria-label={label}
      disabled={disabled} title={title} data-placeholder={current ? undefined : ""}
      onClick={() => (open ? setOpen(false) : show("checked"))}
      onKeyDown={event => {
        const from = event.key === "ArrowDown" || event.key === "ArrowUp" ? "checked" : event.key === "Home" ? "first" : event.key === "End" ? "last" : null;
        if (!from || open) return;
        event.preventDefault();
        show(from);
      }}>
      {icon ? <span className="ui-select-icon" aria-hidden>{icon}</span> : null}
      <span className="ui-select-value">{current ? renderValue?.(current) ?? current.label : placeholder}</span>
      <Icon name="chevronDown" size={14} className="ui-select-chevron" />
    </button>
    <ListLayer role="listbox" open={open} onClose={() => setOpen(false)} anchor={trigger} label={label} side={side} align={align}
      minWidth="anchor" className={`ui-select-menu${searchable ? " searchable" : ""}`} initialActive={initial}
      search={searchable ? { query, onQuery: setQuery, label: `${label} 찾기`, placeholder: searchPlaceholder } : undefined}
      resetKey={searchable ? query : undefined}
      footer={!shown.length && !actions.length ? <div className="ui-menu-empty" role="status">{emptyText}</div> : null}>
      {groups.map(({ group, options: grouped }) => group
        ? <MenuGroup key={group} label={group}>{grouped.map(item)}</MenuGroup>
        : grouped.map(item))}
      {actions.length ? <>
        {shown.length ? <MenuSeparator /> : <div className="ui-menu-empty" role="status">{emptyText}</div>}
        {actions.map(action => <MenuItem key={action.key} pinned checked={action.checked ?? false} icon={action.icon} hint={action.hint} title={action.title}
          value={`action:${action.key}`} textValue={action.label} onSelect={action.onSelect}>{action.label}</MenuItem>)}
      </> : null}
    </ListLayer>
  </>;
}
