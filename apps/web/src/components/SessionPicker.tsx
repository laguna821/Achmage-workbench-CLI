import { useEffect, useMemo, useRef, useState } from "react";
import { PROVIDER_LABEL, type Provider, type Session } from "@workbench/contracts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { statusText } from "../format.ts";
import { isBusy, type State } from "../state.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

/**
 * "어느 세션에 보낼까요?" (mockup 02): find the receiving session by name, work, engine or host.
 * Sessions of this work come first; other works' sessions are searchable too.
 */
export function SessionPicker({
  state,
  workId,
  excludeSessionId,
  onPick,
  onNew,
  onClose,
}: {
  state: State;
  workId: string;
  excludeSessionId: string | null;
  onPick: (session: Session) => void;
  onNew: (provider: Provider) => void;
  onClose: () => void;
}) {
  const { lookOf } = useAppearance();
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const sessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return Object.values(state.sessions)
      .filter((session) => session.id !== excludeSessionId)
      .filter((session) => {
        if (!needle) return session.workId === workId || Object.values(state.sessions).length < 12;
        const work = state.works[session.workId];
        return [session.purpose, work?.title, PROVIDER_LABEL[session.provider], state.hostLabel].some((text) => text?.toLowerCase().includes(needle));
      })
      .sort((a, b) => Number(b.workId === workId) - Number(a.workId === workId) || b.updatedAt - a.updatedAt)
      .slice(0, 30);
  }, [state, query, workId, excludeSessionId]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setFocus(0), [query]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="session-picker"
        role="dialog"
        aria-label="어느 세션에 보낼까요?"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") {
            event.preventDefault();
            setFocus((value) => Math.min(value + 1, sessions.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setFocus((value) => Math.max(value - 1, 0));
          } else if (event.key === "Enter" && sessions[focus] && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onPick(sessions[focus]);
          }
        }}
      >
        <h2>어느 세션에 보낼까요?</h2>
        <label className="search-field">
          <Icon name="search" size={17} />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름이나 작업으로 찾기" />
        </label>
        <div className="picker-list">
          {sessions.map((session, index) => {
            const work = state.works[session.workId];
            return (
              <button
                key={session.id}
                type="button"
                className={`picker-row${index === focus ? " focused" : ""}`}
                style={accentStyle(lookOf(session.provider))}
                onClick={() => onPick(session)}
                onMouseEnter={() => setFocus(index)}
              >
                <span className="picker-title">
                  <EngineMark provider={session.provider} size={15} /> {session.purpose}
                </span>
                <span className="picker-meta">
                  {PROVIDER_LABEL[session.provider]} · {state.hostLabel} · {isBusy(session) ? statusText(session) : "대기 중"}
                  {session.workId !== workId && work ? ` · ${work.title}` : ""}
                </span>
              </button>
            );
          })}
          {!sessions.length ? <div className="picker-empty">맞는 세션이 없습니다.</div> : null}
        </div>
        <div className="picker-foot">
          <span className="muted">다른 작업의 세션도 찾을 수 있습니다.</span>
          <span className="picker-new">
            {(["claude", "codex"] as const).map((provider) => (
              <button key={provider} type="button" className="text-button" style={accentStyle(lookOf(provider))} onClick={() => onNew(provider)}>
                <EngineMark provider={provider} size={14} /> 새 {PROVIDER_LABEL[provider]} 세션에
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
