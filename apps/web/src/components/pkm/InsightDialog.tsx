import { useEffect, useState } from "react";
import { PROVIDER_LABEL, type InsightDraft } from "@workbench/contracts";
import { newRequestId } from "../../format.ts";
import { Icon } from "../Icon.tsx";
import { usePkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

/**
 * "인사이트 초안" review: the draft (vault template keys spelled exactly, DIKM empty) can be edited
 * here; it is checked as it is typed, and "발행 요청" asks the session's own engine to publish it
 * through its Achmage MCP tools. Workbench itself writes nothing into the vault.
 */
export function InsightDialog({ sessionId }: { sessionId: string }) {
  const pkm = usePkm();
  const session = pkm.state.sessions[sessionId];
  const [draft, setDraft] = useState<InsightDraft | null>(null);
  const [text, setText] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => pkm.setDialog(null);

  useEffect(() => {
    void pkm.client
      .insight(sessionId)
      .then((next) => {
        setDraft(next);
        setText(next.text);
        setProblems(next.problems);
      })
      .catch((reason: Error) => setError(reason.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Checked as it is edited: the template keys must stay as they are and DIKM empty.
  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () =>
        void pkm.client
          .checkInsight(sessionId, text)
          .then((result) => !cancelled && setProblems(result.problems))
          .catch(() => undefined),
      250,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pkm.client, sessionId, text, draft]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !(event.target as HTMLElement).closest("textarea") && pkm.setDialog(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pkm]);

  const publish = async () => {
    setBusy(true);
    try {
      await pkm.client.publishInsight(sessionId, text, newRequestId());
      close();
      const work = session ? pkm.state.works[session.workId] : undefined;
      if (session && work) pkm.showSession(work, session);
      pkm.onToast("발행을 엔진에 맡겼습니다. 결과는 대화에 남습니다.");
    } catch (reason) {
      pkm.onToast(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="pkm-dialog insight-dialog" role="dialog" aria-label="인사이트 초안">
        <header className="pkm-dialog-head">
          <h2>인사이트 초안</h2>
          <button type="button" className="icon-button small" onClick={close} aria-label="닫기">
            <Icon name="x" size={15} />
          </button>
        </header>
        <p className="sheet-hint">
          {session ? `${session.purpose} · ${PROVIDER_LABEL[session.provider]}` : ""} — 모델 없이 대화에서 만든 초안입니다.
          {draft?.template ? ` 앞머리는 볼트 템플릿(${draft.template})의 키 그대로이고` : " 앞머리는 DIKM 템플릿 키 그대로이고"} DIKM_단계는 비워 둡니다.
        </p>
        {error ? <div className="notice notice-error">{error}</div> : null}
        {draft ? (
          <>
            <textarea className="insight-text" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} aria-label="초안" />
            {problems.length ? (
              <ul className="insight-problems" role="alert">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : (
              <div className="insight-ok">
                <Icon name="check" size={13} /> 템플릿 키 {draft.keys.length}개가 그대로이고 DIKM_단계가 비어 있습니다.
              </div>
            )}
            <p className="sheet-hint">
              발행은 이 세션의 엔진이 Achmage MCP(draft_insight → publish_insight)로 합니다. 볼트의 01. Inbox/Achmage 인사이트/에 새 파일로만 들어가고, 하루 3개까지입니다. Workbench는 볼트에 직접 쓰지 않습니다.
            </p>
            <div className="sheet-actions">
              <button type="button" className="button small" onClick={() => void navigator.clipboard?.writeText(text).then(() => pkm.onToast("초안을 복사했습니다."))}>
                복사
              </button>
              <button type="button" className="button primary small" disabled={busy || problems.length > 0} onClick={() => void publish()}>
                발행 요청
              </button>
            </div>
          </>
        ) : !error ? (
          <div className="empty-hint">초안을 만드는 중…</div>
        ) : null}
      </div>
    </div>
  );
}

/** Under the input of a finished session (with a vault attached): "인사이트 초안". */
export function InsightPill({ sessionId }: { sessionId: string | null }) {
  const pkm = usePkm();
  const session = sessionId ? pkm.state.sessions[sessionId] : undefined;
  const items = sessionId ? pkm.state.transcripts[sessionId]?.items : undefined;
  if (!session || !pkm.tree?.status.path || session.status !== "idle") return null;
  if (!items?.some((item) => item.kind === "turnEnd" && item.status === "completed")) return null;
  return (
    <button type="button" className="pkm-pill insight-pill" onClick={() => pkm.setDialog({ kind: "insight", sessionId: session.id })} title="이 세션을 DIKM 인사이트 초안으로(모델 없이)">
      <Icon name="bulb" size={13} />
      <span className="pkm-pill-label">인사이트</span>
    </button>
  );
}
