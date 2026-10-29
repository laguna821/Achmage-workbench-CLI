import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FORMAT_LABEL,
  PROVIDER_LABEL,
  SCOPE_LABEL,
  SEARCH_KIND_LABEL,
  SEARCH_SCOPES,
  type Artifact,
  type FoundGroup,
  type FoundHit,
  type PkmView,
  type Provider,
  type SearchPage,
  type SearchScope,
  type Session,
  type Work,
} from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import type { PaneItem } from "../panes.ts";
import { ago } from "../format.ts";
import { sessionHidden } from "../tree.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { lookStyle, NEUTRAL_LOOK, useAppearance } from "../appearance.ts";
import "../styles/search.css";

// Ctrl+K: one place to find anything ("찾는 길") — works, sessions, requests, replies, plans,
// documents and vault notes from the gateway's index (no model is asked), grouped by work with
// totals, and commands. Tab switches the scope chips, ↑↓ choose, Enter opens (a message hit opens
// its conversation at that message), Shift+Enter opens a work's project page when the app offers
// one, Esc closes. Ctrl+Shift+F opens the same box for contents only.

export type PaletteCommand = { id: string; label: string; icon: IconName; hint?: string; run: () => void };

/** Ctrl+K (titles, contents and commands) or Ctrl+Shift+F (contents only). */
export type PaletteMode = "palette" | "content";

type Entry =
  | { key: string; kind: "hit"; hit: FoundHit }
  | { key: string; kind: "group-more"; group: FoundGroup }
  | { key: string; kind: "more"; label: string }
  | { key: string; kind: "back"; title: string }
  | { key: string; kind: "session"; session: Session }
  | { key: string; kind: "command"; command: PaletteCommand };

type Section = { key: string; label: ReactNode; count?: number; entries: Entry[] };

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
const MESSAGE = new Set<FoundHit["kind"]>(["user", "assistant", "plan", "attachment"]);
const ICON: Partial<Record<FoundHit["kind"], IconName>> = { work: "project", document: "file", note: "book", decision: "bulb", question: "help", event: "clock" };
const GROUPS_PER_PAGE = 8;
const HITS_PER_GROUP = 3;
const HITS_PER_PAGE = 20;

/** The saved-view query a search becomes ("보기로 저장"): its scope as `kind:`, then its words. Null: no view kind (결정). */
export function viewQueryFor(query: string, scope: SearchScope): string | null {
  const kind: Record<SearchScope, string | null> = { all: "", project: "kind:work", session: "kind:session", document: "kind:page", vault: "kind:note", decision: null };
  const prefix = kind[scope];
  if (prefix === null || !query.trim()) return null;
  return [prefix, query.trim()].filter(Boolean).join(" ");
}

/** The entries row class: message hits keep `kind-hit` (checks and older styles rely on it). */
function rowKind(entry: Entry) {
  if (entry.kind !== "hit") return entry.kind === "group-more" || entry.kind === "back" ? "more" : entry.kind;
  const kind = entry.hit.kind;
  return MESSAGE.has(kind) ? "hit" : kind === "document" ? "doc" : kind === "session" || kind === "work" || kind === "note" ? kind : "record";
}

function who(hit: FoundHit) {
  if (hit.kind === "user") return "나";
  if (hit.kind === "assistant") return hit.provider ? PROVIDER_LABEL[hit.provider] : "답";
  if (hit.kind === "plan") return hit.detail ? `계획 · ${hit.detail}` : "계획";
  if (hit.kind === "attachment") return "첨부";
  return null;
}

export function SearchPalette({
  api,
  state,
  commands,
  mode = "palette",
  onOpenSession,
  onOpenHit,
  onOpenWork,
  onOpenDoc,
  onOpenNote,
  onOpenView,
  onOpenProject,
  onOpenRight,
  onClose,
}: {
  api: Api;
  state: State;
  commands: PaletteCommand[];
  mode?: PaletteMode;
  onOpenSession: (session: Session) => void;
  onOpenHit: (session: Session, itemId: string) => void;
  onOpenWork: (work: Work) => void;
  onOpenDoc: (artifact: Artifact) => void;
  /** A vault note found (read-only view). */
  onOpenNote?: (path: string) => void;
  /** A view just saved from this search ("보기로 저장"). */
  onOpenView?: (viewId: string) => void;
  /** Shift+Enter on a work: its project page (absent: the work opens as with Enter). */
  onOpenProject?: (work: Work) => void;
  /** Alt+Enter: the hit opens in the right pane (two panes; absent in a session window). */
  onOpenRight?: (item: PaneItem) => void;
  onClose: () => void;
}) {
  const { appTheme } = useAppearance();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [archived, setArchived] = useState(false);
  const [pages, setPages] = useState<SearchPage[]>([]);
  const [group, setGroup] = useState<{ key: string; title: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const content = mode === "content";
  const commandMode = !content && query.startsWith(">");
  const needle = (commandMode ? query.slice(1) : query).trim();
  const lowerNeedle = needle.toLowerCase();
  const first = pages[0] ?? null;

  useEffect(() => input.current?.focus(), []);
  // Another query, scope or filter leaves an opened group and an old notice behind.
  useEffect(() => {
    setGroup(null);
    setNotice(null);
  }, [needle, scope, provider, archived]);

  const request = (offset: number) =>
    api.search(needle, { scope, provider, archived, legacy: false, offset, ...(group ? { group: group.key, limit: HITS_PER_PAGE } : { limit: GROUPS_PER_PAGE, per: HITS_PER_GROUP }) });

  // The index is asked a moment after typing stops.
  useEffect(() => {
    if (commandMode || !needle) {
      setPages([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      request(0)
        .then((page) => !cancelled && setPages([page]))
        .catch(() => !cancelled && setPages([]))
        .finally(() => !cancelled && setSearching(false));
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `request` reads the same values.
  }, [api, needle, scope, provider, archived, group, commandMode]);

  const groupHits = group ? pages.flatMap((page) => page.groups[0]?.hits ?? []) : [];
  const shownGroups = group ? 0 : pages.reduce((count, page) => count + page.groups.length, 0);

  /** "더 보기": the next page of groups (or of the open group's hits), added below. */
  const more = () => {
    if (!first || loadingMore) return;
    setLoadingMore(true);
    request(group ? groupHits.length : shownGroups)
      .then((page) => setPages((current) => (current[0] === first ? [...current, page] : current)))
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  };

  const sections = useMemo((): Section[] => {
    if (commandMode) {
      return [{ key: "commands", label: "명령", entries: commands.filter((command) => includes(command.label, lowerNeedle) || !lowerNeedle).map((command) => ({ key: `c:${command.id}`, kind: "command" as const, command })) }];
    }
    if (!needle) {
      if (content) return [];
      // Before typing: recent conversations, then the commands.
      const recent = Object.values(state.sessions)
        .filter((session) => !sessionHidden(state, session) && (!provider || session.provider === provider))
        .sort((a, b) => (b.previewAt ?? b.updatedAt) - (a.previewAt ?? a.updatedAt))
        .slice(0, 8);
      return [
        { key: "recent", label: "최근 대화", entries: recent.map((session) => ({ key: `s:${session.id}`, kind: "session" as const, session })) },
        { key: "commands", label: "명령", entries: commands.slice(0, 6).map((command) => ({ key: `c:${command.id}`, kind: "command" as const, command })) },
      ].filter((section) => section.entries.length);
    }
    const out: Section[] = [];
    if (group) {
      const total = first?.groups[0]?.total ?? 0;
      // The line above already names the work and its total.
      out.push({
        key: "group",
        label: null,
        entries: [
          { key: "back", kind: "back", title: group.title },
          ...groupHits.map((hit) => ({ key: `h:${hit.key}`, kind: "hit" as const, hit })),
          ...(first && groupHits.length < total ? [{ key: "more", kind: "more" as const, label: `더 보기 · ${total - groupHits.length}건 더` }] : []),
        ],
      });
      return out;
    }
    for (const found of pages.flatMap((page) => page.groups)) {
      out.push({
        key: `g:${found.key}`,
        label: found.trail.length ? (
          <>
            <span className="search-trail">{found.trail.join(" › ")} › </span>
            {found.title}
          </>
        ) : (
          found.title
        ),
        count: found.total,
        entries: [
          ...found.hits.map((hit) => ({ key: `h:${hit.key}`, kind: "hit" as const, hit })),
          ...(found.total > found.hits.length ? [{ key: `gm:${found.key}`, kind: "group-more" as const, group: found }] : []),
        ],
      });
    }
    if (first && shownGroups < first.groupsTotal) {
      out.push({ key: "more", label: null, entries: [{ key: "more", kind: "more", label: `더 보기 · ${first.groupsTotal - shownGroups}곳 더` }] });
    }
    if (!content) {
      const matching = commands.filter((command) => includes(command.label, lowerNeedle)).slice(0, 4);
      if (matching.length) out.push({ key: "commands", label: "명령", entries: matching.map((command) => ({ key: `c:${command.id}`, kind: "command" as const, command })) });
    }
    return out;
  }, [state, commands, needle, lowerNeedle, commandMode, content, pages, group, groupHits, shownGroups, first, provider]);

  const flat = sections.flatMap((section) => section.entries);
  useEffect(() => setFocus(0), [needle, scope, provider, archived, group]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".palette-entry.focused")?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  const current = flat[Math.min(focus, flat.length - 1)];

  const openHit = (hit: FoundHit, shift: boolean) => {
    const work = hit.workId ? state.works[hit.workId] : undefined;
    const session = hit.sessionId ? state.sessions[hit.sessionId] : undefined;
    if (hit.kind === "work") {
      if (!work) return;
      onClose();
      if (shift && onOpenProject) onOpenProject(work);
      else onOpenWork(work);
      return;
    }
    if (hit.kind === "document") {
      const artifact = hit.artifactId ? state.artifacts[hit.artifactId] : undefined;
      if (!artifact) return;
      onClose();
      onOpenDoc(artifact);
      return;
    }
    if (hit.kind === "note") {
      if (!hit.path || !onOpenNote) return;
      onClose();
      onOpenNote(hit.path);
      return;
    }
    if (hit.kind === "session" && session) {
      onClose();
      onOpenSession(session);
      return;
    }
    if (session && hit.itemId) {
      onClose();
      onOpenHit(session, hit.itemId);
      return;
    }
    if (work) {
      onClose();
      if (onOpenProject) onOpenProject(work);
      else onOpenWork(work);
    }
  };

  /** What a hit is as something a pane shows: its session, document, note, work or project. */
  const paneItemOf = (hit: FoundHit): PaneItem | null => {
    if (hit.kind === "document" && hit.artifactId) return { kind: "doc", id: hit.artifactId };
    if (hit.kind === "note" && hit.path) return { kind: "note", path: hit.path };
    if (hit.kind === "work" && hit.workId) return { kind: "work", id: hit.workId };
    if (hit.sessionId && state.sessions[hit.sessionId]) return { kind: "session", id: hit.sessionId };
    if (hit.workId) return { kind: "project", id: hit.workId };
    return null;
  };

  const openRight = (entry: Entry | undefined) => {
    const item = entry?.kind === "hit" ? paneItemOf(entry.hit) : null;
    if (!item || !onOpenRight) return open(entry);
    onClose();
    onOpenRight(item);
  };

  const open = (entry: Entry | undefined, shift = false) => {
    if (!entry) return;
    // Actions inside the box keep the typing (and Esc, Tab, arrows) in its input.
    input.current?.focus();
    switch (entry.kind) {
      case "hit":
        return openHit(entry.hit, shift);
      case "group-more":
        setGroup({ key: entry.group.key, title: entry.group.title });
        return;
      case "more":
        return more();
      case "back":
        setGroup(null);
        return;
      case "session":
        onClose();
        return onOpenSession(entry.session);
      case "command":
        onClose();
        return entry.command.run();
    }
  };

  const viewQuery = viewQueryFor(needle, scope);
  const saveView = () => {
    if (!viewQuery) return;
    api
      .request<PkmView>("PUT", "/api/pkm/views", { name: needle.slice(0, 60), query: viewQuery, groupBy: null })
      .then((view) => {
        if (onOpenView) {
          onClose();
          onOpenView(view.id);
        } else setNotice(`보기 「${view.name}」로 저장했습니다.`);
      })
      .catch((error: unknown) => setNotice(`보기로 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`));
  };

  const switchScope = (step: number) => {
    const index = SEARCH_SCOPES.indexOf(scope);
    setScope(SEARCH_SCOPES[(index + step + SEARCH_SCOPES.length) % SEARCH_SCOPES.length]!);
  };

  const placeOf = (workId: string | null) => (workId ? (state.works[workId]?.title ?? "") : "");

  const hitIcon = (hit: FoundHit) =>
    hit.provider && (MESSAGE.has(hit.kind) || hit.kind === "session") ? (
      <EngineMark provider={hit.provider} size={15} className="palette-icon" />
    ) : (
      <Icon name={ICON[hit.kind] ?? (hit.kind === "session" ? "chat" : "file")} size={16} className="palette-icon" />
    );

  const hitMeta = (hit: FoundHit) => {
    const when = hit.at ? ago(hit.at) : "";
    if (hit.kind === "document") return [`${SEARCH_KIND_LABEL.document} r${hit.revision ?? "?"}`, hit.provider ? `${PROVIDER_LABEL[hit.provider]}가 만듦` : null, when].filter(Boolean).join(" · ");
    if (hit.kind === "note") return [SEARCH_KIND_LABEL.note, hit.detail].filter(Boolean).join(" · ");
    if (hit.kind === "work") return SEARCH_KIND_LABEL.work;
    return [SEARCH_KIND_LABEL[hit.kind], when].filter(Boolean).join(" · ");
  };

  const line = (entry: Entry) => {
    switch (entry.kind) {
      case "hit": {
        const hit = entry.hit;
        const speaker = who(hit);
        return (
          <>
            {hitIcon(hit)}
            <span className="palette-title">
              <Marked text={hit.title} ranges={hit.titleRanges} />
            </span>
            <span className="palette-meta">{hitMeta(hit)}</span>
            {hit.snippet && hit.snippet !== hit.title ? (
              <span className="palette-snippet">
                {speaker ? <span className="palette-who">{speaker}</span> : null}
                <Marked text={hit.snippet} ranges={hit.ranges} />
              </span>
            ) : null}
          </>
        );
      }
      case "group-more":
        return (
          <>
            <Icon name="list" size={15} className="palette-icon" />
            <span className="palette-title search-more-label">이 작업에서 {entry.group.total - entry.group.hits.length}건 더</span>
          </>
        );
      case "more":
        return (
          <>
            <Icon name="chevronDown" size={15} className="palette-icon" />
            <span className="palette-title search-more-label">{loadingMore ? "불러오는 중…" : entry.label}</span>
          </>
        );
      case "back":
        return (
          <>
            <Icon name="arrowLeft" size={15} className="palette-icon" />
            <span className="palette-title search-more-label">모든 결과로</span>
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
    if (!current) {
      if (needle && searching) return <div className="palette-preview-empty">찾는 중…</div>;
      if (needle) return <div className="palette-preview-empty">찾은 것이 없습니다.</div>;
      return (
        <div className="palette-preview-empty">
          {content ? "대화·답·계획·문서·볼트 노트의 내용을 찾습니다. Tab으로 범위를 바꿉니다." : "작업·세션·대화 내용·문서·볼트 노트를 찾습니다. Tab으로 범위를 바꾸고, > 로 시작하면 명령입니다."}
        </div>
      );
    }
    if (current.kind === "hit") {
      const hit = current.hit;
      const session = hit.sessionId ? state.sessions[hit.sessionId] : undefined;
      const artifact = hit.artifactId ? state.artifacts[hit.artifactId] : undefined;
      const work = hit.workId ? state.works[hit.workId] : undefined;
      const foot =
        hit.kind === "work"
          ? onOpenProject
            ? "Enter 작업 열기 · Shift+Enter 프로젝트"
            : "Enter 작업 열기"
          : hit.kind === "document"
            ? "Enter 문서 열기"
            : hit.kind === "note"
              ? "Enter 노트 열기(읽기 전용)"
              : hit.kind === "session"
                ? "Enter 대화 열기"
                : hit.itemId
                  ? "Enter 이 메시지로 이동"
                  : "Enter 열기";
      return (
        <>
          <div className="palette-preview-head">
            {hitIcon(hit)} {hit.title}
            <span className="muted">
              {" "}
              · {hit.kind === "document" && artifact ? `${FORMAT_LABEL[artifact.format]} r${hit.revision ?? artifact.revision}` : SEARCH_KIND_LABEL[hit.kind]}
            </span>
          </div>
          {hit.snippet ? (
            <div className="palette-preview-hit current">
              {who(hit) ? (
                <div className="palette-preview-who">
                  {who(hit)}
                  {hit.at ? ` · ${ago(hit.at)}` : ""}
                </div>
              ) : null}
              <Marked text={hit.snippet} ranges={hit.ranges} />
            </div>
          ) : session?.preview && hit.kind === "session" ? (
            <div className="palette-preview-hit">{session.preview}</div>
          ) : null}
          {hit.answer ? (
            <div className="palette-preview-hit search-answer">
              <div className="palette-preview-who">
                {hit.answer.matched ? "이 문서를 만든 답(같은 줄로 합침)" : "이 문서를 만든 답"} · {hit.provider ? PROVIDER_LABEL[hit.provider] : ""} · {hit.sessionTitle ?? ""}
              </div>
              {hit.answer.snippet ? <Marked text={hit.answer.snippet} ranges={hit.answer.ranges} /> : null}
            </div>
          ) : null}
          {hit.kind === "document" && artifact ? <div className="palette-preview-path mono">{artifact.path}</div> : null}
          {hit.kind === "note" && hit.path ? <div className="palette-preview-path mono">볼트 › {hit.path}</div> : null}
          {hit.kind === "work" && work ? <div className="palette-preview-path mono">{work.cwd}</div> : null}
          {MESSAGE.has(hit.kind) && work ? <div className="palette-preview-path">{work.title}</div> : null}
          <div className="palette-preview-foot">{foot}</div>
        </>
      );
    }
    if (current.kind === "group-more") {
      return (
        <>
          <div className="palette-preview-head">
            <Icon name="project" size={15} /> {current.group.title}
          </div>
          <div className="palette-preview-hit">이 작업에서 찾은 {current.group.total}건을 모두 봅니다.</div>
          <div className="palette-preview-foot">Enter 이 작업만 보기 · Esc 돌아가기</div>
        </>
      );
    }
    if (current.kind === "more" || current.kind === "back") {
      return <div className="palette-preview-empty">{current.kind === "back" ? "모든 작업의 결과로 돌아갑니다." : "아래에 이어서 더 불러옵니다. 잘라 낸 것은 없습니다."}</div>;
    }
    if (current.kind === "session") {
      return (
        <>
          <div className="palette-preview-head">
            <EngineMark provider={current.session.provider} size={15} /> {current.session.purpose}
            <span className="muted"> · {placeOf(current.session.workId)}</span>
          </div>
          {current.session.preview ? <div className="palette-preview-hit">{current.session.preview}</div> : null}
          <div className="palette-preview-foot">Enter 대화 열기</div>
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

  const vaultShown = Boolean(first && (scope === "all" || scope === "vault") && first.counts.vault > 0);
  const places = first ? first.groupsTotal - (vaultShown ? 1 : 0) : 0;

  return (
    <div className="palette-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={`palette look-scope${content ? " search-content" : ""}`}
        data-theme={appTheme}
        style={lookStyle(NEUTRAL_LOOK[appTheme])}
        role="dialog"
        aria-label={content ? "내용 찾기" : "찾기"}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (group) setGroup(null);
            else onClose();
          } else if (event.key === "Tab" && !commandMode && !event.nativeEvent.isComposing) switchScope(event.shiftKey ? -1 : 1);
          else if (event.key === "ArrowDown") setFocus((value) => Math.min(value + 1, flat.length - 1));
          else if (event.key === "ArrowUp") setFocus((value) => Math.max(value - 1, 0));
          else if (event.key === "Enter" && !event.nativeEvent.isComposing && event.altKey) openRight(current);
          else if (event.key === "Enter" && !event.nativeEvent.isComposing) open(current, event.shiftKey);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <label className="palette-input">
          <Icon name="search" size={18} />
          {content ? <span className="search-mode">내용</span> : null}
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={content ? "대화·문서·노트 내용 찾기" : "작업, 세션, 대화 내용, 문서, 노트 찾기 · > 명령"}
            aria-label="찾을 말"
            aria-controls="palette-results"
          />
          {searching ? <span className="spinner small" /> : first && !commandMode ? <span className="palette-took">{first.tookMs}ms · AI 호출 없음</span> : null}
        </label>
        {!commandMode ? (
          <div className="palette-filters search-filters">
            <div className="search-scopes" role="tablist" aria-label="범위 (Tab)">
              {SEARCH_SCOPES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  tabIndex={-1}
                  aria-selected={scope === value}
                  className={`search-scope${scope === value ? " on" : ""}${first && !first.counts[value] ? " empty" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setScope(value);
                    input.current?.focus();
                  }}
                >
                  {SCOPE_LABEL[value]}
                  {first ? <span className="search-scope-count">{first.counts[value]}</span> : null}
                </button>
              ))}
            </div>
            <span className="search-filters-gap" />
            {([null, "claude", "codex"] as const).map((value) => (
              <button key={value ?? "all"} type="button" tabIndex={-1} className={`filter-chip${provider === value ? " on" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => setProvider(value)}>
                {value ? PROVIDER_LABEL[value] : "모든 엔진"}
              </button>
            ))}
            <label className="filter-check">
              <input
                type="checkbox"
                tabIndex={-1}
                checked={archived}
                onChange={(event) => {
                  setArchived(event.target.checked);
                  input.current?.focus();
                }}
              />{" "}
              보관 포함
            </label>
          </div>
        ) : null}
        <div className="palette-body">
          <div className="palette-list" id="palette-results" role="listbox" ref={list}>
            {needle && first && !commandMode ? (
              <div className="search-summary">
                <span className="search-total">
                  {group
                    ? `${group.title} · ${first.groups[0]?.total ?? 0}건`
                    : `${scope === "all" ? "총" : SCOPE_LABEL[scope]} ${first.total}건${places ? ` · 작업 ${places}곳` : ""}${vaultShown ? " · 볼트" : ""}`}
                </span>
                <span className="search-filters-gap" />
                <button
                  type="button"
                  tabIndex={-1}
                  className="search-save"
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={!viewQuery}
                  title={viewQuery ? `보기 조건: ${viewQuery}` : "결정 범위는 보기로 저장할 수 없습니다"}
                  onClick={saveView}
                >
                  <Icon name="grid" size={13} /> 보기로 저장
                </button>
              </div>
            ) : null}
            {notice ? <div className="search-notice">{notice}</div> : null}
            {sections.map((section) => (
              <div key={section.key} className={`palette-group${section.key.startsWith("g:") || section.key === "group" ? " search-group" : ""}`}>
                {section.label ? (
                  <div className="palette-group-label">
                    <span className="search-group-title">{section.label}</span>
                    {section.count !== undefined ? <span className="search-group-count">{section.count}건</span> : null}
                  </div>
                ) : null}
                {section.entries.map((entry) => {
                  const index = flat.indexOf(entry);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === focus}
                      className={`palette-entry kind-${rowKind(entry)}${index === focus ? " focused" : ""}`}
                      onPointerMove={() => setFocus(index)}
                      // The input keeps the focus (a row that goes away would leave the keys nowhere).
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => open(entry, event.shiftKey)}
                    >
                      {line(entry)}
                    </button>
                  );
                })}
              </div>
            ))}
            {needle && first && !first.total && !searching && !commandMode ? (
              <div className="palette-empty">
                "{needle}"을(를) {scope === "all" ? "" : `${SCOPE_LABEL[scope]}에서 `}찾지 못했습니다.
                {scope !== "all" && first.counts.all ? ` 다른 범위에 ${first.counts.all}건이 있습니다(Tab).` : ""}
              </div>
            ) : null}
          </div>
          <div className="palette-preview">{preview()}</div>
        </div>
        <div className="palette-foot">
          <span>↑↓ 고르기</span>
          <span>Enter 열기</span>
          {current?.kind === "hit" && current.hit.kind === "work" && onOpenProject ? <span>Shift+Enter 프로젝트</span> : null}
          <span>Tab 범위</span>
          <span>Esc {group ? "돌아가기" : "닫기"}</span>
          {!content ? <span>&gt; 명령</span> : null}
        </div>
      </div>
    </div>
  );
}
