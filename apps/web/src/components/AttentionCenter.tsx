import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ATTENTION_LABEL, type AttentionKind } from "@workbench/contracts";
import type { AttentionInbox } from "../completion-notifications.ts";
import type { State } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "../styles/attention.css";

const kindLabel: Record<AttentionKind, string> = { completed: "완료", failed: "실패", input_needed: "입력 필요" };
export function AttentionCenter({ inbox, state, onOpen, onClose }: {
  inbox: AttentionInbox; state: Pick<State, "sessions" | "works">; onOpen: (id: string) => Promise<void>; onClose: () => void;
}) {
  const feed = useSyncExternalStore(inbox.subscribe, inbox.getState);
  const [unreadOnly, setUnreadOnly] = useState(false), [busy, setBusy] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement), working = useRef(false);
  useLayoutEffect(() => { const surface = dialog.current; surface?.showModal(); return () => restoreSurfaceFocus(opener.current, surface); }, []);
  const act = async (id: string, action: () => Promise<void>) => {
    if (working.current) return; working.current = true; setBusy(id); inbox.clearError();
    try { await action(); } catch (error) { inbox.reportError(error); }
    finally { working.current = false; setBusy(null); }
  };
  const shown = feed.list.events.filter(entry => !unreadOnly || entry.readAt === null);
  return <dialog ref={dialog} className="attention-center" aria-labelledby="attention-center-title" onCancel={event => { event.stopPropagation(); onClose(); }}>
    <header><div><h2 id="attention-center-title">알림</h2><p aria-live="polite">읽지 않음 {feed.list.unread}개</p></div><button type="button" className="icon-button" aria-label="알림 닫기" onClick={onClose}><Icon name="x" /></button></header>
    <div className="attention-center-filter"><label><input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} /> 읽지 않은 알림만</label><button type="button" className="ghost-button small" disabled={feed.loading || feed.supported !== true} onClick={() => void inbox.refresh()}>새로고침</button></div>
    {feed.error ? <div className="attention-center-error" role="alert">{feed.error}<button type="button" className="text-button" onClick={inbox.clearError}>닫기</button></div> : null}
    <div className="attention-center-list" aria-busy={feed.loading}>
      {feed.supported === false ? <p className="attention-center-empty">이 호스트는 알림 목록을 지원하지 않습니다. 기존 완료·확인 알림은 계속 사용할 수 있습니다.</p> : feed.supported === null ? <p className="attention-center-empty">호스트의 알림을 불러오는 중…</p> : !shown.length ? <p className="attention-center-empty">{unreadOnly ? "읽지 않은 알림이 없습니다." : "아직 알림이 없습니다."}</p> : null}
      {shown.map(entry => {
        const session = state.sessions[entry.taskRef.sessionId], work = state.works[entry.workId];
        return <article className={`attention-entry${entry.readAt === null ? " unread" : ""}`} key={entry.id} aria-label={`${kindLabel[entry.kind]} 알림`} data-kind={entry.kind}>
          <div className="attention-entry-head"><span>{kindLabel[entry.kind]}</span><span>{entry.readAt === null ? "읽지 않음" : "읽음"}{entry.kind === "input_needed" && entry.resolvedAt !== null ? " · 처리됨" : ""}</span></div>
          <p>{ATTENTION_LABEL[entry.kind]}</p>
          <div className="attention-entry-title">{work?.title ?? "프로젝트"}{session ? ` · ${session.purpose}` : " · 이전 대화"}</div>
          <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString()}</time>
          {entry.deliveryError ? <details className="attention-delivery"><summary>시스템 알림 전달 상태</summary>{entry.deliveryError}</details> : null}
          <div className="attention-entry-actions"><button type="button" className="button small" disabled={busy !== null} onClick={() => void act(entry.id, () => onOpen(entry.id))}>{busy === entry.id ? "처리 중…" : "원문 열기"}</button>
            {entry.readAt === null ? <button type="button" className="ghost-button small" disabled={busy !== null} onClick={() => void act(entry.id, () => inbox.read(entry.id))}>읽음 표시</button> : null}
          </div>
        </article>;
      })}
    </div>
    <footer>읽음 표시는 실행 승인이나 요청 취소가 아닙니다. 필요한 응답은 원문에서 선택합니다.</footer>
  </dialog>;
}
