import type { EngineCommand } from "@workbench/contracts";
import "../styles/slash.css";

/** What "/" offers: the engine's commands and skills, and how to ask for them when first needed. */
export type ComposerSlash = { items: EngineCommand[] | null; onOpen: () => void };

/** The word being typed after a "/" that starts the request (null when there is none). */
export function slashQuery(text: string, caret: number) {
  return /^\/([^\s/]*)$/.exec(text.slice(0, caret))?.[1] ?? null;
}

/** Matching entries: names that start with the query first, then the user's own skills. */
export function rankCommands(items: EngineCommand[], query: string) {
  const q = query.toLowerCase();
  return items
    .filter((item) => !q || item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) ||
        Number(b.kind === "skill") - Number(a.kind === "skill") ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 12);
}

export function SlashList({ rows, loading, active, onPick }: { rows: EngineCommand[]; loading: boolean; active: number; onPick: (item: EngineCommand) => void }) {
  return (
    <div className="mention-list slash-list" role="listbox" aria-label="명령·스킬">
      <div className="menu-label">명령·스킬 · Enter로 고르기</div>
      {loading ? <div className="slash-empty">불러오는 중…</div> : null}
      {!loading && !rows.length ? <div className="slash-empty">맞는 명령이나 스킬이 없습니다</div> : null}
      {rows.map((item, index) => (
        <button
          key={`${item.kind}:${item.name}`}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`mention-row slash-row${index === active ? " active" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(item);
          }}
          title={item.description}
        >
          <span className="slash-name">/{item.name}</span>
          {item.hint ? <span className="slash-hint">{item.hint}</span> : null}
          <span className="slash-desc">{item.description}</span>
          <span className={`slash-kind ${item.kind}`}>{item.kind === "skill" ? "스킬" : "명령"}</span>
        </button>
      ))}
    </div>
  );
}
