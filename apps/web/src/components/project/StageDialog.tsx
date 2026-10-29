import { useEffect, useState } from "react";
import { DEFAULT_STAGES, type ProjectStage } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { Icon } from "../Icon.tsx";
import "../../styles/project.css";

/** Swatches offered for a stage (any `#rrggbb` can also be typed). */
const SWATCHES = ["#e5484d", "#f76b15", "#e2a400", "#30a46c", "#12a594", "#3e63dd", "#8e4ec6", "#d6409f", "#8b8d98"];

/**
 * "단계 이름·색 바꾸기": the stages every project chooses from. Notes keep the names they were
 * written with; one stage may archive the project (앱 보관함).
 */
export function StageDialog({ api, stages, onClose, onSaved, onError }: { api: Api; stages: ProjectStage[]; onClose: () => void; onSaved: (stages: ProjectStage[]) => void; onError: (error: unknown) => void }) {
  const [list, setList] = useState<ProjectStage[]>(stages.map((stage) => ({ ...stage })));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const patch = (index: number, change: Partial<ProjectStage>) => setList((current) => current.map((stage, at) => (at === index ? { ...stage, ...change } : change.archive ? { ...stage, archive: false } : stage)));
  const move = (index: number, by: number) =>
    setList((current) => {
      const next = [...current];
      const [stage] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, stage!);
      return next;
    });
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.setProjectStages(list.map((stage) => ({ name: stage.name.trim(), color: stage.color, ...(stage.archive ? { archive: true } : {}) }))));
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="stage-dialog" role="dialog" aria-label="단계 이름·색 바꾸기">
        <h2>단계 이름·색</h2>
        <p className="muted">모든 프로젝트가 고르는 단계입니다. 이미 노트에 적힌 이름은 그대로 남습니다. "보관" 표시가 있는 단계를 고르면 프로젝트가 보관함으로 갑니다.</p>
        <ol className="stage-rows">
          {list.map((stage, index) => (
            <li key={index} className="stage-row">
              <span className="stage-swatch" style={{ background: stage.color }} aria-hidden />
              <input className="stage-name" value={stage.name} aria-label={`${index + 1}번째 단계 이름`} onChange={(event) => patch(index, { name: event.target.value })} />
              <span className="stage-colors" role="radiogroup" aria-label="색">
                {SWATCHES.map((color) => (
                  <button key={color} type="button" role="radio" aria-checked={stage.color === color} aria-label={color} className={`stage-color${stage.color === color ? " on" : ""}`} style={{ background: color }} onClick={() => patch(index, { color })} />
                ))}
                <input className="stage-hex" value={stage.color} aria-label="색 값" onChange={(event) => /^#[0-9a-fA-F]{0,6}$/.test(event.target.value) && patch(index, { color: event.target.value })} />
              </span>
              <label className="stage-archive" title="이 단계를 고르면 프로젝트를 보관합니다">
                <input type="radio" name="archive-stage" checked={Boolean(stage.archive)} onChange={() => patch(index, { archive: true })} /> 보관
              </label>
              <span className="stage-tools">
                <button type="button" className="icon-button small" aria-label="위로" disabled={index === 0} onClick={() => move(index, -1)}>
                  <Icon name="chevronUp" size={13} />
                </button>
                <button type="button" className="icon-button small" aria-label="아래로" disabled={index === list.length - 1} onClick={() => move(index, 1)}>
                  <Icon name="chevronDown" size={13} />
                </button>
                <button type="button" className="icon-button small" aria-label="지우기" disabled={list.length === 1} onClick={() => setList((current) => current.filter((_, at) => at !== index))}>
                  <Icon name="x" size={13} />
                </button>
              </span>
            </li>
          ))}
        </ol>
        <div className="stage-foot">
          <button type="button" className="button small" onClick={() => setList((current) => [...current, { name: "", color: "#8b8d98" }])}>
            + 단계
          </button>
          <button type="button" className="button small" onClick={() => setList(DEFAULT_STAGES.map((stage) => ({ ...stage })))}>
            기본값으로
          </button>
          <span className="stage-spacer" />
          <button type="button" className="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="button primary" disabled={busy || list.some((stage) => !stage.name.trim() || !/^#[0-9a-fA-F]{6}$/.test(stage.color))} onClick={() => void save()}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
