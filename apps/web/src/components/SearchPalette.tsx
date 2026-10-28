import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FORMAT_LABEL, PROVIDER_LABEL, type Artifact, type Provider, type SearchResult, type Session, type Work } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { ago } from "../format.ts";
import { sessionHidden, workHidden } from "../tree.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { lookStyle, NEUTRAL_LOOK, useAppearance } from "../appearance.ts";

// Ctrl+K: one place to find anything — titles at once (on this screen), conversation and document
// text through the gateway's index (no model is asked), and commands. ↑↓ choose, Enter opens (a
// message hit opens its conversation at that message), Esc closes.

export type PaletteCommand = { id: string; label: string; icon: IconName; hint?: string; run: () => void };

type Entry =
  | { key: string; kind: "work"; work: Work }
  | { key: string; kind: "session"; session: Session }
  | { key: string; kind: "doc"; artifact: Artifact; snippet?: { snippet: string; ranges: [number, number][] } }
  | { key: string; kind: "hit"; session: Session; itemId: string; who: "user" | "assistant"; at: number; snippet: string; ranges: [number, number][] }
  | { key: string; kind: "command"; command: PaletteCommand };

/** A snippet with its matches marked. */
export function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from < at) continue;
    if (from > at) parts.push(text.slice(at, from));
    parts.push(<mark key={from}>{text.slice(from, to)}</mark>);
    at = to;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

const includes = (text: string | null | undefined, needle: string) => Boolean(text && text.toLowerCase().includes(needle));

export function SearchPalette({
  api,
  state,
  commands,
  onOpenSession,
  onOpenHit,
  onOpenWork,
  onOpenDoc,
  onClose,
}: {
  api: Api;
  state: State;
  commands: PaletteCommand[];
  onOpenSession: (session: Session) => void;
  onOpenHit: (session: Session, itemId: string) => void;
  onOpenWork: (work: Work) => void;
  onOpenDoc: (artifact: Artifact) => void;
  onClose: () => void;
}) {
  const { appTheme } = useAppearance();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [archived, setArchived] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [focus, setFocus] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const commandMode = query.startsWith(">");
  const needle = (commandMode ? query.slice(1) : query).trim().toLowerCase();

  useEffect(() => input.current?.focus(), []);

  // Conversation and document text: asked from the gateway a moment after typing stops.
  useEffect(() => {
    if (commandMode || !needle) {
      setResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .search(needle, { provider, archived })
        .then((found) => !cancelled && setResult(found))
        .catch(() => !cancelled && setResult(null))
        .finally(() => !cancelled && setSearching(false));
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, needle, provider, archived, commandMode]);

  const groups = useMemo(() => {
    const out: { label: string; entries: Entry[] }[] = [];
    if (commandMode) {
      out.push({ label: "명령", entries: commands.filter((command) => includes(command.label, needle) || !needle).map((command) => ({ key: `c:${command.id}`, kind: "command" as const, command })) });
      return out;
    }
    if (!needle) {
      // Before typing: recent conversations, then the commands.
      const recent = Object.values(state.sessions)
        .filter((session) => !sessionHidden(state, session) && (!provider || session.provider === provider))
        .sort((a, b) => (b.previewAt ?? b.updatedAt) - (a.previewAt ?? a.updatedAt))
        .slice(0, 8);
      out.push({ label: "최근 대화", entries: recent.map((session) => ({ key: `s:${session.id}`, kind: "session" as const, session })) });
      out.push({ label: "명령", entries: commands.slice(0, 6).map((command) => ({ key: `c:${command.id}`, kind: "command" as const, command })) });
      return out;
    }
    const shortcuts: Entry[] = [];
    for (const work of Object.values(state.works)) {
      if ((archived || !workHidden(state, work)) && includes(work.title, needle)) shortcuts.push({ key: `w:${work.id}`, kind: "work", work });
    }
    for (const session of Object.values(state.sessions)) {
      if ((archived || !sessionHidden(state, session)) && (!provider || session.provider === provider) && includes(session.purpose, needle)) {
        shortcuts.push({ key: `s:${session.id}`, kind: "session", session });
      }
    }
    for (const artifact of Object.values(state.artifacts)) {
      const work = state.works[artifact.workId];
      if (work && (archived || !workHidden(state, work)) && includes(artifact.name, needle)) shortcuts.push({ key: `d:${artifact.id}`, kind: "doc", artifact });
    }
    out.push({ label: "바로 가기", entries: shortcuts.slice(0, 8) });
    const hits: Entry[] = [];
    for (const group of result?.sessions ?? []) {
      const session = state.sessions[group.sessionId];
      if (!session) continue;
      for (const hit of group.hits) hits.push({ key: `h:${hit.itemId}`, kind: "hit", session, itemId: hit.itemId, who: hit.kind, at: hit.at, snippet: hit.snippet, ranges: hit.ranges });
    }
    out.push({ label: "대화 내용", entries: hits });
    const docs: Entry[] = [];
    for (const doc of result?.documents ?? []) {
      const artifact = state.artifacts[doc.artifactId];
      if (artifact) docs.push({ key: `t:${artifact.id}`, kind: "doc", artifact, snippet: { snippet: doc.snippet, ranges: doc.ranges } });
    }
    out.push({ label: "문서 내용", entries: docs });
    const matching = commands.filter((command) => includes(command.label, needle)).slice(0, 4);
    out.push({ label: "명령", entries: matching.map((command) => ({ key: `c:${command.id}`, kind: "command" as const, command })) });
    return out.filter((group) => group.entries.length);
  }, [state, commands, needle, commandMode, result, provider, archived]);

  const flat = groups.flatMap((group) => group.entries);
  useEffect(() => setFocus(0), [needle, provider, archived]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".palette-entry.focused")?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  const current = flat[Math.min(focus, flat.length - 1)];

  const open = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    if (entry.kind === "work") onOpenWork(entry.work);
    else if (entry.kind === "session") onOpenSession(entry.session);
    else if (entry.kind === "hit") onOpenHit(entry.session, entry.itemId);
    else if (entry.kind === "doc") onOpenDoc(entry.artifact);
    else entry.command.run();
  };

  const placeOf = (workId: string) => state.works[workId]?.title ?? "";

  const line = (entry: Entry) => {
    switch (entry.kind) {
      case "work":
        return (
          <>
            <Icon name="project" size={16} className="palette-icon" />
            <span className="palette-title">{entry.work.title}</span>
            <span className="palette-meta">작업{entry.work.archivedAt ? " · 보관됨" : ""}</span>
          </>
        );
      case "session":
        return (
          <>
            <EngineMark provider={entry.session.provider} size={15} className="palette-icon" />
            <span className="palette-title">{entry.session.purpose}</span>
            <span className="palette-meta">
              {placeOf(entry.session.workId)} · {ago(entry.session.previewAt ?? entry.session.updatedAt)}
            </span>
          </>
        );
      case "doc":
        return (
          <>
            <Icon name="file" size={16} className="palette-icon" />
            <span className="palette-title">{entry.artifact.name}</span>
            <span className="palette-meta">
              r{entry.artifact.revision} · {placeOf(entry.artifact.workId)}
            </span>
            {entry.snippet ? (
              <span className="palette-snippet">
                <Marked text={entry.snippet.snippet} ranges={entry.snippet.ranges} />
              </span>
            ) : null}
          </>
        );
      case "hit":
        return (
          <>
            <EngineMark provider={entry.session.provider} size={15} className="palette-icon" />
            <span className="palette-title">{entry.session.purpose}</span>
            <span className="palette-meta">
              {placeOf(entry.session.workId)} · {ago(entry.at)}
            </span>
            <span className="palette-snippet">
              <span className="palette-who">{entry.who === "user" ? "나" : PROVIDER_LABEL[entry.session.provider]}</span>
              <Marked text={entry.snippet} ranges={entry.ranges} />
            </span>
          </>
        );
      case "command":
        return (
          <>
            <Icon name={entry.command.icon} size={16} className="palette-icon" />
            <span className="palette-title">{entry.command.label}</span>
            {entry.command.hint ? <span className="palette-meta">{entry.command.hint}</span> : null}
          </>
        );
    }
  };

  const preview = () => {
    if (!current) return <div className="palette-preview-empty">{needle ? (searching ? "찾는 중…" : "찾은 것이 없습니다.") : "작업·세션·대화 내용·문서를 찾습니다. > 로 시작하면 명령입니다."}</div>;
    if (current.kind === "hit" || current.kind === "session") {
      const session = current.session;
      const group = result?.sessions.find((entry) => entry.sessionId === session.id);
      return (
        <>
          <div className="palette-preview-head">
            <EngineMark provider={session.provider} size={15} /> {session.purpose}
            <span className="muted"> · {placeOf(session.workId)}</span>
          </div>
          {group ? (
            <>
              {group.hits.map((hit) => (
                <div key={hit.itemId} className={`palette-preview-hit${current.kind === "hit" && hit.itemId === current.itemId ? " current" : ""}`}>
                  <div className="palette-preview-who">
                    {hit.kind === "user" ? "나" : PROVIDER_LABEL[session.provider]} · {ago(hit.at)}
                  </div>
                  <Marked text={hit.snippet} ranges={hit.ranges} />
                </div>
              ))}
              {group.total > group.hits.length ? <div className="muted">이 대화에서 {group.total}곳 찾음</div> : null}
            </>
          ) : session.preview ? (
            <div className="palette-preview-hit">{session.preview}</div>
          ) : null}
          <div className="palette-preview-foot">{current.kind === "hit" ? "Enter 이 메시지로 이동" : "Enter 대화 열기"}</div>
        </>
      );
    }
    if (current.kind === "doc") {
      return (
        <>
          <div className="palette-preview-head">
            <Icon name="file" size={15} /> {current.artifact.name}
            <span className="muted"> · {FORMAT_LABEL[current.artifact.format]} r{current.artifact.revision}</span>
          </div>
          {current.snippet ? (
            <div className="palette-preview-hit">
              <Marked text={current.snippet.snippet} ranges={current.snippet.ranges} />
            </div>
          ) : null}
          <div className="palette-preview-path mono">{current.artifact.path}</div>
          <div className="palette-preview-foot">Enter 문서 열기</div>
        </>
      );
    }
    if (current.kind === "work") {
      return (
        <>
          <div className="palette-preview-head">
            <Icon name="project" size={15} /> {current.work.title}
          </div>
          <div className="palette-preview-path mono">{current.work.cwd}</div>
          <div className="palette-preview-foot">Enter 작업 열기</div>
        </>
      );
    }
    return (
      <>
        <div className="palette-preview-head">
          <Icon name={current.command.icon} size={15} /> {current.command.label}
        </div>
        <div className="palette-preview-foot">Enter 실행</div>
      </>
    );
  };

  return (
    <div className="palette-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="palette look-scope"
        data-theme={appTheme}
        style={lookStyle(NEUTRAL_LOOK[appTheme])}
        role="dialog"
        aria-label="찾기"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") setFocus((value) => Math.min(value + 1, flat.length - 1));
          else if (event.key === "ArrowUp") setFocus((value) => Math.max(value - 1, 0));
          else if (event.key === "Enter" && !event.nativeEvent.isComposing) open(current);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <label className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="작업, 세션, 대화 내용, 문서 찾기 · > 명령"
            aria-label="찾을 말"
            aria-controls="palette-results"
          />
          {searching ? <span className="spinner small" /> : result && !commandMode ? <span className="palette-took">{result.tookMs}ms · AI 호출 없음</span> : null}
        </label>
        {!commandMode ? (
          <div className="palette-filters">
            {([null, "claude", "codex"] as const).map((value) => (
              <button key={value ?? "all"} type="button" className={`filter-chip${provider === value ? " on" : ""}`} onClick={() => setProvider(value)}>
                {value ? PROVIDER_LABEL[value] : "모든 엔진"}
              </button>
            ))}
            <label className="filter-check">
              <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} /> 보관 포함
            </label>
          </div>
        ) : null}
        <div className="palette-body">
          <div className="palette-list" id="palette-results" role="listbox" ref={list}>
            {groups.map((group) => (
              <div key={group.label} className="palette-group">
                <div className="palette-group-label">{group.label}</div>
                {group.entries.map((entry) => {
                  const index = flat.indexOf(entry);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      role="option"
                      aria-selected={index === focus}
                      className={`palette-entry kind-${entry.kind}${index === focus ? " focused" : ""}`}
                      onPointerMove={() => setFocus(index)}
                      onClick={() => open(entry)}
                    >
                      {line(entry)}
                    </button>
                  );
                })}
              </div>
            ))}
            {needle && !groups.length && !searching ? <div className="palette-empty">"{needle}"을(를) 찾지 못했습니다.</div> : null}
          </div>
          <div className="palette-preview">{preview()}</div>
        </div>
        <div className="palette-foot">
          <span>↑↓ 고르기</span>
          <span>Enter 열기</span>
          <span>Esc 닫기</span>
          <span>&gt; 명령</span>
        </div>
      </div>
    </div>
  );
}
