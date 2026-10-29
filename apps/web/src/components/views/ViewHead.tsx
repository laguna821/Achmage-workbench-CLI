import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  LAYOUT_LABEL,
  VIEW_LAYOUTS,
  VIEW_LIMITS,
  defaultViews,
  groupKey,
  plainView,
  resetView,
  type GroupRule,
  type HomeView,
  type HomeViewMode,
  type ModeViews,
  type ViewLayout,
} from "@workbench/contracts";
import { Icon } from "../Icon.tsx";
import { MenuItem, Popover } from "../Popover.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import { ColorPick, groupStyle, paintGroup } from "./parts.tsx";

// The head of a home mode: its views as tabs (like the view list of a .base file; "+" adds one,
// a right click renames, duplicates, deletes or resets it) and a calm row of small popovers for the
// view shown — 묶기 · 하위 묶기 · 정렬 · 거르기 · 속성 · 모양 (흐름: 거르기 · 색 기준). Every change is
// saved to the view at once, as Notion does.

export type KeyChoice = { key: string; label: string; dated?: boolean };

export type ShownGroups = { key: string; label: string; list: { id: string; label: string; color: string | null }[] };

const newId = () => `v-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new view of a layout, grouped the way that layout is usually read in this mode. */
function freshView(mode: HomeViewMode, layout: ViewLayout, name: string): HomeView {
  const group: GroupRule | null =
    mode === "projects"
      ? layout === "board"
        ? { key: "stage" }
        : layout === "cards"
          ? { key: "folder", hideEmpty: true }
          : null
      : mode === "now"
        ? { key: layout === "board" ? "status" : "project", ...(layout === "board" ? {} : { hideEmpty: true }) }
        : mode === "docs" && layout === "list"
          ? { key: "project", hideEmpty: true }
          : null;
  return plainView(newId(), name, layout, { group, ...(mode === "flow" ? { colorBy: "engine" } : {}), ...(mode === "docs" ? { sort: { key: "modified", dir: "desc" } } : {}) });
}

const uniqueName = (views: HomeView[], base: string) => {
  if (!views.some((view) => view.name === base)) return base;
  for (let number = 2; ; number += 1) if (!views.some((view) => view.name === `${base} ${number}`)) return `${base} ${number}`;
};

/** The view tabs of a mode. */
export function ViewTabs({ mode, views, onViews, className = "" }: { mode: HomeViewMode; views: ModeViews; onViews: (next: ModeViews) => void; className?: string }) {
  const pkm = useOptionalPkm();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const closeAdd = useCallback(() => setAdding(false), []);
  const list = views.views;
  const missing = defaultViews(mode).filter((shipped) => !list.some((view) => view.id === shipped.id));
  const full = list.length >= VIEW_LIMITS.views;

  const update = (id: string, change: (view: HomeView) => HomeView) => onViews({ ...views, views: list.map((view) => (view.id === id ? change(view) : view)) });
  const add = (view: HomeView) => {
    setAdding(false);
    if (full) return pkm?.onToast(`보기는 모드마다 ${VIEW_LIMITS.views}개까지입니다.`);
    onViews({ views: [...list, view], current: view.id });
  };
  const remove = (id: string) => {
    if (list.length < 2) return;
    const at = list.findIndex((view) => view.id === id);
    const rest = list.filter((view) => view.id !== id);
    onViews({ views: rest, current: views.current === id ? rest[Math.max(0, at - 1)]!.id : views.current });
  };
  const menu = (view: HomeView, x: number, y: number) =>
    pkm?.openMenu({
      x,
      y,
      title: view.name,
      items: [
        { kind: "item", label: "이름 바꾸기", icon: "edit", onSelect: () => setRenaming(view.id) },
        { kind: "item", label: "복제", icon: "copy", disabled: full, onSelect: () => add({ ...structuredClone(view), id: newId(), name: uniqueName(list, `${view.name} 사본`.slice(0, VIEW_LIMITS.name)) }) },
        { kind: "item", label: "기본값으로", icon: "restore", onSelect: () => update(view.id, (current) => resetView(mode, current)) },
        { kind: "separator" },
        { kind: "item", label: "지우기", icon: "x", danger: true, disabled: list.length < 2, onSelect: () => remove(view.id) },
      ],
    });

  return (
    <div className={`view-tabs ${className}`}>
      {/* The tabs scroll sideways when there are many; "+" and its menu stay outside (not clipped). */}
      <div className="view-tab-list" role="tablist" aria-label="보기">
        {list.map((view) =>
          renaming === view.id ? (
            <RenameField
              key={view.id}
              name={view.name}
              onDone={(name) => {
                setRenaming(null);
                if (name && name !== view.name) update(view.id, (current) => ({ ...current, name: name.slice(0, VIEW_LIMITS.name) }));
              }}
            />
          ) : (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={views.current === view.id}
              className={`view-tab${views.current === view.id ? " on" : ""}`}
              data-view={view.id}
              title={`${LAYOUT_LABEL[view.layout]} · 두 번 누르면 이름 바꾸기 · 오른쪽 클릭: 복제·지우기·기본값으로`}
              onClick={() => views.current !== view.id && onViews({ ...views, current: view.id })}
              onDoubleClick={() => setRenaming(view.id)}
              onContextMenu={(event) => {
                // Home's own right click (the engine's look) is not this one.
                event.preventDefault();
                event.stopPropagation();
                menu(view, event.clientX, event.clientY);
              }}
            >
              {view.name}
            </button>
          ),
        )}
      </div>
      <div className="anchor view-add-anchor">
        <button type="button" className="icon-button small view-add" aria-label="보기 더하기" title="보기 더하기" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Icon name="plus" size={14} />
        </button>
        <Popover open={adding} onClose={closeAdd} className="view-pop view-add-pop">
          <div className="menu-label">새 보기</div>
          {VIEW_LAYOUTS[mode].map((layout) => (
            <MenuItem key={layout} disabled={full} onSelect={() => add(freshView(mode, layout, uniqueName(list, LAYOUT_LABEL[layout])))}>
              {LAYOUT_LABEL[layout]}
            </MenuItem>
          ))}
          {missing.length ? (
            <>
              <div className="menu-divider" />
              <div className="menu-label">지운 기본 보기</div>
              {missing.map((view) => (
                <MenuItem key={view.id} disabled={full} hint={LAYOUT_LABEL[view.layout]} onSelect={() => add(view)}>
                  {view.name}
                </MenuItem>
              ))}
            </>
          ) : null}
        </Popover>
      </div>
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(commit ? value.trim() : name);
  };
  return (
    <input
      className="view-tab-input"
      autoFocus
      value={value}
      aria-label="보기 이름"
      maxLength={VIEW_LIMITS.name}
      size={Math.max(4, [...value].length + 1)}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") {
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** A tool of the bar: a quiet text button with its popover. */
function Tool({ label, value, on, children, wide = false }: { label: string; value?: string; on: boolean; children: (close: () => void) => ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="anchor view-tool-anchor">
      <button type="button" className={`view-tool${on ? " on" : ""}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {label}
        {value ? <span className="view-tool-value">{value}</span> : null}
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={close} align="right" className={`view-pop${wide ? " wide" : ""}`}>
        {children(close)}
      </Popover>
    </div>
  );
}

/** The app's on/off switch (the same checkbox, drawn as a switch). */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="check-row switch-row view-switch" data-gallery="uiverse:Toggle-switches/zjssun_friendly-sheep-29" data-component="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function Segments<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented small view-segments" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? "active" : ""} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function GroupMenu({ view, sub, keys, onView }: { view: HomeView; sub: boolean; keys: KeyChoice[]; onView: (view: HomeView) => void }) {
  const rule = sub ? view.subgroup : view.group;
  const choice = keys.find((entry) => entry.key === rule?.key);
  const set = (next: GroupRule | null) => onView(sub ? { ...view, subgroup: next } : { ...view, group: next, subgroup: next ? view.subgroup : null });
  const offered = keys.filter((entry) => !sub || entry.key !== view.group?.key);
  return (
    <>
      <div className="menu-label">{sub ? "하위 묶기 — 보드는 가로줄, 다른 배치는 묶음 안의 묶음" : "묶기"}</div>
      <div className="view-pop-list">
        <MenuItem active={!rule} onSelect={() => set(null)}>
          없음
        </MenuItem>
        {offered.map((entry) => (
          <MenuItem
            key={entry.key}
            active={rule?.key === entry.key}
            onSelect={() => set({ key: entry.key, ...(entry.dated ? { dates: "period" as const } : {}), ...(view.layout !== "board" && !sub ? { hideEmpty: true } : {}) })}
          >
            {entry.label}
          </MenuItem>
        ))}
      </div>
      {rule ? (
        <div className="view-pop-options">
          {choice?.dated ? (
            <Segments
              label="날짜 묶기"
              value={rule.dates ?? "period"}
              options={[
                { id: "period", label: "기간" },
                { id: "month", label: "월별" },
                { id: "week", label: "주별" },
              ]}
              onChange={(dates) => set({ ...rule, dates })}
            />
          ) : null}
          <Switch label="순서 뒤집기" checked={Boolean(rule.reverse)} onChange={(reverse) => set({ ...rule, reverse: reverse || undefined })} />
          <Switch label="빈 묶음 숨기기" checked={Boolean(rule.hideEmpty)} onChange={(hideEmpty) => set({ ...rule, hideEmpty: hideEmpty || undefined })} />
        </div>
      ) : null}
    </>
  );
}

/** Colour rows for the groups shown: a dot to open the palette, the name. */
function GroupColors({ view, groups, onView }: { view: HomeView; groups: ShownGroups[]; onView: (view: HomeView) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = groups.filter((entry) => entry.list.length);
  if (!shown.length) return <p className="view-pop-note">묶기를 정하면 묶음마다 색을 고를 수 있습니다.</p>;
  return (
    <>
      {shown.map((entry) => (
        <div key={entry.key} className="view-colors">
          <div className="menu-label">{entry.label} 색</div>
          {entry.list.map((group) => {
            const at = groupKey(entry.key, group.id);
            const picked = view.look.colors[at] ?? null;
            const color = picked ?? group.color;
            return (
              <div key={at} className="view-color-row">
                <button type="button" className={`view-color-dot${color ? "" : " none"}`} style={groupStyle(color)} aria-label={`${group.label} 색 고르기`} aria-expanded={open === at} onClick={() => setOpen(open === at ? null : at)} />
                <button type="button" className="view-color-name" onClick={() => setOpen(open === at ? null : at)}>
                  {group.label}
                </button>
                {picked ? <span className="view-color-own">고른 색</span> : null}
                {open === at ? <ColorPick value={picked} base={group.color} label={group.label} onChange={(next) => onView(paintGroup(view, entry.key, group.id, next))} /> : null}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * The toolbar of the view shown. `keys` lists what it can be grouped, sorted and shown by;
 * `groups` the groups on screen (for their colours). 흐름 passes `colorBy` keys instead.
 */
export function ViewTools({
  mode,
  view,
  onView,
  groupKeys,
  sortKeys,
  fields,
  defaultFields,
  groups = [],
  colorKeys,
  filterHint = "이름 · #태그 · 단계:진행중 · 폴더:이름 · 속성:값",
}: {
  mode: HomeViewMode;
  view: HomeView;
  onView: (view: HomeView) => void;
  groupKeys: KeyChoice[];
  sortKeys: KeyChoice[];
  fields?: { id: string; label: string }[];
  defaultFields?: string[];
  groups?: ShownGroups[];
  colorKeys?: KeyChoice[];
  filterHint?: string;
}) {
  const [filtering, setFiltering] = useState(Boolean(view.filter));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setFiltering((current) => current || Boolean(view.filter)), [view.filter]);
  const groupLabel = groupKeys.find((entry) => entry.key === view.group?.key)?.label;
  const subLabel = groupKeys.find((entry) => entry.key === view.subgroup?.key)?.label;
  const sortLabel = sortKeys.find((entry) => entry.key === view.sort?.key)?.label;
  const shownFields = view.fields ?? defaultFields ?? [];
  const layouts = VIEW_LAYOUTS[mode];
  const grouping = view.layout !== "calendar";
  const sorting = view.layout !== "graph" && view.layout !== "calendar" && sortKeys.length > 0;
  const nesting = view.layout !== "graph" && view.layout !== "calendar" && Boolean(view.group);
  const fieldsShown = Boolean(fields?.length) && view.layout !== "graph" && view.layout !== "calendar";

  return (
    <div className="view-tools" role="toolbar" aria-label="보기 설정">
      {filtering ? (
        <input
          ref={input}
          className="view-filter"
          value={view.filter}
          placeholder={filterHint}
          title={`${filterHint} · 앞에 -는 빼기`}
          aria-label="거르기"
          autoFocus={!view.filter}
          onChange={(event) => onView({ ...view, filter: event.target.value.slice(0, VIEW_LIMITS.filter) })}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            onView({ ...view, filter: "" });
            setFiltering(false);
          }}
        />
      ) : null}
      {grouping && !colorKeys ? (
        <Tool label="묶기" value={groupLabel} on={Boolean(view.group)}>
          {() => <GroupMenu view={view} sub={false} keys={groupKeys} onView={onView} />}
        </Tool>
      ) : null}
      {nesting ? (
        <Tool label="하위 묶기" value={subLabel} on={Boolean(view.subgroup)}>
          {() => <GroupMenu view={view} sub keys={groupKeys} onView={onView} />}
        </Tool>
      ) : null}
      {sorting ? (
        <Tool label="정렬" value={sortLabel ? `${sortLabel} ${view.sort?.dir === "asc" ? "↑" : "↓"}` : undefined} on={false}>
          {() => (
            <>
              <div className="menu-label">정렬</div>
              <div className="view-pop-list">
                <MenuItem active={!view.sort} onSelect={() => onView({ ...view, sort: null })}>
                  없음
                </MenuItem>
                {sortKeys.map((entry) => (
                  <MenuItem key={entry.key} active={view.sort?.key === entry.key} onSelect={() => onView({ ...view, sort: { key: entry.key, dir: view.sort?.key === entry.key ? view.sort.dir : entry.dated || entry.key === "activity" ? "desc" : "asc" } })}>
                    {entry.label}
                  </MenuItem>
                ))}
              </div>
              {view.sort ? (
                <div className="view-pop-options">
                  <Segments
                    label="정렬 방향"
                    value={view.sort.dir}
                    options={[
                      { id: "asc", label: "오름차순" },
                      { id: "desc", label: "내림차순" },
                    ]}
                    onChange={(dir) => onView({ ...view, sort: { ...view.sort!, dir } })}
                  />
                </div>
              ) : null}
            </>
          )}
        </Tool>
      ) : null}
      <button
        type="button"
        className={`view-tool${view.filter ? " on" : ""}`}
        aria-pressed={filtering}
        onClick={() => {
          if (filtering && !view.filter) setFiltering(false);
          else {
            setFiltering(true);
            requestAnimationFrame(() => input.current?.focus());
          }
        }}
      >
        거르기
      </button>
      {fieldsShown ? (
        <Tool label="속성" on={Boolean(view.fields)}>
          {() => (
            <>
              <div className="menu-label">보일 속성</div>
              <div className="view-pop-list">
                {fields!.map((field) => (
                  <Switch
                    key={field.id}
                    label={field.label}
                    checked={shownFields.includes(field.id)}
                    onChange={(on) => onView({ ...view, fields: on ? [...shownFields, field.id] : shownFields.filter((id) => id !== field.id) })}
                  />
                ))}
              </div>
              {view.fields ? (
                <div className="view-pop-options">
                  <button type="button" className="link small" onClick={() => onView({ ...view, fields: null })}>
                    기본값으로
                  </button>
                </div>
              ) : null}
            </>
          )}
        </Tool>
      ) : null}
      {colorKeys ? (
        <Tool label="색 기준" value={colorKeys.find((entry) => entry.key === (view.colorBy ?? "engine"))?.label} on={(view.colorBy ?? "engine") !== "engine"} wide>
          {() => (
            <>
              <div className="menu-label">색 기준</div>
              <div className="view-pop-list">
                {colorKeys.map((entry) => (
                  <MenuItem key={entry.key} active={(view.colorBy ?? "engine") === entry.key} onSelect={() => onView({ ...view, colorBy: entry.key })}>
                    {entry.label}
                  </MenuItem>
                ))}
              </div>
              {(view.colorBy ?? "engine") !== "engine" ? <GroupColors view={view} groups={groups} onView={onView} /> : null}
            </>
          )}
        </Tool>
      ) : (
        <Tool label="모양" on={view.look.border || view.look.heading || view.look.tint > 0} wide>
          {() => (
            <>
              {layouts.length > 1 ? (
                <>
                  <div className="menu-label">배치</div>
                  <div className="view-pop-options">
                    <Segments label="배치" value={view.layout} options={layouts.map((layout) => ({ id: layout, label: LAYOUT_LABEL[layout] }))} onChange={(layout) => onView({ ...view, layout })} />
                  </div>
                </>
              ) : null}
              <div className="menu-label">묶음 모양</div>
              <div className="view-pop-options">
                <Switch label="테두리 (보드 열은 위에 굵은 띠)" checked={view.look.border} onChange={(border) => onView({ ...view, look: { ...view.look, border } })} />
                <Switch label="머리 강조" checked={view.look.heading} onChange={(heading) => onView({ ...view, look: { ...view.look, heading } })} />
                <label className="slider-row view-range">
                  <span>옅은 바탕</span>
                  <input type="range" min={0} max={30} step={2} value={view.look.tint} aria-label="옅은 바탕 세기" onChange={(event) => onView({ ...view, look: { ...view.look, tint: Number(event.target.value) } })} />
                  <span className="slider-value">{view.look.tint}%</span>
                </label>
              </div>
              <GroupColors view={view} groups={groups} onView={onView} />
            </>
          )}
        </Tool>
      )}
    </div>
  );
}

/** Tabs on the left, the tools on the right, one calm line (it wraps when the window is narrow). */
export function ViewHead({ tabs, tools }: { tabs: ReactNode; tools: ReactNode }) {
  return (
    <div className="view-head">
      {tabs}
      {tools}
    </div>
  );
}
