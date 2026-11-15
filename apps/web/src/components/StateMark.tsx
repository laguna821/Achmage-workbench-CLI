import type { CSSProperties } from "react";
import type { RowStateInfo } from "../row-state.ts";
import { Icon } from "./Icon.tsx";
import "../styles/state-mark.css";
import "../styles/now-home.css";

/**
 * THE state mark (skin 2, S3): a 16 px glyph from the one icon set in the state's tone, the word
 * beside it when asked (`withWord`). Null state = a conversation that never answered: a hollow
 * ring, no word. Every surface draws a state with this (rows, tabs, 활동, 지금, home, project page).
 */
export function StateMark({ state, withWord = false, size = 16, className = "" }: { state: RowStateInfo | null; withWord?: boolean; size?: number; className?: string }) {
  const glyph = !state ? <span className="row-hollow" /> : state.glyph === "turn" ? <span className="row-turn" /> : state.glyph === "dot" ? <span className="row-new" /> : <Icon name={state.glyph} size={size} />;
  return (
    <>
      <span className={`row-glyph state-mark tone-${state?.tone ?? "idle"}${className ? ` ${className}` : ""}`} data-state={state?.id ?? "none"} aria-hidden style={{ "--mark": `${size}px` } as CSSProperties}>{glyph}</span>
      {withWord && state ? <span className={`row-state tone-${state.tone}`}>{state.word}</span> : null}
    </>
  );
}

/**
 * The glyph AND the word as one inline unit, for surfaces that set the state in running text or a
 * table cell (home 지금, the project page, the conversation head; unit D). The glyph is StateMark's.
 */
export function StateWord({ state, className }: { state: RowStateInfo | null; className?: string }) {
  if (!state) return <span className={`state-word none${className ? ` ${className}` : ""}`} />;
  return (
    <span className={`state-word tone-${state.tone}${className ? ` ${className}` : ""}`} data-state={state.id}>
      <StateMark state={state} size={14} className="state-glyph" />
      <span>{state.word}</span>
    </span>
  );
}
