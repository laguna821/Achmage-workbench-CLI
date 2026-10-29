import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LINK_REASON_LABEL, linkMaxHops, type LinkHop, type LinkTurn, type SessionLink } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { durationText, goalLine, hopsText, participantName, useLinks, useNow } from "../links.ts";
import { diagramComponents } from "./Diagram.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { LinkDialog } from "./LinkDialog.tsx";
import "../styles/links.css";

// "세션 잇기" in conversations: the mark on a request a link handed over, the card where a link
// ended, and "주고받은 내용" — every participant's turns of one link in one column.

const DRAWN = diagramComponents();

const clock = (at: number) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

/** On a request a link handed over: whose answer it is (or the goal), and which message of how many. */
export function LinkHopBadge({ hop }: { hop: LinkHop }) {
  const { state, openSession, openView } = useLinks();
  const { lookOf } = useAppearance();
  const from = hop.fromSessionId ? state.sessions[hop.fromSessionId] : undefined;
  // Several answers handed over at once (three or more sessions): every speaker, oldest first.
  const speakers = (hop.from?.length ?? 0) > 1 ? [...new Set(hop.from)].map((id) => participantName(state.sessions[id])).join(", ") : null;
  return (
    <span className="linked-hop" data-link-id={hop.linkId}>
      <button
        type="button"
        className="from-badge linked-hop-from"
        style={from ? accentStyle(lookOf(from.provider)) : undefined}
        onClick={() => (from ? openSession(from.id) : openView(hop.linkId))}
        title={from ? "그 세션 열기" : "주고받은 내용 보기"}
      >
        <span aria-hidden>⇄</span>
        {from ? <EngineMark provider={from.provider} size={12} /> : null}
        {speakers ? `${speakers}의 답` : from ? `${participantName(from)}의 답` : "세션 잇기 목표"}
      </button>
      <span className="linked-hop-count" title="세션 잇기에서 주고받은 순서">
        {hop.hop}/{hop.of}
      </span>
    </span>
  );
}

/** Another session's reply as this session received it: folded when long. */
export function LinkRequestText({ text }: { text: string }) {
  const long = text.length > 700 || text.split("\n").length > 14;
  const [open, setOpen] = useState(false);
  return (
    <div className={`linked-request${long && !open ? " folded" : ""}`}>
      <div className="user-bubble markdown">
        <Markdown remarkPlugins={[remarkGfm]} components={DRAWN}>
          {text}
        </Markdown>
      </div>
      {long ? (
        <button type="button" className="link linked-request-toggle" onClick={() => setOpen(!open)}>
          {open ? "접기" : "받은 답 전체 보기"}
        </button>
      ) : null}
    </div>
  );
}

/** Where a link ended, in each participant's conversation: rounds, why, how long. */
export function LinkEndCard({ linkId }: { linkId: string }) {
  const { state, openView, openDialog } = useLinks();
  const link = state.links[linkId];
  if (!link) return null;
  const rounds = Math.ceil(link.hops / link.participants.length);
  const good = link.reason === "agreed" || link.reason === "done" || link.reason === "rounds";
  return (
    <div className={`linked-end${good ? "" : " cut"}`} role="note" data-link-id={link.id}>
      <div className="linked-end-head">
        <span aria-hidden>⇄</span>
        <span>세션 잇기 끝 · {link.reason ? LINK_REASON_LABEL[link.reason] : "끝남"}</span>
      </div>
      <div className="linked-end-meta">
        {rounds}/{link.maxRounds}왕복 · {link.hops}번 주고받음 · {durationText(link, link.endedAt ?? link.updatedAt)} · {link.participants.map((id) => participantName(state.sessions[id])).join(" ⇄ ")}
      </div>
      <div className="linked-end-actions">
        <button type="button" className="link" onClick={() => openView(link.id)}>
          주고받은 내용
        </button>
        <button type="button" className="link" onClick={() => openDialog(link.participants, link.goal)}>
          다시 잇기…
        </button>
      </div>
    </div>
  );
}

const STATUS_NOTE: Record<LinkTurn["status"], string | null> = { running: "답하는 중", completed: null, interrupted: "중단됨", failed: "응답이 끝나지 못함" };

/** "주고받은 내용": the goal, then each turn of every participant in the order handed over. */
export function LinkView({ api, linkId, inDesktop, onClose }: { api: Api; linkId: string; inDesktop: boolean; onClose: () => void }) {
  const links = useLinks();
  const { lookOf } = useAppearance();
  const link: SessionLink | undefined = links.state.links[linkId];
  const [turns, setTurns] = useState<LinkTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = link?.state === "active";
  const now = useNow(live ? 2_000 : null);
  // Read again whenever the link moves on, and every few seconds while replies stream in.
  const refresh = live ? Math.floor(now / 2_000) : 0;
  useEffect(() => {
    let cancelled = false;
    api
      .linkTurns(linkId)
      .then((result) => {
        if (cancelled) return;
        setTurns(result.turns);
        setError(null);
      })
      .catch((failure: unknown) => !cancelled && setError(failure instanceof Error ? failure.message : String(failure)));
    return () => {
      cancelled = true;
    };
  }, [api, linkId, link?.updatedAt, refresh]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const names = useMemo(() => (link ? link.participants.map((id) => links.state.sessions[id]) : []), [link, links.state.sessions]);
  if (!link) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="linked-view" role="dialog" aria-label="주고받은 내용">
        <header className="linked-view-head">
          <div>
            <h2>주고받은 내용</h2>
            <div className="linked-view-meta">
              {names.map((session, index) => (
                <span key={link.participants[index]} className="linked-view-who" style={session ? accentStyle(lookOf(session.provider)) : undefined}>
                  {session ? <EngineMark provider={session.provider} size={13} /> : null}
                  {participantName(session)}
                  {index < names.length - 1 ? <span className="muted"> ⇄ </span> : null}
                </span>
              ))}
              <span className="muted">
                {" "}
                · {hopsText(link)} · {durationText(link, now)} · {link.state === "ended" ? `끝: ${link.reason ? LINK_REASON_LABEL[link.reason] : ""}` : link.state === "paused" ? (link.reason ? LINK_REASON_LABEL[link.reason] : "멈춤") : "진행 중"}
              </span>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="닫기" title="닫기 (Esc)">
            <Icon name="x" size={17} />
          </button>
        </header>
        <div className="linked-view-body">
          <section className="linked-turn goal">
            <div className="linked-turn-who">
              <span className="linked-turn-no">목표</span> 나 · {clock(link.startedAt)}
            </div>
            <div className="markdown">
              <Markdown remarkPlugins={[remarkGfm]} components={DRAWN}>
                {link.goal}
              </Markdown>
            </div>
          </section>
          {(turns ?? []).map((turn) => {
            const session = links.state.sessions[turn.sessionId];
            return (
              <section key={turn.id} className={`linked-turn status-${turn.status}`} style={session ? accentStyle(lookOf(session.provider)) : undefined}>
                <div className="linked-turn-who">
                  <span className="linked-turn-no">{turn.hop}</span>
                  {session ? <EngineMark provider={session.provider} size={14} /> : null}
                  <button type="button" className="link" onClick={() => links.openSession(turn.sessionId)}>
                    {participantName(session)}
                  </button>
                  <span className="muted">· {clock(turn.at)}</span>
                  {STATUS_NOTE[turn.status] ? <span className="linked-turn-note">{STATUS_NOTE[turn.status]}</span> : null}
                </div>
                {turn.reply ? (
                  <div className="markdown">
                    <Markdown remarkPlugins={[remarkGfm]} components={DRAWN}>
                      {turn.reply}
                    </Markdown>
                  </div>
                ) : (
                  <div className="muted">{turn.status === "running" ? "답을 쓰는 중입니다." : "답이 없습니다."}</div>
                )}
              </section>
            );
          })}
          {turns === null && !error ? <div className="empty-hint">불러오는 중…</div> : null}
          {error ? <div className="notice notice-error">{error}</div> : null}
          {link.state === "ended" ? (
            <div className="linked-view-end">
              <span aria-hidden>⇄</span> 끝 · {link.reason ? LINK_REASON_LABEL[link.reason] : ""} · {link.hops}/{linkMaxHops(link)}번 주고받음
            </div>
          ) : null}
        </div>
        <footer className="linked-view-foot">
          <span className="muted" title={link.goal}>
            {goalLine(link.goal, 40)}
          </span>
          <span className="linked-view-actions">
            <button type="button" className="text-button" onClick={() => links.exportLink(link, "text")}>
              <Icon name="copy" size={14} /> 마크다운 복사
            </button>
            <button type="button" className="text-button" onClick={() => links.exportLink(link, "work")} title="첫 세션의 작업 폴더 '세션 기록/'에 저장">
              <Icon name="download" size={14} /> 작업 폴더에 저장
            </button>
            {inDesktop ? (
              <button type="button" className="text-button" onClick={() => links.exportLink(link, "path")}>
                <Icon name="folderOpen" size={14} /> 다른 곳에 저장…
              </button>
            ) : null}
          </span>
        </footer>
      </div>
    </div>
  );
}

/** The start dialog and "주고받은 내용", when one is open (state kept by `useLinkApi`). */
export function LinkLayer({ api, inDesktop }: { api: Api; inDesktop: boolean }) {
  const links = useLinks();
  return (
    <>
      {links.dialog ? <LinkDialog state={links.state} initial={links.dialog.sessionIds} initialGoal={links.dialog.goal} onStart={links.start} onClose={links.closeDialog} /> : null}
      {links.view ? <LinkView api={api} linkId={links.view} inDesktop={inDesktop} onClose={links.closeView} /> : null}
    </>
  );
}
