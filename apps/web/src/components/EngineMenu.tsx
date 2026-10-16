import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PROVIDER_LABEL, type Provider } from "@workbench/contracts";
import { ACCENT_SWATCHES, BG_SWATCHES, accentStyle, useAppearance, type Bubble } from "../appearance.ts";
import { EngineMark } from "./EngineMark.tsx";

const BUBBLES: { id: Bubble; label: string }[] = [
  { id: "filled", label: "채움" },
  { id: "soft", label: "옅게" },
  { id: "rail", label: "레일" },
];

const THEME_LABEL = { light: "라이트", dark: "다크" } as const;

/** Right-click menu: quick changes to one engine's current look, like Orca's per-pane colors. */
export function EngineMenu({ provider, x, y, onClose }: { provider: Provider; x: number; y: number; onClose: () => void }) {
  const { lookOf, themeOf, updateLook, resetLook, openSettings } = useAppearance();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const theme = themeOf(provider);
  const look = lookOf(provider);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const swatch = (color: string, active: boolean, onPick: () => void, label: string) => (
    <button key={color} type="button" className={`swatch${active ? " active" : ""}`} style={{ background: color }} onClick={onPick} title={label} aria-label={label} />
  );

  return (
    <div ref={ref} className="engine-menu popover" role="menu" style={{ ...position, ...accentStyle(look) }} onContextMenu={(event) => event.preventDefault()}>
      <div className="engine-menu-head">
        <EngineMark provider={provider} size={16} />
        {PROVIDER_LABEL[provider]} · {THEME_LABEL[theme]} 외형
      </div>

      <div className="menu-label">엔진 색</div>
      <div className="swatch-row">
        {ACCENT_SWATCHES[theme].map((color) =>
          swatch(color, look.palette.accent === color, () => updateLook(provider, theme, { palette: { accent: color } }), color),
        )}
        <label className="swatch custom" title="직접 고르기">
          <input type="color" value={look.palette.accent} onChange={(event) => updateLook(provider, theme, { palette: { accent: event.target.value } })} />
        </label>
      </div>

      <div className="menu-label">화면 배경</div>
      <div className="swatch-row">
        {BG_SWATCHES[theme].map((color) => swatch(color, look.palette.bg === color, () => updateLook(provider, theme, { palette: { bg: color } }), color))}
        <label className="swatch custom" title="직접 고르기">
          <input type="color" value={look.palette.bg} onChange={(event) => updateLook(provider, theme, { palette: { bg: event.target.value } })} />
        </label>
      </div>

      <div className="engine-menu-row">
        <span>글자 크기</span>
        <div className="stepper">
          <button type="button" onClick={() => updateLook(provider, theme, { fontSize: Math.max(12, look.fontSize - 1) })} aria-label="작게">
            −
          </button>
          <span>{look.fontSize}</span>
          <button type="button" onClick={() => updateLook(provider, theme, { fontSize: Math.min(24, look.fontSize + 1) })} aria-label="크게">
            +
          </button>
        </div>
      </div>

      <div className="engine-menu-row">
        <span>말풍선</span>
        <div className="segmented small">
          {BUBBLES.map((bubble) => (
            <button key={bubble.id} type="button" className={look.bubble === bubble.id ? "active" : ""} onClick={() => updateLook(provider, theme, { bubble: bubble.id })}>
              {bubble.label}
            </button>
          ))}
        </div>
      </div>

      <div className="menu-divider" />
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          openSettings(provider, theme);
          onClose();
        }}
      >
        <span className="menu-item-label">외형 설정 열기…</span>
      </button>
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          resetLook(provider, theme);
          onClose();
        }}
      >
        <span className="menu-item-label">
          {PROVIDER_LABEL[provider]} {THEME_LABEL[theme]} 기본값으로
        </span>
      </button>
    </div>
  );
}
