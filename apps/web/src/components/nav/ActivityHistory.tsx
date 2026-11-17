import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PROVIDER_LABEL, type HistoryEvent, type HistoryFilter } from "@workbench/contracts";
import { clock, foldHistory, historyDays, historyPlace, historyText, historyTone, mergePages, aboutDocument, type HistoryContext, type HistoryEntry } from "../../activity-history.ts";
import { workHidden } from "../../tree.ts";
import type { State } from "../../state.ts";
import { Icon } from "../Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { sideClick } from "./rows.tsx";
import { LIST_STOP, typeAhead } from "./focus.ts";
import type { NavShared } from "./shared.ts";

// 활동 › 기록: what happened, newest first, grouped by day — a page from the gateway at a time
// (GET /api/activity/history), the next one when the list's end comes into view. Nothing is polled: the
// first page is read again a moment after something that makes a line changed in the app's state (a
// conversation's state, a document's revision, a 수정안), and only while this list is on screen.

export const HISTORY_FILTER_LABEL: Record<HistoryFilter, string> = { all: "전체", attention: "내가 확인할 것", done: "끝난 일", problem: "문제" };
const FILTERS: HistoryFilter[] = ["all", "attention", "done", "problem"];
const PAGE = 100;
/** The first page is read again this long after the last change that makes a line (changes in a burst read it once). */
export const HISTORY_SETTLE = 1500;

/** What changes when a line appears or changes (not a streamed token): conversations' states, revisions, 수정안. */
export function historyPulse(state: Pick<State, "sessions" | "artifacts" | "proposals">): string {
  let sessions = 0, artifacts = 0, proposals = 0;
  const mix = (hash: number, text: string) => { for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0; return hash; };
  for (const session of Object.values(state.sessions)) sessions = mix(sessions, `${session.id}${session.status}${session.archivedAt ?? ""}${session.previewAt ?? ""}`);
  for (const artifact of Object.values(state.artifacts)) artifacts = mix(artifacts, `${artifact.id}${artifact.revision}${artifact.name}${artifact.removed?.at ?? ""}`);
  for (const proposal of Object.values(state.proposals)) proposals = mix(proposals, `${proposal.id}${proposal.status}`);
  return `${sessions}:${artifacts}:${proposals}`;
}

function stepKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (typeAhead(event)) { event.preventDefault(); return true; }
  const rows = [...(event.currentTarget.closest(".nav-level")?.querySelectorAll<HTMLElement>(LIST_STOP) ?? [])];
  const at = rows.indexOf(event.currentTarget);
  const next = event.key === "ArrowDown" ? rows[at + 1] : event.key === "ArrowUp" ? rows[at - 1] : event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : undefined;
  if (!next) return false;
  event.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return true;
}

type Load = { status: "loading" | "ready" | "error"; events: HistoryEvent[]; next: string | null; error: string | null };

export function ActivityHistory({ shared, onToday }: { shared: NavShared; onToday: () => void }) {
  const { state, actions, api } = shared;
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [workId, setWorkId] = useState("");
  const [load, setLoad] = useState<Load>({ status: "loading", events: [], next: null, error: null });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef(0);
  const more = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const first = useCallback(async (keep: boolean) => {
    const ask = ++asked.current;
    if (!keep) setLoad({ status: "loading", events: [], next: null, error: null });
    try {
      const page = await api.history({ limit: PAGE, filter, workId: workId || null });
      if (ask !== asked.current) return;
      setLoad((now) => keep && now.status === "ready"
        ? { status: "ready", events: mergePages(page.events, now.events), next: now.events.length > page.events.length ? now.next : page.next, error: null }
        : { status: "ready", events: page.events, next: page.next, error: null });
    } catch (error) {
      if (ask !== asked.current) return;
      setLoad((now) => (keep && now.status === "ready" ? now : { status: "error", events: [], next: null, error: error instanceof Error ? error.message : String(error) }));
    }
  }, [api, filter, workId]);

  useEffect(() => { void first(false); }, [first]);

  // Read the first page again a moment after a change that makes a line, while this list is on screen.
  const pulse = useMemo(() => historyPulse(state), [state.sessions, state.artifacts, state.proposals]);
  const seenPulse = useRef(pulse);
  useEffect(() => {
    if (pulse === seenPulse.current) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "hidden") return;
      seenPulse.current = pulse;
      void first(true);
    }, HISTORY_SETTLE);
    return () => window.clearTimeout(timer);
  }, [pulse, first]);
  useEffect(() => {
    const shown = () => { if (document.visibilityState === "visible" && seenPulse.current !== pulse) { seenPulse.current = pulse; void first(true); } };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, [pulse, first]);

  const loadMore = useCallback(async () => {
    const now = loadRef.current;
    if (more.current || now.status !== "ready" || !now.next) return;
    more.current = true;
    const ask = asked.current;
    try {
      const page = await api.history({ before: now.next, limit: PAGE, filter, workId: workId || null });
      if (ask !== asked.current) return;
      setLoad((current) => ({ ...current, events: [...current.events, ...page.events.filter((event) => !current.events.some((seen) => seen.id === event.id))], next: page.next }));
    } catch { /* The button stays; the next try reads again. */ } finally { more.current = false; }
  }, [api, filter, workId]);

  // The next page when the list's end comes into view (the button under the list does the same by key).
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = end.current;
    if (!target || !load.next || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((seen) => { if (seen.some((entry) => entry.isIntersecting)) void loadMore(); }, { root: target.closest(".nav-scroll"), rootMargin: "200px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [load.next, loadMore]);

  const ctx = useMemo<HistoryContext>(() => ({
    work: (id) => state.works[id] ?? null,
    session: (id) => { const session = state.sessions[id]; return session ? { purpose: session.purpose, provider: session.provider, artifactId: session.documentAgent?.artifactId ?? null } : null; },
    artifact: (id) => state.artifacts[id] ?? null,
  }), [state.works, state.sessions, state.artifacts]);
  const entries = useMemo(() => foldHistory(load.events, ctx), [load.events, ctx]);
  const days = useMemo(() => historyDays(entries, Date.now()), [entries]);
  const projects = useMemo(() => [
    { value: "", label: "모든 프로젝트" },
    ...Object.values(state.works).filter((work) => !work.messengerHome && !workHidden(state, work)).sort((a, b) => a.title.localeCompare(b.title, "ko")).map((work) => ({ value: work.id, label: work.title })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [state.works, state.folders]);

  const open = (event: HistoryEvent, click?: { ctrlKey: boolean; metaKey: boolean; button: number }) => {
    const artifactId = aboutDocument(event) ? event.artifactId : null;
    if (artifactId) {
      const artifact = state.artifacts[artifactId];
      if (!artifact || artifact.removed) return actions.openArchive();
      if (click && sideClick(click) && actions.openRight) return actions.openRight({ kind: "doc", id: artifact.id });
      return actions.openDoc(artifact);
    }
    const session = event.sessionId ? state.sessions[event.sessionId] : undefined;
    if (!session) return;
    if (click && sideClick(click) && actions.openRight && !session.documentAgent) return actions.openRight({ kind: "session", id: session.id });
    if (event.itemId && actions.openSessionAt) return actions.openSessionAt(session, event.itemId);
    actions.openSession(session);
  };

  const line = (event: HistoryEvent, nested = false) => {
    const place = historyPlace(event, ctx);
    const text = historyText(event);
    const tone = historyTone(event);
    const where = [nested ? null : place.project, nested ? null : place.subject, place.engine ? PROVIDER_LABEL[place.engine] : null].filter(Boolean).join(" · ");
    return (
      <div key={event.id} role="button" tabIndex={0} className={`side-row nav-hist-line${nested ? " nested" : ""}`} data-list-row="" data-history-line={event.kind} data-tone={tone}
        title={`${clock(event.at)} ${text}\n${place.project} · ${place.subject}`} aria-label={`${clock(event.at)}, ${text}, ${place.project}, ${place.subject}`}
        onClick={(click) => open(event, click)} onAuxClick={(click) => click.button === 1 && open(event, click)}
        onKeyDown={(key) => { if (stepKey(key)) return; if (key.key === "Enter") { key.preventDefault(); open(event); } }}>
        <span className="nav-hist-time">{clock(event.at)}</span>
        <span className="nav-hist-body">
          <span className={`nav-hist-text${tone === "plain" ? "" : ` tone-${tone}`}`}>{text}</span>
          {where ? <span className="nav-hist-place">{where}</span> : null}
        </span>
      </div>
    );
  };

  const fold = (entry: Extract<HistoryEntry, { kind: "fold" }>) => {
    const isOpen = expanded.has(entry.key);
    const oldest = entry.events.at(-1)!;
    const place = historyPlace(entry.events[0]!, ctx);
    const toggle = () => setExpanded((now) => { const next = new Set(now); if (next.has(entry.key)) next.delete(entry.key); else next.add(entry.key); return next; });
    return (
      <div key={entry.key} role="none" className="nav-hist-fold">
        <div role="button" tabIndex={0} aria-expanded={isOpen} className="side-row nav-hist-line folded" data-list-row="" data-history-fold={entry.events.length}
          title={entry.summary} aria-label={`${clock(oldest.at)}부터 ${clock(entry.at)}까지, ${entry.summary}, ${place.project}`}
          onClick={toggle}
          onKeyDown={(key) => {
            if (stepKey(key)) return;
            if (key.key === "Enter" || key.key === " ") { key.preventDefault(); toggle(); }
            else if (key.key === "ArrowRight" && !isOpen) { key.preventDefault(); toggle(); }
            else if (key.key === "ArrowLeft" && isOpen) { key.preventDefault(); toggle(); }
          }}>
          <span className="nav-hist-time">{clock(entry.at)}</span>
          <span className="nav-hist-body">
            <span className="nav-hist-text">{entry.summary}</span>
            <span className="nav-hist-place">{[place.project, `${clock(oldest.at)}–${clock(entry.at)}`, place.engine ? PROVIDER_LABEL[place.engine] : null].filter(Boolean).join(" · ")}</span>
          </span>
          <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={14} className="nav-hist-chevron" />
        </div>
        {isOpen ? entry.events.map((event) => line(event, true)) : null}
      </div>
    );
  };

  const empty = load.status === "ready" && !load.events.length;
  return (
    <>
      <div className="nav-hist-tools">
        <div className="nav-hist-chips" role="radiogroup" aria-label="기록 거르기">
          {FILTERS.map((value) => (
            <button key={value} type="button" role="radio" aria-checked={filter === value} className={`filter-chip${filter === value ? " on" : ""}`} onClick={() => setFilter(value)}>
              {HISTORY_FILTER_LABEL[value]}
            </button>
          ))}
        </div>
        <Select className="nav-hist-project" label="프로젝트로 거르기" value={workId} options={projects} searchable={projects.length > 8} onChange={setWorkId} />
      </div>
      <div className="nav-scroll side-scroll nav-hist-scroll" role="list" aria-label="활동 기록" aria-busy={load.status === "loading" || undefined}>
        {filter === "attention" ? (
          <button type="button" className="side-row nav-link-row nav-hist-today" data-list-row="" onClick={onToday} onKeyDown={(event) => stepKey(event)}>
            <Icon name="bell" size={15} className="side-row-icon" />
            <span className="side-row-label">지금 확인할 대화는 현황에서</span>
          </button>
        ) : null}
        {load.status === "loading" ? <div className="nav-empty" role="status"><p>기록을 읽는 중…</p></div> : null}
        {load.status === "error" ? (
          <div className="nav-empty" role="alert">
            <p>기록을 읽지 못했습니다. {load.error}</p>
            <button type="button" className="ghost-button small nav-empty-action" onClick={() => void first(false)}>다시 읽기</button>
          </div>
        ) : null}
        {empty ? (
          <div className="nav-empty" role="status">
            <p>{filter === "attention" ? "지금 답을 기다리는 승인이나 질문이 없습니다." : filter === "problem" ? "실패하거나 멈춘 일이 없습니다." : filter === "done" ? "아직 끝난 일이 없습니다." : "아직 기록이 없습니다."}</p>
            {filter !== "all" || workId ? <button type="button" className="ghost-button small nav-empty-action" onClick={() => { setFilter("all"); setWorkId(""); }}>전체 보기</button> : null}
          </div>
        ) : null}
        {days.map((day) => (
          <div key={day.key} role="none">
            <div className="nav-group" role="presentation"><span>{day.label}</span></div>
            {day.entries.map((entry) => (entry.kind === "fold" ? fold(entry) : line(entry.event)))}
          </div>
        ))}
        {load.status === "ready" && load.next ? (
          <div ref={end} role="none">
            <button type="button" className="text-button nav-more" data-list-more="" onKeyDown={(event) => { stepKey(event); }} onClick={() => void loadMore()}>기록 더 보기</button>
          </div>
        ) : null}
      </div>
    </>
  );
}
