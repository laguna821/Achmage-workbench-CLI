import { WINDOW_KEYS_PREFS, type WindowKeysPref } from "./WindowKeys.tsx";
import { useId, useMemo, useState } from "react";
import { PROVIDER_LABEL, type Provider } from "@workbench/contracts";
import {
  FONT_PRESETS,
  PALETTE_FIELDS,
  fontAvailable,
  fontStack,
  useAppearance,
  type Bubble,
  type EngineMode,
  type Glow,
  type Look,
  ENGINE_COLOR_HINT,
} from "../appearance.ts";
import { PALETTE_SETS, type PaletteChoice, type PaletteSet, type Theme, type ThemePref, type UsagePlace } from "../theme.ts";
import { DEFAULT_SET, WORKBENCH_SET } from "../styles/atlas-sets.ts";
import { Icon } from "./Icon.tsx";
import { Select } from "./ui/Select.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./SettingsSheet.tsx";
import { Segmented } from "./ui/Hig.tsx";

// 설정 › 화면 (release unit B): the app's look first (시스템 따라 / 밝게 / 어둡게), then how a
// conversation reads — face, size, spacing — for the engine and mode chosen above the preview.
// The per-engine colour is only "엔진 표시 색"; every other colour waits behind "색 직접 고르기".
// The stored looks (v6, v7, v8 …) are read and written by appearance.ts as before: nothing here
// resets a value the person chose.

const BUBBLES: { id: Bubble; label: string }[] = [
  { id: "filled", label: "채움" },
  { id: "soft", label: "옅게" },
  { id: "rail", label: "줄" },
];
const GLOWS: { id: Glow; label: string }[] = [
  { id: "off", label: "끄기" },
  { id: "soft", label: "은은하게" },
  { id: "neon", label: "강하게" },
];
const MODES: { id: EngineMode; label: string }[] = [
  { id: "follow", label: "앱 따라" },
  { id: "light", label: "늘 밝게" },
  { id: "dark", label: "늘 어둡게" },
];
export const THEME_PREFS: { id: ThemePref; label: string }[] = [
  { id: "system", label: "시스템 따라" },
  { id: "light", label: "밝게" },
  { id: "dark", label: "어둡게" },
];
/** The first run's two keys: the default pair (Atlas Light and Graphite) and Workbench; every set is in 설정 › 화면. */
export const PALETTES: { id: string; label: string; choice: PaletteChoice }[] = [
  { id: "atlas", label: "Atlas (기본)", choice: { ...DEFAULT_SET } },
  { id: "workbench", label: "Workbench", choice: { light: WORKBENCH_SET, dark: WORKBENCH_SET } },
];
/** The one quiet line that says where the colour sets come from. */
export const PALETTE_CREDIT = "색 조합은 Atlas File Manager의 것을 따랐습니다. Dracula, Nord, Rosé Pine은 각 프로젝트의 색입니다.";
const SET_GROUPS: { mode: Theme; label: string }[] = [{ mode: "light", label: "밝은 색" }, { mode: "dark", label: "어두운 색" }];

/**
 * 색 조합: the sets of one mode as swatches (name; ground, rail, accent and ink as chips; the chosen one marked).
 * A radio group: Tab reaches the chosen swatch, the arrows (Home, End) move to another and choose it.
 */
function SetSwatches({ mode, label, value, onPick }: { mode: Theme; label: string; value: string; onPick: (set: PaletteSet) => void }) {
  const id = useId(), sets = PALETTE_SETS[mode];
  const chosen = sets.findIndex((set) => set.id === value);
  return <div className="palette-group">
    <p className="palette-group-head" id={`${id}-head`}>{label}</p>
    <div className="palette-swatches" role="radiogroup" aria-labelledby={`${id}-head`} onKeyDown={(event) => {
      const step = event.key === "Home" || ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : event.key === "End" || ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = ((event.key === "Home" ? -1 : event.key === "End" ? sets.length : Math.max(0, chosen)) + step + sets.length) % sets.length;
      if (next === chosen) return;
      onPick(sets[next]!);
      document.getElementById(`${id}-${next}`)?.focus();
    }}>
      {sets.map((set, at) => <button key={set.id} id={`${id}-${at}`} type="button" role="radio" aria-checked={set.id === value} tabIndex={at === Math.max(0, chosen) ? 0 : -1}
        className={`palette-swatch${set.id === value ? " chosen" : ""}`} onClick={() => onPick(set)}>
        <span className="palette-chips" data-set-chips={set.id === WORKBENCH_SET ? `${WORKBENCH_SET}-${mode}` : set.id} aria-hidden><i /><i /><i /><i /></span>
        <span className="palette-swatch-name">{set.name}{set.id === DEFAULT_SET[mode] ? <span className="palette-swatch-note"> (기본)</span> : null}</span>
        {set.id === value ? <Icon name="check" size={14} /> : null}
      </button>)}
    </div>
  </div>;
}
const MODE_WORD: Record<Theme, string> = { light: "밝을 때", dark: "어두울 때" };
/** "빛 궤적 보조색" was a developer's name for the working mark's second colour. */
const FIELD_LABEL: Partial<Record<keyof Look["palette"], string>> = { motion: "작업 표시 보조색", surface: "입력창과 카드", headingAlt: "작은 제목과 기울임" };

export type SheetTarget = { provider: Provider; theme: Theme };

/** The look in the new shell's shapes: the navy rail, the white list column, the work with a turn. */
function ShellPreview({ provider, look, theme }: { provider: Provider; look: Look; theme: Theme }) {
  const { palette } = look;
  return <div className="look-preview" data-theme={theme} aria-label={`${PROVIDER_LABEL[provider]} ${MODE_WORD[theme]} 미리 보기`} role="img">
    <span className="look-preview-rail" aria-hidden><i /><i /><i /></span>
    <span className="look-preview-list" aria-hidden><i className="current" /><i /><i /><i /></span>
    <span className="look-preview-work" style={{ background: palette.bg, color: palette.text, fontFamily: fontStack(look.font) }}>
      <span className="look-preview-head" style={{ color: palette.heading }}><EngineMark provider={provider} size={14} />3주차 강의안 다듬기</span>
      <span className={`look-preview-ask bubble-${look.bubble}`} style={{ ...(look.bubble === "rail" ? { borderWidth: `0 0 0 ${look.borderWidth + 1}px`, borderColor: palette.muted } : { borderRadius: look.radius, borderWidth: look.borderWidth, borderColor: palette.line }), background: look.bubble === "filled" ? palette.surface : "transparent", color: palette.text, fontSize: Math.max(12, look.fontSize - 2) }}>도입부를 질문으로 시작해 줘</span>
      <span className="look-preview-answer" style={{ fontSize: look.fontSize, lineHeight: look.lineHeight, fontWeight: look.fontWeight }}>도입부를 질문 하나로 바꿨습니다. <b style={{ color: palette.strong }}>평가 기준</b>은 그대로 두었습니다. <u style={{ color: palette.link }}>강의안.md</u></span>
    </span>
  </div>;
}

const USAGE_PLACES: { id: UsagePlace; label: string }[] = [
  { id: "list", label: "목록 칸 아래" },
  { id: "bottom", label: "창 아래 줄" },
  { id: "hidden", label: "숨기기" },
];

/** 글꼴: the app's UI face — three choices only (no font list is read from the system). */
const UI_FONTS: { id: "pretendard" | "system" | "custom"; label: string }[] = [
  { id: "pretendard", label: "Pretendard (기본)" },
  { id: "system", label: "시스템 글꼴" },
  { id: "custom", label: "직접 입력" },
];

function UiFontRow({ value, onChange }: { value: string; onChange: (font: string) => void }) {
  const choice = value === "system" ? "system" : value.startsWith("custom:") ? "custom" : "pretendard";
  const [family, setFamily] = useState(value.startsWith("custom:") ? value.slice(7) : "");
  const missing = choice === "custom" && family.trim() !== "" && !fontAvailable(family.trim());
  return <SettingsRow label="글꼴" hint="메뉴, 목록, 버튼에 쓰는 글꼴입니다. 대화를 읽는 글꼴은 아래 대화 글자에서 고릅니다."
    control={<Segmented label="글꼴" value={choice} onChange={(next) => onChange(next === "custom" ? `custom:${family.trim() || "Pretendard"}` : next)} options={UI_FONTS.map(({ id, label }) => ({ value: id, label }))} />}
    detail={choice === "custom" ? <>
      <input className="sheet-input" aria-label="글꼴 이름" value={family} placeholder="이 컴퓨터에 설치된 글꼴 이름 (예: 나눔고딕)"
        onChange={(event) => { setFamily(event.target.value); if (event.target.value.trim()) onChange(`custom:${event.target.value.trim()}`); }} />
      {missing ? <p className="settings-row-hint" role="status">이 컴퓨터에서 「{family.trim()}」 글꼴을 찾지 못해 Pretendard로 보입니다.</p> : null}
    </> : null} />;
}

export function AppearancePanel({ target, onTarget, themePref, onThemePref, palette = DEFAULT_SET, onPalette, uiFont = "pretendard", onUiFont, usagePlace = "list", onUsagePlace, memoryShown = true, onMemoryShown, windowKeys }: {
  target: SheetTarget;
  onTarget: (target: SheetTarget) => void;
  themePref: ThemePref;
  onThemePref: (pref: ThemePref) => void;
  /** The chosen light set and dark set. */
  palette?: PaletteChoice;
  /** A swatch was picked: the set (it names its mode). The app stores it for that mode and shows that mode. */
  onPalette?: (set: PaletteSet) => void;
  uiFont?: string;
  onUiFont?: (font: string) => void;
  usagePlace?: UsagePlace;
  onUsagePlace?: (place: UsagePlace) => void;
  /** 메모리 표시: the app's memory at the right end of the window's bottom line. */
  memoryShown?: boolean;
  onMemoryShown?: (shown: boolean) => void;
  /** 창 단추 (desktop app only): 자동 / 항상 / 숨김, and what this computer is. */
  windowKeys?: { value: WindowKeysPref; note: string; onChange: (next: WindowKeysPref) => void };
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
  const name = PROVIDER_LABEL[provider];

  return <div className="appearance-panel">
    <SettingsGroup title="앱 화면">
      {/* The owner's order (2026-11-15): 색 조합, 밝게 / 어둡게 / 시스템 따라, 글꼴, then the conversation's 글자 크기 and colours below. */}
      {onPalette ? <SettingsRow className="palette-row" label="색 조합" hint="고르면 그 색으로 바로 바뀝니다. 밝을 때와 어두울 때의 색을 하나씩 정해 둡니다."
        detail={<>
          {SET_GROUPS.map(({ mode, label }) => <SetSwatches key={mode} mode={mode} label={label} value={palette[mode]} onPick={onPalette} />)}
          <p className="palette-credit">{PALETTE_CREDIT}</p>
        </>} /> : null}
      <SettingsRow label="화면 모양" hint="시스템 따라는 컴퓨터의 밝게, 어둡게 설정을 따릅니다."
        control={<Segmented label="화면" className="theme-choice" value={themePref} onChange={onThemePref} options={THEME_PREFS.map(({ id, label }) => ({ value: id, label }))} />} />
      {onUiFont ? <UiFontRow value={uiFont} onChange={onUiFont} /> : null}
      {onUsagePlace ? <SettingsRow label="사용 한도 표시" hint="Claude와 Codex의 5시간, 주간 한도를 어디에 보일지 고릅니다. 창 아래 줄을 누르면 자세히 보입니다."
        control={<Segmented label="사용 한도 표시" value={usagePlace} onChange={onUsagePlace} options={USAGE_PLACES.map(({ id, label }) => ({ value: id, label }))} />} /> : null}
      {onMemoryShown ? <SettingsRow label="메모리 표시" hint="앱이 지금 쓰는 메모리를 창 오른쪽 아래에 작게 보입니다. 마우스를 올리면 창, AI 엔진과 도구, 게이트웨이로 나누어 보입니다."
        control={<Segmented label="메모리 표시" value={memoryShown ? "on" : "off"} onChange={(next) => onMemoryShown(next === "on")} options={[{ value: "on", label: "켜기" }, { value: "off", label: "끄기" }]} />} /> : null}
      {windowKeys ? <SettingsRow className="window-keys-row" label="창 단추" hint={`창 오른쪽 위의 내려놓기, 전체 화면, 닫기 단추입니다. 자동은 창에 제목 표시줄이 없을 때만 보입니다. ${windowKeys.note}`}
        control={<Segmented label="창 단추" value={windowKeys.value} onChange={windowKeys.onChange} options={WINDOW_KEYS_PREFS.map(({ id, label }) => ({ value: id, label }))} />} /> : null}
    </SettingsGroup>

    <SettingsGroup title="대화 글자">
      <SettingsRow label="고칠 대화" hint="엔진마다, 밝을 때와 어두울 때가 따로 있습니다. 바꾸면 아래 미리 보기와 열린 대화에 바로 보입니다."
        control={<>
          <Segmented label="엔진" value={provider} onChange={(next) => onTarget({ provider: next, theme })} options={(["claude", "codex"] as const).map((engine) => ({ value: engine, label: PROVIDER_LABEL[engine] }))} />
          <Segmented label="밝을 때, 어두울 때" value={theme} onChange={(next) => onTarget({ provider, theme: next })} options={(["light", "dark"] as const).map((mode) => ({ value: mode, label: MODE_WORD[mode] }))} />
        </>}
        detail={<ShellPreview provider={provider} look={look} theme={theme} />} />
      <SettingsRow label="읽는 글꼴" hint="대화를 읽는 글꼴입니다. 화면의 메뉴와 버튼은 Pretendard를 씁니다."
        control={<Select className="settings-select" label="읽는 글꼴" value={custom ? "custom" : look.font}
          onChange={(value) => update({ font: value === "custom" ? `custom:${customFamily || "Pretendard"}` : value })}
          options={[...FONT_PRESETS.map((preset) => ({ value: preset.id as string, label: preset.label.replace(" · ", ", "), hint: available[preset.id] ? undefined : "설치 안 됨" })), { value: "custom", label: "직접 입력…" }]} />}
        detail={custom ? <input className="sheet-input" aria-label="글꼴 이름" value={customFamily} placeholder="글꼴 이름 (예: Pretendard)"
          onChange={(event) => { setCustomFamily(event.target.value); update({ font: `custom:${event.target.value}` }); }} /> : null} />
      <SettingsRow label="글자 크기" control={<label className="slider-row"><input type="range" aria-label="글자 크기" min={12} max={24} step={1} value={look.fontSize} onChange={(event) => update({ fontSize: Number(event.target.value) })} /><span className="slider-value">{look.fontSize}px</span></label>} />
      <SettingsRow label="줄 간격" hint="작게 하면 촘촘하게, 크게 하면 넉넉하게 읽힙니다." control={<label className="slider-row"><input type="range" aria-label="줄 간격" min={1.3} max={2.1} step={0.05} value={look.lineHeight} onChange={(event) => update({ lineHeight: Number(event.target.value) })} /><span className="slider-value">{look.lineHeight.toFixed(2)}</span></label>} />
      <SettingsRow label="글자 굵기" control={<label className="slider-row"><input type="range" aria-label="글자 굵기" min={200} max={700} step={50} value={look.fontWeight} onChange={(event) => update({ fontWeight: Number(event.target.value) })} /><span className="slider-value">{look.fontWeight}</span></label>} />
      <SettingsRow label={`${name} 대화 화면`} hint="이 엔진의 대화만 늘 밝게 또는 늘 어둡게 둘 수 있습니다."
        control={<Segmented label={`${name} 화면 모드`} value={appearance[provider].mode} onChange={value => setMode(provider, value)} options={MODES.map(({ id, label }) => ({ value: id, label }))} />} />
    </SettingsGroup>

    <SettingsGroup title="대화 모양">
      <SettingsRow label="보낸 글 모양" control={<Segmented label="메시지 모양" value={look.bubble} onChange={value => update({ bubble: value })} options={BUBBLES.map(({ id, label }) => ({ value: id, label }))} />} />
      <SettingsRow label="작업 중 표시" hint="AI가 일하는 동안 입력창 둘레에 보이는 표시의 세기입니다." control={<Segmented label="작업 표시" value={look.glow} onChange={value => update({ glow: value })} options={GLOWS.map(({ id, label }) => ({ value: id, label }))} />} />
      <SettingsRow label="모서리" control={<label className="slider-row"><input type="range" aria-label="모서리" min={4} max={26} step={1} value={look.radius} onChange={(event) => update({ radius: Number(event.target.value) })} /><span className="slider-value">{look.radius}px</span></label>} />
      <SettingsRow label="테두리 두께" control={<label className="slider-row"><input type="range" aria-label="테두리" min={1} max={3} step={0.5} value={look.borderWidth} onChange={(event) => update({ borderWidth: Number(event.target.value) })} /><span className="slider-value">{look.borderWidth}px</span></label>} />
      <SettingsRow label="쉬는 동안에도 입력창 테두리를 진하게" control={<SettingsSwitch label="쉬는 동안에도 입력창 테두리를 진하게" checked={look.frame} onChange={(next) => update({ frame: next })} />} />
    </SettingsGroup>

    <SettingsGroup title="색">
      <SettingsRow label="엔진 표시 색" hint={ENGINE_COLOR_HINT}
        mark={<EngineMark provider={provider} size={16} />}
        control={<label className="color-swatch"><input type="color" aria-label={`${name} 엔진 표시 색`} value={look.palette.accent} onChange={(event) => update({ palette: { accent: event.target.value } })} /></label>}
        detail={<details className="settings-path color-more">
          <summary>색 직접 고르기</summary>
          <div className="color-list">
            {PALETTE_FIELDS.map((field) => (
              <label key={field.key} className="color-row">
                <input type="color" value={look.palette[field.key]} onChange={(event) => update({ palette: { [field.key]: event.target.value } })} />
                <span>{FIELD_LABEL[field.key] ?? field.label}</span>
                <input className="hex" aria-label={`${FIELD_LABEL[field.key] ?? field.label} 색 값`} value={look.palette[field.key]}
                  onChange={(event) => /^#[0-9a-f]{6}$/i.test(event.target.value) && update({ palette: { [field.key]: event.target.value.toLowerCase() } })} spellCheck={false} />
              </label>
            ))}
          </div>
        </details>} />
      <SettingsRow label="다른 값 가져오기" hint={`${name} ${MODE_WORD[theme]}의 글자와 색을 다른 쪽의 값으로 바꾸거나 처음으로 되돌립니다.`}
        control={<>
          <button type="button" className="button small" onClick={() => update({ ...appearance[provider][other] })}>{MODE_WORD[other]} 값</button>
          <button type="button" className="button small" onClick={() => update({ ...appearance[otherEngine][theme] })}>{PROVIDER_LABEL[otherEngine]} 값</button>
          <button type="button" className="button small" onClick={() => resetLook(provider, theme)}>기본값으로</button>
        </>} />
    </SettingsGroup>
  </div>;
}

