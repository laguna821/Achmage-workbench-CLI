import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PROVIDER_LABEL, type Session, type Work } from "@workbench/contracts";
import { lookStyle, useAppearance } from "../appearance.ts";
import { ago, statusText, statusTone } from "../format.ts";
import { folderPath, isBusy, type State } from "../state.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

// "한눈에": every session of every work as cards, by what they need from you, not by tab order.
// Each card wears its engine's look, so Claude and Codex read apart before any text is read.

/** Sessions with a reply the user has not looked at yet. */
export const UnseenContext = createContext<Set<string>>(new Set());
export const useUnseen = () => useContext(UnseenContext);

type Lane = { key: string; title: string; empty: string; sessions: Session[] };

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

export function Overview({
  state,
  unseen,
  workFilter,
  onOpen,
  onClose,
}: {
  state: State;
  unseen: Set<string>;
  /** Show only one work's sessions (from a tab overflow "+N"). */
  workFilter: Work | null;
  onOpen: (session: Session) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  const lanes = useMemo<Lane[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (session: Session) => {
      if (workFilter && session.workId !== workFilter.id) return false;
      if (!needle) return true;
      const work = state.works[session.workId];
      return [work?.title, session.purpose, session.preview, PROVIDER_LABEL[session.provider]].some((text) => text?.toLowerCase().includes(needle));
    };
    const recent = (a: Session, b: Session) => (b.previewAt ?? b.updatedAt) - (a.previewAt ?? a.updatedAt);
    const all = Object.values(state.sessions).filter(matches);
    return [
      { key: "attention", title: "내 확인이 필요해요", empty: "확인할 것이 없습니다", sessions: all.filter((session) => session.status === "awaitingApproval").sort(recent) },
      { key: "active", title: "진행 중", empty: "진행 중인 세션이 없습니다", sessions: all.filter((session) => isBusy(session) && session.status !== "awaitingApproval").sort(recent) },
      {
        key: "recent",
        title: "최근",
        empty: "아직 세션이 없습니다",
        sessions: all
          .filter((session) => !isBusy(session))
          .sort((a, b) => Number(unseen.has(b.id)) - Number(unseen.has(a.id)) || recent(a, b))
          .slice(0, 40),
      },
    ];
  }, [state, query, unseen, workFilter]);

  const flat = lanes.flatMap((lane) => lane.sessions);

  useEffect(() => {
    search.current?.focus();
  }, []);

  useEffect(() => {
    setFocus((value) => Math.min(value, Math.max(flat.length - 1, 0)));
  }, [flat.length]);

  return (
    <main
      className="overview-view"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          event.preventDefault();
          setFocus((value) => Math.min(value + 1, flat.length - 1));
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          event.preventDefault();
          setFocus((value) => Math.max(value - 1, 0));
        } else if (event.key === "Enter" && flat[focus]) {
          event.preventDefault();
          onOpen(flat[focus]);
        }
      }}
    >
      <div className="overview-inner">
        <div className="overview-head">
          <h1 className="page-title">{workFilter ? workFilter.title : "한눈에"}</h1>
          <label className="search-field overview-search">
            <Icon name="search" size={18} />
            <input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="작업, 세션, 답 내용 찾기 · ↑↓ 이동 · Enter 열기" />
          </label>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기" title="닫기 (Esc)">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="overview-lanes">
          {lanes.map((lane) => (
            <section key={lane.key} className={`overview-lane lane-${lane.key}`}>
              <h2>
                {lane.title}
                <span className="overview-count">{lane.sessions.length}</span>
              </h2>
              {lane.sessions.length ? (
                lane.sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    state={state}
                    session={session}
                    unseen={unseen.has(session.id)}
                    focused={flat[focus]?.id === session.id}
                    onOpen={() => onOpen(session)}
                  />
                ))
              ) : (
                <div className="overview-empty">{lane.empty}</div>
              )}
            </section>
          ))}
        </div>
      </div>
    </main>
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
