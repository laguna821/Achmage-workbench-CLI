import { useEffect, useState } from "react";
import { Icon } from "../Icon.tsx";
import { usePkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

const GROUPS: [string, string][] = [
  ["", "날짜"],
  ["DIKM_단계:", "DIKM_단계:"],
  ["engine", "엔진"],
  ["status", "상태"],
  ["kind", "종류"],
];

/**
 * A saved view: a name, a query in Notebook Navigator's syntax (plus `engine:` and `status:`), and
 * how its cards are grouped. The count of matching cards updates as the query is typed.
 */
export function ViewDialog({ id }: { id: string | null }) {
  const pkm = usePkm();
  const existing = id ? pkm.pkmState?.views.find((view) => view.id === id) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [query, setQuery] = useState(existing?.query ?? "");
  const [groupBy, setGroupBy] = useState(existing?.groupBy ?? "");
  const [preview, setPreview] = useState<{ total: number; problems: string[] } | null>(null);
  const close = () => pkm.setDialog(null);

  useEffect(() => {
    if (!query.trim()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(
      () =>
        void pkm.client
          .previewView(query, groupBy || null)
          .then((list) => !cancelled && setPreview({ total: list.total, problems: list.problems ?? [] }))
          .catch(() => undefined),
      250,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pkm.client, query, groupBy]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && pkm.setDialog(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pkm]);

  const save = async () => {
    try {
      const view = await pkm.client.saveView({ id: id ?? undefined, name, query, groupBy: groupBy || null });
      close();
      pkm.open?.({ kind: "view", id: view.id });
    } catch (error) {
      pkm.onToast(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <form
        className="pkm-dialog view-dialog"
        role="dialog"
        aria-label="보기"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="pkm-dialog-head">
          <h2>{existing ? "보기 고치기" : "새 보기"}</h2>
          <button type="button" className="icon-button small" onClick={close} aria-label="닫기">
            <Icon name="x" size={15} />
          </button>
        </header>
        <label className="sheet-label" htmlFor="view-name">
          이름
        </label>
        <input id="view-name" className="sheet-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 정보 단계 노트" />
        <label className="sheet-label" htmlFor="view-query">
          조건
        </label>
        <input id="view-query" className="sheet-input mono" value={query} onChange={(event) => setQuery(event.target.value)} placeholder='예: #AI_교육 ."DIKM_단계:"="🔵 I" @last7d' spellCheck={false} />
        <p className="sheet-hint view-syntax">
          <code>#태그</code> <code>."키"="값"</code> <code>."키"=""</code>(값 없음) <code>@today</code> <code>@last7d</code> <code>@thisweek</code> <code>engine:codex</code> <code>status:running</code>{" "}
          <code>kind:note</code> · 앞에 <code>-</code>를 붙이면 제외 · 그 밖의 낱말은 제목에서 찾습니다.
        </p>
        <label className="sheet-label" htmlFor="view-group">
          묶기
        </label>
        <select id="view-group" className="sheet-select" value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
          {GROUPS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
          {groupBy && !GROUPS.some(([value]) => value === groupBy) ? <option value={groupBy}>{groupBy}</option> : null}
        </select>
        <div className="view-preview" role="status">
          {preview ? `맞는 것 ${preview.total}개` : "조건을 적으면 맞는 개수가 보입니다."}
          {preview?.problems.length ? <span className="warn"> · 읽지 못한 조건: {preview.problems.join(" ")}</span> : null}
        </div>
        <div className="sheet-actions">
          <button type="submit" className="button primary small" disabled={!name.trim() || !query.trim()}>
            저장
          </button>
        </div>
      </form>
    </div>
  );
}
