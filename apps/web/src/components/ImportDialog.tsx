import { useEffect, useRef, useState } from "react";
import { PROVIDER_LABEL, type ImportCandidate, type Provider, type Session } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ago } from "../format.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import "../styles/imports.css";

const folderName = (path: string | null) => (path ? (path.split("/").filter(Boolean).pop() ?? path) : "폴더 모름");

/**
 * "다른 곳의 대화 가져오기": conversations Claude Code and Codex keep on this computer (made in a
 * terminal, an IDE or another app), continued here as a session of the work of their folder.
 */
export function ImportDialog({ api, onClose, onOpen, onError }: { api: Api; onClose: () => void; onOpen: (session: Session) => void; onError: (error: unknown) => void }) {
  const [provider, setProvider] = useState<Provider>("claude");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ImportCandidate[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    let live = true;
    setList(null);
    setFailed(null);
    const timer = setTimeout(() => {
      api
        .importCandidates(provider, query)
        .then((found) => live && (setList(found), setFocus(0)))
        .catch((error: unknown) => live && setFailed(error instanceof Error ? error.message : String(error)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, provider, query]);

  const take = async (entry: ImportCandidate) => {
    if (busy) return;
    setBusy(entry.nativeSessionId);
    try {
      onOpen(await api.importSession({ provider: entry.provider, nativeSessionId: entry.nativeSessionId }));
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const rows = list ?? [];
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="session-picker import-dialog"
        role="dialog"
        aria-label="다른 곳의 대화 가져오기"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setFocus((value) => Math.min(value + 1, rows.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setFocus((value) => Math.max(value - 1, 0));
          } else if (event.key === "Enter" && rows[focus] && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void take(rows[focus]);
          }
        }}
      >
        <h2>다른 곳의 대화 가져오기</h2>
        <p className="muted import-note">터미널이나 다른 앱에서 하던 대화를 여기서 이어 씁니다. 지난 내용이 보이고, 다음 요청은 같은 대화로 이어집니다.</p>
        <div className="import-tabs" role="tablist">
          {(["claude", "codex"] as const).map((entry) => (
            <button key={entry} type="button" role="tab" aria-selected={provider === entry} className={`import-tab${provider === entry ? " active" : ""}`} onClick={() => setProvider(entry)}>
              <EngineMark provider={entry} size={14} /> {entry === "claude" ? "Claude Code" : PROVIDER_LABEL[entry]}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Icon name="search" size={17} />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목이나 폴더로 찾기" />
        </label>
        <div className="picker-list" role="listbox" aria-label="가져올 대화">
          {failed ? <div className="picker-empty">목록을 읽지 못했습니다: {failed}</div> : null}
          {!failed && list === null ? <div className="picker-empty">찾는 중…</div> : null}
          {!failed && list && !rows.length ? <div className="picker-empty">{query ? "맞는 대화가 없습니다." : "이 컴퓨터에 남은 대화가 없습니다."}</div> : null}
          {rows.map((entry, index) => (
            <button
              key={entry.nativeSessionId}
              type="button"
              role="option"
              aria-selected={index === focus}
              className={`picker-row import-row${index === focus ? " focused" : ""}`}
              onClick={() => void take(entry)}
              onMouseEnter={() => setFocus(index)}
              disabled={Boolean(busy)}
            >
              <span className="picker-title">{entry.title}</span>
              <span className="picker-meta" title={entry.cwd ?? undefined}>
                <Icon name="folder" size={12} /> {folderName(entry.cwd)} · {ago(entry.updatedAt)}
                {entry.sessionId ? <span className="import-here"> · 이미 가져옴(열기)</span> : null}
                {busy === entry.nativeSessionId ? " · 가져오는 중…" : null}
              </span>
            </button>
          ))}
        </div>
        <div className="picker-foot">
          <span className="muted">Enter 가져오기 · Esc 닫기</span>
        </div>
      </div>
    </div>
  );
}
