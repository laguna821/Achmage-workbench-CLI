import { useContext } from "react";
import type { Provider } from "@workbench/contracts";
import { AppearanceContext, engineMarkStyle } from "../appearance.ts";

// Own simple marks (not the vendors' logos): a filled spark for Claude, an outlined
// hexagon with a prompt for Codex, an outlined four-point star with a centre dot for Gemini. Shape alone already tells them apart; `data-provider` gives
// each its engine color (styles.css "Engine identity"). Skin 2 (S9): this mark is the ONE place an
// engine's colour is drawn; a colour the person gave the engine in 외형 reaches it as `--engine-own`.

const SPARK = (() => {
  const points: string[] = [];
  const rays = 10;
  for (let index = 0; index < rays * 2; index += 1) {
    const angle = (Math.PI * index) / rays - Math.PI / 2;
    const radius = index % 2 === 0 ? 11 : 3.2;
    points.push(`${(12 + radius * Math.cos(angle)).toFixed(2)},${(12 + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
})();

export function EngineMark({ provider, size = 16, className }: { provider: Provider; size?: number; className?: string }) {
  const appearance = useContext(AppearanceContext);
  const style = engineMarkStyle(appearance?.lookOf(provider));
  if (provider === "claude") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`engine-mark ${className ?? ""}`} data-provider={provider} style={style} aria-hidden>
        <path d={SPARK} fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth={0.8} />
      </svg>
    );
  }
  if (provider === "gemini") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinejoin="round" className={`engine-mark ${className ?? ""}`} data-provider={provider} style={style} aria-hidden>
        <path d="M12 2.8l2.3 6.9 6.9 2.3-6.9 2.3-2.3 6.9-2.3-6.9-6.9-2.3 6.9-2.3z" />
        <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`engine-mark ${className ?? ""}`}
      data-provider={provider}
      style={style}
      aria-hidden
    >
      <path d="M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z" />
      <path d="M8.4 9.6l2.6 2.4-2.6 2.4M12.8 14.6h3" />
    </svg>
  );
}
