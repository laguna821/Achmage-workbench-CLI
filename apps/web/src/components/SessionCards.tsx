import { createContext, useContext } from "react";
import { PROVIDER_LABEL, type Session } from "@workbench/contracts";
import { lookStyle, useAppearance } from "../appearance.ts";
import { ago, statusText, statusTone } from "../format.ts";
import { folderPath, isBusy, type State } from "../state.ts";
import { EngineMark } from "./EngineMark.tsx";

// Session cards (the Ctrl+Tab switcher) and which sessions have replies the user has not seen.
// Each card wears its engine's look, so Claude and Codex read apart before any text is read.

/** Sessions with a reply the user has not looked at yet. */
export const UnseenContext = createContext<Set<string>>(new Set());
export const useUnseen = () => useContext(UnseenContext);

export function SessionCard({
  state,
  session,
  unseen,
  compact,
  focused,
  onOpen,
}: {
  state: State;
  session: Session;
  unseen: boolean;
  compact?: boolean;
  focused?: boolean;
  onOpen: () => void;
}) {
  const { appearance, themeOf } = useAppearance();
  const theme = themeOf(session.provider);
  const look = appearance[session.provider][theme];
  const work = state.works[session.workId];
  const tone = statusTone(session);
  const path = work ? folderPath(state, work.folderId).map((folder) => folder.name) : [];
  const busy = isBusy(session) && session.status !== "awaitingApproval";
  const showPurpose = work && session.purpose !== work.title;
  return (
    <button
      type="button"
      className={`session-card look-scope${compact ? " compact" : ""}${focused ? " focused" : ""}`}
      data-theme={theme}
      data-bubble={look.bubble}
      data-frame={look.frame ? "on" : "off"}
      style={lookStyle(look)}
      onClick={onOpen}
      data-tone={tone}
    >
      <span className="session-card-head">
        <EngineMark provider={session.provider} size={15} />
        <span className="session-card-engine">{PROVIDER_LABEL[session.provider]}</span>
        {session.engineModel ? <span className="session-card-model">{session.engineModel}</span> : null}
        <span className={`session-card-status tone-${tone}`}>
          {busy ? <span className="spinner small" /> : <span className={`dot dot-${tone}`} />}
          {statusText(session)}
        </span>
      </span>
      <span className="session-card-title">{work?.title ?? session.purpose}</span>
      {showPurpose ? <span className="session-card-purpose">{session.purpose}</span> : null}
      {!compact ? (
        <span className="session-card-preview">
          {busy ? (session.activity ?? "응답 중") : session.preview ?? (session.lastError ? `오류: ${session.lastError}` : "아직 답이 없습니다")}
        </span>
      ) : null}
      <span className="session-card-foot">
        {unseen ? <span className="session-card-new">새 답</span> : null}
        <span>{ago(session.previewAt ?? session.updatedAt)}</span>
        {path.length ? <span className="session-card-path">{path.join(" / ")}</span> : null}
      </span>
    </button>
  );
}

/** Ctrl+Tab: recent sessions in use order; release Ctrl to open the highlighted one. */
export function Switcher({ state, sessions, index, unseen }: { state: State; sessions: Session[]; index: number; unseen: Set<string> }) {
  return (
    <div className="switcher-backdrop">
      <div className="switcher" role="listbox" aria-label="최근 세션">
        {sessions.map((session, position) => (
          <SessionCard key={session.id} state={state} session={session} unseen={unseen.has(session.id)} compact focused={position === index} onOpen={() => undefined} />
        ))}
      </div>
      <div className="switcher-hint">Ctrl을 누른 채 Tab으로 고르고, 놓으면 엽니다</div>
    </div>
  );
}
