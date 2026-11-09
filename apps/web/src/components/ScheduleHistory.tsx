import { useEffect, useState } from "react";
import type { Schedule, ScheduleOccurrence } from "@workbench/contracts";
import type { Api } from "../api.ts";

const labels: Record<ScheduleOccurrence["status"], string> = { accepted: "전달 중", submitted: "대화에 전달됨", rejected: "접수 거부", outcome_unknown: "전달 결과 확인 필요", skipped: "건너뜀" };
export function ScheduleHistory({ api, schedule, onError, onOpenSession }: { api: Api; schedule: Schedule; onError: (error: unknown) => void; onOpenSession?: (id: string) => void }) {
  const [rows, setRows] = useState<ScheduleOccurrence[]>([]), [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void api.scheduleHistory(schedule.id).then(result => { if (live) setRows(result.occurrences); }).catch(onError); return () => { live = false; }; }, [api, schedule, onError]);
  return <div className="schedule-history">
    {rows.length ? rows.slice(0, 20).map(row => <div key={row.id} className="schedule-history-row">
      <span>{new Date(row.dueAt).toLocaleString("ko-KR")} · {labels[row.status]}</span>
      <span className="muted">{row.detail}</span>
      {row.receipt?.sessionId && onOpenSession ? <button type="button" className="text-button" onClick={() => onOpenSession(row.receipt!.sessionId)}>대화로 이동</button> : null}
      {row.status === "outcome_unknown" || row.status === "accepted" ? <button type="button" className="text-button" disabled={busy} onClick={() => {
        setBusy(true); void api.reconcileSchedule(schedule.id, row.id).then(next => setRows(rows => rows.map(entry => entry.id === next.id ? next : entry))).catch(onError).finally(() => setBusy(false));
      }}>전달 상태 확인</button> : null}
      {row.status === "outcome_unknown" || row.status === "rejected" ? <button type="button" className="text-button" disabled={busy} onClick={() => {
        setBusy(true); void api.createSchedule({ sessionId: schedule.sessionId, text: schedule.text, when: { kind: "once", at: Date.now() + 1000 },
          policy: { ...schedule.policy, expiresAt: null, maxRuns: 1 } }).catch(onError).finally(() => setBusy(false));
      }}>별도 새 요청 예약</button> : null}
    </div>) : <span className="muted">아직 실행 기록이 없습니다.</span>}
    <p className="muted">‘대화에 전달됨’은 요청 접수 상태입니다. AI 응답 결과는 해당 대화에서 확인합니다.</p>
  </div>;
}
