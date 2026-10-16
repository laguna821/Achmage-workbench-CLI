import { useEffect, useMemo, useState } from "react";
import { PROVIDER_LABEL, type Provider } from "@workbench/contracts";
import {
  FONT_PRESETS,
  PALETTE_FIELDS,
  fontAvailable,
  fontStack,
  onColor,
  useAppearance,
  type Bubble,
  type EngineMode,
  type Glow,
  type Look,
} from "../appearance.ts";
import type { Theme, ThemePref } from "../theme.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

const THEME_LABEL: Record<Theme, string> = { light: "라이트", dark: "다크" };
const BUBBLES: { id: Bubble; label: string }[] = [
  { id: "filled", label: "채움" },
  { id: "soft", label: "옅게" },
  { id: "rail", label: "레일" },
];
const GLOWS: { id: Glow; label: string }[] = [
  { id: "off", label: "끄기" },
  { id: "soft", label: "은은하게" },
  { id: "neon", label: "강하게" },
];
const MODES: { id: EngineMode; label: string }[] = [
  { id: "follow", label: "앱 화면 따르기" },
  { id: "light", label: "항상 라이트" },
  { id: "dark", label: "항상 다크" },
];
const THEME_PREFS: { id: ThemePref; label: string }[] = [
  { id: "system", label: "시스템" },
  { id: "light", label: "라이트" },
  { id: "dark", label: "다크" },
];

export type SheetTarget = { provider: Provider; theme: Theme };

function LookCard({ provider, theme, look, active, onSelect }: { provider: Provider; theme: Theme; look: Look; active: boolean; onSelect: () => void }) {
  const { palette } = look;
  return (
    <button
      type="button"
      className={`look-card${active ? " active" : ""}`}
      onClick={onSelect}
      style={{ background: palette.bg, color: palette.text, borderColor: active ? palette.accent : palette.line }}
      aria-pressed={active}
    >
      <span className="look-card-head" style={{ color: palette.accent, fontFamily: fontStack(look.font) }}>
        <EngineMark provider={provider} size={14} />
        {PROVIDER_LABEL[provider]} · {THEME_LABEL[theme]}
      </span>
      <span className="look-card-bubble" style={{ background: palette.accent, color: onColor(palette.accent) }}>
        요청
      </span>
      <span className="look-card-line" style={{ background: palette.heading }} />
      <span className="look-card-line short" style={{ background: palette.muted }} />
    </button>
  );
}

export function AppearanceSheet({
  target,
  onTarget,
  themePref,
  onThemePref,
  onClose,
}: {
  target: SheetTarget;
  onTarget: (target: SheetTarget) => void;
  themePref: ThemePref;
  onThemePref: (pref: ThemePref) => void;
  onClose: () => void;
}) {
  const { appearance, updateLook, setMode, resetLook } = useAppearance();
  const { provider, theme } = target;
  const look = appearance[provider][theme];
  const other: Theme = theme === "light" ? "dark" : "light";
  const otherEngine: Provider = provider === "claude" ? "codex" : "claude";
  const custom = look.font.startsWith("custom:");
  const [customFamily, setCustomFamily] = useState(custom ? look.font.slice(7) : "");
  const available = useMemo(
    () => Object.fromEntries(FONT_PRESETS.map((preset) => [preset.id, preset.family ? fontAvailable(preset.family) : true])),
    [],
  );
  const update = (patch: Parameters<typeof updateLook>[2]) => updateLook(provider, theme, patch);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="appearance-sheet" aria-label="외형 설정">
      <div className="sheet-head">
        <h2>외형</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="sheet-body">
        <section className="sheet-section">
          <div className="sheet-label">화면</div>
          <div className="segmented">
            {THEME_PREFS.map((option) => (
              <button key={option.id} type="button" className={themePref === option.id ? "active" : ""} onClick={() => onThemePref(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
          <p className="sheet-hint">엔진마다 라이트·다크 외형이 따로 있습니다. 고른 외형이 지금 화면에 미리 보입니다.</p>
          <div className="look-grid">
            {(["claude", "codex"] as const).flatMap((engine) =>
              (["light", "dark"] as const).map((mode) => (
                <LookCard
                  key={`${engine}-${mode}`}
                  provider={engine}
                  theme={mode}
                  look={appearance[engine][mode]}
                  active={engine === provider && mode === theme}
                  onSelect={() => onTarget({ provider: engine, theme: mode })}
                />
              )),
            )}
          </div>
        </section>

        <section className="sheet-section">
          <div className="sheet-label">
            <EngineMark provider={provider} size={15} /> {PROVIDER_LABEL[provider]} 화면
          </div>
          <div className="segmented">
            {MODES.map((option) => (
              <button key={option.id} type="button" className={appearance[provider].mode === option.id ? "active" : ""} onClick={() => setMode(provider, option.id)}>
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="sheet-section">
          <div className="sheet-label">
            색 · {PROVIDER_LABEL[provider]} {THEME_LABEL[theme]}
          </div>
          <div className="color-list">
            {PALETTE_FIELDS.map((field) => (
              <label key={field.key} className="color-row">
                <input type="color" value={look.palette[field.key]} onChange={(event) => update({ palette: { [field.key]: event.target.value } })} />
                <span>{field.label}</span>
                <input
                  className="hex"
                  value={look.palette[field.key]}
                  onChange={(event) => /^#[0-9a-f]{6}$/i.test(event.target.value) && update({ palette: { [field.key]: event.target.value.toLowerCase() } })}
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="sheet-section">
          <div className="sheet-label">글자</div>
          <select
            className="sheet-select"
            value={custom ? "custom" : look.font}
            onChange={(event) => update({ font: event.target.value === "custom" ? `custom:${customFamily || "Pretendard"}` : event.target.value })}
          >
            {FONT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
                {available[preset.id] ? "" : " (설치 안 됨)"}
              </option>
            ))}
            <option value="custom">직접 입력…</option>
          </select>
          {custom ? (
            <input
              className="sheet-input"
              value={customFamily}
              placeholder="글꼴 이름 (예: Pretendard)"
              onChange={(event) => {
                setCustomFamily(event.target.value);
                update({ font: `custom:${event.target.value}` });
              }}
            />
          ) : null}
          <label className="slider-row">
            <span>크기</span>
            <input type="range" min={12} max={24} step={1} value={look.fontSize} onChange={(event) => update({ fontSize: Number(event.target.value) })} />
            <span className="slider-value">{look.fontSize}px</span>
          </label>
          <label className="slider-row">
            <span>줄 간격</span>
            <input type="range" min={1.3} max={2.1} step={0.05} value={look.lineHeight} onChange={(event) => update({ lineHeight: Number(event.target.value) })} />
            <span className="slider-value">{look.lineHeight.toFixed(2)}</span>
          </label>
          <label className="slider-row">
            <span>굵기</span>
            <input type="range" min={200} max={700} step={50} value={look.fontWeight} onChange={(event) => update({ fontWeight: Number(event.target.value) })} />
            <span className="slider-value">{look.fontWeight}</span>
          </label>
        </section>

        <section className="sheet-section">
          <div className="sheet-label">대화 · 입력창</div>
          <div className="option-row">
            <span>말풍선</span>
            <div className="segmented small">
              {BUBBLES.map((option) => (
                <button key={option.id} type="button" className={look.bubble === option.id ? "active" : ""} onClick={() => update({ bubble: option.id })}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="option-row">
            <span>빛 효과</span>
            <div className="segmented small">
              {GLOWS.map((option) => (
                <button key={option.id} type="button" className={look.glow === option.id ? "active" : ""} onClick={() => update({ glow: option.id })}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="slider-row">
            <span>모서리</span>
            <input type="range" min={4} max={26} step={1} value={look.radius} onChange={(event) => update({ radius: Number(event.target.value) })} />
            <span className="slider-value">{look.radius}px</span>
          </label>
          <label className="slider-row">
            <span>테두리</span>
            <input type="range" min={1} max={3} step={0.5} value={look.borderWidth} onChange={(event) => update({ borderWidth: Number(event.target.value) })} />
            <span className="slider-value">{look.borderWidth}px</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={look.frame} onChange={(event) => update({ frame: event.target.checked })} />
            쉬는 동안에도 입력창 테두리에 엔진 색
          </label>
        </section>

        <section className="sheet-section sheet-actions">
          <button type="button" className="button small" onClick={() => update({ ...appearance[provider][other] })}>
            {THEME_LABEL[other]} 값 가져오기
          </button>
          <button type="button" className="button small" onClick={() => update({ ...appearance[otherEngine][theme] })}>
            {PROVIDER_LABEL[otherEngine]} 값 가져오기
          </button>
          <button type="button" className="button small" onClick={() => resetLook(provider, theme)}>
            기본값으로
          </button>
        </section>
      </div>
    </aside>
  );
}
