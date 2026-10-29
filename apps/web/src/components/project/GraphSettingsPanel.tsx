import { useEffect, useRef, useState, type ReactNode } from "react";
import { GRAPH_RANGES, GRAPH_SWATCHES, resetAll, resetSection, type GraphSection, type GraphSettings } from "../../graph-settings.ts";
import { Icon } from "../Icon.tsx";

/**
 * The graph's settings, in a panel over the graph's corner as in Obsidian (not a dialog: the graph
 * stays live beside it): 필터 · 색 · 표시 · 힘, each folding, each with "기본값으로".
 */
export function GraphSettingsPanel({
  settings,
  onChange,
  pinned,
  onUnpinAll,
  onClose,
}: {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  pinned: number;
  onUnpinAll: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(".graph-section-toggle")?.focus({ preventScroll: true });
  }, []);
  const set = <S extends keyof GraphSettings>(section: S, patch: Partial<GraphSettings[S]>) => onChange({ ...settings, [section]: { ...settings[section], ...patch } });
  const { filter, color, display, force, open } = settings;

  const section = (id: GraphSection, title: string, body: ReactNode) => (
    <section className={`graph-section${open[id] ? " open" : ""}`}>
      <div className="graph-section-head">
        <button type="button" className="graph-section-toggle" aria-expanded={open[id]} onClick={() => set("open", { [id]: !open[id] })}>
          <Icon name="chevronRight" size={13} />
          {title}
        </button>
        {open[id] ? (
          <button type="button" className="graph-reset" onClick={() => onChange(resetSection(settings, id))}>
            기본값으로
          </button>
        ) : null}
      </div>
      {open[id] ? <div className="graph-section-body">{body}</div> : null}
    </section>
  );

  return (
    <aside
      ref={panel}
      className="graph-panel"
      aria-label="그래프 설정"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="graph-panel-head">
        <span className="graph-panel-title">그래프 설정</span>
        <button type="button" className="graph-reset" onClick={() => onChange(resetAll(settings))}>
          모두 기본값으로
        </button>
        <button type="button" className="icon-button small" aria-label="닫기" title="닫기" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="graph-panel-body">
        {section(
          "filter",
          "필터",
          <>
            <label className="graph-field">
              <span>이름으로 거르기</span>
              <input className="graph-search" value={filter.search} placeholder="이름 · #태그 · -뺄 말" spellCheck={false} onChange={(event) => set("filter", { search: event.target.value })} />
            </label>
            <Switch label="태그 점 보이기" checked={filter.tags} onChange={(tags) => set("filter", { tags })} />
            <Switch label="관련 선 보이기" checked={filter.relatedLines} onChange={(relatedLines) => set("filter", { relatedLines })} />
            <Switch label="태그 선 보이기" checked={filter.tagLines} disabled={!filter.tags} onChange={(tagLines) => set("filter", { tagLines })} />
            <Switch label="보관한 프로젝트 보이기" checked={filter.archived} onChange={(archived) => set("filter", { archived })} />
            <Switch label="연결 없는 프로젝트 보이기" checked={filter.orphans} onChange={(orphans) => set("filter", { orphans })} />
          </>,
        )}
        {section(
          "color",
          "색",
          <>
            <div className="graph-color">
              <div className="graph-color-head">
                <span>프로젝트 점</span>
                <div className="segmented small" role="radiogroup" aria-label="프로젝트 점 색">
                  {(
                    [
                      ["stage", "단계 색"],
                      ["one", "한 색"],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} type="button" role="radio" aria-checked={color.projectBy === id} className={color.projectBy === id ? "active" : ""} onClick={() => set("color", { projectBy: id })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {color.projectBy === "one" ? <ColorField label="프로젝트 점 색" value={color.project} fallback="var(--graph-project-default)" onChange={(project) => set("color", { project })} /> : null}
            <ColorField label="태그 점" value={color.tag} fallback="var(--graph-tag-default)" onChange={(tag) => set("color", { tag })} />
            <ColorField label="관련 선" value={color.related} fallback="var(--graph-related-default)" onChange={(related) => set("color", { related })} />
            <ColorField label="태그 선" value={color.tagLine} fallback="var(--graph-tag-line-default)" onChange={(tagLine) => set("color", { tagLine })} />
            <ColorField label="가리킬 때 강조" value={color.highlight} fallback="var(--graph-highlight-default)" onChange={(highlight) => set("color", { highlight })} />
          </>,
        )}
        {section(
          "display",
          "표시",
          <>
            <Slider label="점 크기" value={display.nodeScale} range={GRAPH_RANGES.nodeScale} format={(value) => `${value.toFixed(1)}배`} onChange={(nodeScale) => set("display", { nodeScale })} />
            <Slider label="관련 선 두께" value={display.relatedWidth} range={GRAPH_RANGES.relatedWidth} format={(value) => value.toFixed(1)} onChange={(relatedWidth) => set("display", { relatedWidth })} />
            <Slider label="태그 선 두께" value={display.tagWidth} range={GRAPH_RANGES.tagWidth} format={(value) => value.toFixed(1)} onChange={(tagWidth) => set("display", { tagWidth })} />
            <Switch label="관련 선에 방향 화살표" checked={display.arrows} onChange={(arrows) => set("display", { arrows })} />
            <Slider label="글자 보이는 확대" value={display.textFade} range={GRAPH_RANGES.textFade} format={(value) => (value ? `${Math.round(value * 100)}%부터` : "항상")} onChange={(textFade) => set("display", { textFade })} />
            <Slider label="글자 크기" value={display.labelSize} range={GRAPH_RANGES.labelSize} format={(value) => `${value}px`} onChange={(labelSize) => set("display", { labelSize })} />
          </>,
        )}
        {section(
          "force",
          "힘",
          <>
            <Slider label="중심 힘" value={force.center} range={GRAPH_RANGES.center} format={(value) => value.toFixed(2)} onChange={(center) => set("force", { center })} />
            <Slider label="밀어내는 힘" value={force.repel} range={GRAPH_RANGES.repel} format={(value) => String(value)} onChange={(repel) => set("force", { repel })} />
            <Slider label="관련 선 힘" value={force.relatedStrength} range={GRAPH_RANGES.relatedStrength} format={(value) => value.toFixed(2)} onChange={(relatedStrength) => set("force", { relatedStrength })} />
            <Slider label="관련 선 길이" value={force.relatedDistance} range={GRAPH_RANGES.relatedDistance} format={(value) => String(value)} onChange={(relatedDistance) => set("force", { relatedDistance })} />
            <Slider label="태그 선 힘" value={force.tagStrength} range={GRAPH_RANGES.tagStrength} format={(value) => value.toFixed(2)} onChange={(tagStrength) => set("force", { tagStrength })} />
            <Slider label="태그 선 길이" value={force.tagDistance} range={GRAPH_RANGES.tagDistance} format={(value) => String(value)} onChange={(tagDistance) => set("force", { tagDistance })} />
            <Switch label="끌어 놓은 점 고정" checked={force.pin} onChange={(pin) => set("force", { pin })} />
            <button type="button" className="button small graph-unpin" disabled={!pinned} onClick={onUnpinAll}>
              고정 모두 풀기{pinned ? ` (${pinned})` : ""}
            </button>
          </>,
        )}
      </div>
    </aside>
  );
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={`check-row switch-row graph-switch${disabled ? " disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function Slider({ label, value, range, format, onChange }: { label: string; value: number; range: readonly [number, number, number]; format: (value: number) => string; onChange: (value: number) => void }) {
  const [min, max, step] = range;
  const decimals = (String(step).split(".")[1] ?? "").length;
  return (
    <label className="graph-slider">
      <span className="graph-slider-label">{label}</span>
      <span className="graph-slider-value">{format(value)}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(Number(event.target.value).toFixed(decimals)))} />
    </label>
  );
}

/** The palette as round swatches, "기본" (the theme's colour) first. */
function Swatches({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (value: string | null) => void }) {
  return (
    <div className="graph-swatches" role="radiogroup" aria-label={`${label} 색`}>
      <button type="button" role="radio" aria-checked={value === null} aria-label="기본 색" title="기본 색(테마)" className={`graph-swatch default${value === null ? " on" : ""}`} style={{ background: fallback }} onClick={() => onChange(null)} />
      {GRAPH_SWATCHES.map((swatch) => (
        <button key={swatch} type="button" role="radio" aria-checked={value === swatch} aria-label={swatch} title={swatch} className={`graph-swatch${value === swatch ? " on" : ""}`} style={{ background: swatch }} onClick={() => onChange(swatch)} />
      ))}
    </div>
  );
}

/**
 * A colour as in "단계 이름·색": a swatch row and a #rrggbb field (no native colour picker, which
 * WebKitGTK may not offer). The field applies once six digits are typed; empty is "기본".
 */
function ColorField({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (value: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <div className="graph-color">
      <div className="graph-color-head">
        <span>{label}</span>
        <input
          className="graph-hex"
          value={draft}
          placeholder="기본"
          aria-label={`${label} 색 값`}
          spellCheck={false}
          maxLength={7}
          onChange={(event) => {
            const text = event.target.value.trim();
            if (!/^#?[0-9a-fA-F]{0,6}$/.test(text)) return;
            setDraft(text);
            if (!text) onChange(null);
            else if (/^#?[0-9a-fA-F]{6}$/.test(text)) onChange(`#${text.replace(/^#/, "").toLowerCase()}`);
          }}
          onBlur={() => setDraft(value ?? "")}
        />
      </div>
      <Swatches label={label} value={value} fallback={fallback} onChange={onChange} />
    </div>
  );
}
