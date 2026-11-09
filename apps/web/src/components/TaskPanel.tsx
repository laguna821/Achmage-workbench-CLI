import { useCallback, useEffect, useRef, useState } from "react";
import { TASK_STATE_LABEL, type CommandReceipt, type TaskCommandKind, type TaskSummary } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";
import "../styles/tasks.css";

/** The same host-owned work remains active when its document or session tab is hidden. */
export function TaskPanel({ api, workId, onOpen, onClose }: {
  api: Api; workId?: string; onOpen(sessionId: string, itemId?: string): void; onClose(): void;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeOnly, setActiveOnly] = useState(false);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    const next = await api.tasks(workId); setTasks(next.tasks); setLoading(false); return next;
  }, [api, workId]);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    let closeEvents = () => {}, epoch: string | null = null;
    const load = async () => {
      try {
        const next = await api.tasks(workId);
        if (!alive) return;
        setTasks(next.tasks); setLoading(false);
        if (epoch !== next.epoch) {
          epoch = next.epoch; closeEvents();
          closeEvents = api.events(next.seq, event => {
            if (event.type === "item.delta" || event.type === "provider.status") return;
            if (event.type === "item.upserted" || event.type === "session.upserted" || event.type === "work.removed") schedule();
          }, () => { epoch = null; schedule(); }, connected => { if (connected) schedule(); });
        }
      } catch (error) { if (alive) { setProblem(String(error)); setLoading(false); } }
    };
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, 200); };
    void load();
    return () => { alive = false; clearTimeout(timer); closeEvents(); };
  }, [api, workId]);
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => { if (origin?.isConnected) origin.focus(); };
  }, []);
  const command = async (task: TaskSummary, kind: TaskCommandKind, queuedId?: string) => {
    const commandId = crypto.randomUUID();
    setBusy(task.runId); setProblem(null); setReceipt(null);
    try {
      let result: CommandReceipt;
      try { result = await api.taskCommand({ commandId, target: task, kind, ...(queuedId ? { queuedId } : {}) }); }
      catch (error) {
        // The network reply can be lost after execution. Look up the same ID; do not resend.
        result = await api.taskReceipt(commandId).catch(() => { throw error; });
      }
      setReceipt(result);
      if (result.status === "rejected" || result.status === "outcome_unknown") setProblem(result.detail ?? "명령 결과를 확인하세요.");
      await refresh();
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };
  const active = (task: TaskSummary) => ["queued", "running", "waiting_input", "outcome_unknown"].includes(task.state);
  const shown = tasks.filter(task => !activeOnly || active(task));
  return <div className="task-panel-backdrop" onPointerDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="task-panel" role="dialog" aria-modal="true" aria-labelledby="task-panel-title" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><h2 id="task-panel-title">{workId ? "프로젝트의 작업" : "모든 작업"}</h2><p>진행·대기 {tasks.filter(active).length}개 · 탭을 옮겨도 작업은 이어집니다.</p></div>
        <button ref={closeButton} className="icon-button" type="button" aria-label="작업 목록 닫기" onClick={onClose}><Icon name="x" /></button></header>
      <div className="task-panel-filter"><label><input type="checkbox" checked={activeOnly} onChange={event => setActiveOnly(event.target.checked)} /> 진행·대기 작업만</label>
        <button type="button" className="ghost-button small" onClick={() => { void refresh().catch(error => setProblem(String(error))); }}>새로고침</button></div>
      {problem ? <div className="task-panel-error" role="alert">{problem}</div> : null}
      {receipt?.status === "completed" ? <p className="task-panel-receipt" role="status">명령을 처리했습니다.</p> : null}
      <div className="task-panel-list" aria-busy={loading}>
        {!shown.length ? <p className="task-panel-empty">{loading ? "작업을 불러오는 중…" : "표시할 작업이 없습니다. 세션이나 문서의 AI에서 요청을 시작하세요."}</p> : null}
        {shown.map(task => <article className={`task-row${task.parentSessionId ? " task-child" : ""}`} data-task-state={task.state} key={task.runId}>
          <div className="task-row-head"><span className="task-kind">{task.executorKind === "office" ? "문서 AI" : task.executorKind === "native_agent" ? "하위 에이전트" : "세션"}</span>
            <span className="task-state">{TASK_STATE_LABEL[task.state]}</span></div>
          <button type="button" className="task-title" onClick={() => onOpen(task.sessionId, task.sourceItemId ?? undefined)}>{task.title}</button>
          <p>{task.activity ?? task.preview ?? ""}</p>
          <div className="task-row-foot"><span>{task.provider === "codex" ? "Codex" : "Claude"}{task.parentSessionId ? " · 부모 세션에 연결됨" : ""}</span>
            <div>{task.approvalIds.length ? <button type="button" className="ghost-button small" onClick={() => onOpen(task.sessionId, task.approvalIds[0])}>요청 확인</button> : null}
              {task.state === "queued" && task.capabilities.queue && task.requestId ? <><button type="button" className="ghost-button small" disabled={busy === task.runId} onClick={() => void command(task, "send_queue", task.requestId!)}>지금 보내기</button>
                <button type="button" className="ghost-button small" disabled={busy === task.runId} onClick={() => void command(task, "cancel_queue", task.requestId!)}>대기 취소</button></> : null}
              {task.capabilities.stop ? <button type="button" className="ghost-button small" disabled={busy === task.runId} onClick={() => void command(task, "stop")}>멈추기</button> : null}
              <button type="button" className="ghost-button small" onClick={() => onOpen(task.sessionId, task.sourceItemId ?? undefined)}>대화 열기</button></div></div>
        </article>)}
      </div>
    </section>
  </div>;
}
