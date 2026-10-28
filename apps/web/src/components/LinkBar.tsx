import { LINK_REASON_LABEL, type Session } from "@workbench/contracts";
import { durationText, goalLine, hopsText, linkOfSession, participantName, useLinks, useNow } from "../links.ts";
import { accentStyle, useAppearance } from "../appearance.ts";
import { EngineMark } from "./EngineMark.tsx";
import "../styles/links.css";

/**
 * Above the waiting requests of a session in a link: "⇄ 3/6 · 12분 · 목표 …" with 멈춤 / 이어 가기,
 * 끊기, +1왕복 and what was exchanged so far. Only while the link is live; its end is a card in the
 * conversation.
 */
export function LinkBar({ session }: { session: Session }) {
  const links = useLinks();
  const { lookOf } = useAppearance();
  const link = linkOfSession(links.state, session.id);
  const now = useNow(link?.state === "active" ? 10_000 : null);
  if (!link) return null;
  const active = link.state === "active";
  const speaker = links.state.sessions[link.participants[link.turn]!];
  const speaking = active && speaker && speaker.status !== "idle" && speaker.status !== "error";
  const others = link.participants.filter((id) => id !== session.id).map((id) => links.state.sessions[id]);
  return (
    <div className={`linked-bar${active ? "" : " paused"}`} role="group" aria-label="세션 잇기">
      <span className="linked-bar-count" title="주고받은 수 / 정한 수">
        <span aria-hidden>⇄</span> {hopsText(link)}
      </span>
      <span className="linked-bar-info">
        <span className="linked-bar-time" title={`정한 시간 ${link.maxMinutes}분 · 멈춘 동안과 승인을 기다리는 동안은 세지 않습니다`}>
          {durationText(link, now)}
          <span className="muted">/{link.maxMinutes}분</span>
        </span>
        <span className="linked-bar-sep">·</span>
        {active ? (
          <span className="linked-bar-who" style={speaker ? accentStyle(lookOf(speaker.provider)) : undefined}>
            {speaker ? <EngineMark provider={speaker.provider} size={13} /> : null}
            {speaker?.id === session.id ? "이 세션" : participantName(speaker)} {speaking ? "답하는 중" : "차례"}
          </span>
        ) : (
          <span className="linked-bar-who paused">{link.reason ? LINK_REASON_LABEL[link.reason] : "멈춤"}</span>
        )}
        <span className="linked-bar-sep">·</span>
        <span className="linked-bar-goal" title={`목표: ${link.goal}\n상대: ${others.map(participantName).join(", ")}`}>
          목표 {goalLine(link.goal)}
        </span>
      </span>
      <span className="linked-bar-actions">
        {active ? (
          <button type="button" className="link" onClick={() => links.pause(link)} title="하던 답은 끝내고, 다음 세션에 넘기지 않습니다">
            멈춤
          </button>
        ) : (
          <button type="button" className="link" onClick={() => links.resume(link)} title="멈춘 곳에서 이어서 주고받습니다">
            이어 가기
          </button>
        )}
        <button type="button" className="link danger" onClick={() => links.stop(link)} title="잇기를 끝내고, 잇기가 시작한 답도 멈춥니다">
          끊기
        </button>
        <button type="button" className="link" onClick={() => links.extend(link)} title="한 번씩 더 주고받고, 그만큼 시간도 늘립니다">
          +1왕복
        </button>
        <button type="button" className="link" onClick={() => links.openView(link.id)}>
          주고받은 내용
        </button>
      </span>
    </div>
  );
}
