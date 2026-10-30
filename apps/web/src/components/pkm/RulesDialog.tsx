import { useEffect, useState } from "react";
import { DISK_FOLDER, FORMAT_LABEL, PROVIDER_LABEL, type DocFormat, type PkmRule, type ProjectStage, type RuleChange } from "@workbench/contracts";
import { Icon } from "../Icon.tsx";
import { usePkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

const FORMATS: DocFormat[] = ["markdown", "hwpx", "docx", "pptx", "xlsx", "pdf", "html", "design", "xmind", "epub"];

const BLANK: PkmRule = { id: "", name: "", enabled: true, when: { cwdPrefix: null, engine: null, format: null }, then: { folder: null, tag: null, pin: false } };

/** The default set: every work goes to an app folder named after the folder its own folder is in. */
export const DISK_RULE: PkmRule = { id: "disk", name: "디스크 위치대로", enabled: true, when: { cwdPrefix: null, engine: null, format: null }, then: { folder: DISK_FOLDER, tag: null, pin: false } };

/** A rule in words: "조건 → 배치". */
export function ruleText(rule: PkmRule) {
  const when = [
    rule.when.cwdPrefix ? `폴더 ${rule.when.cwdPrefix} 안` : null,
    rule.when.engine ? PROVIDER_LABEL[rule.when.engine] : null,
    rule.when.format ? `${FORMAT_LABEL[rule.when.format]} 문서` : null,
  ].filter(Boolean);
  const then = [
    rule.then.folder === DISK_FOLDER ? "디스크 위치대로 폴더" : rule.then.folder ? `폴더 「${rule.then.folder}」` : null,
    rule.then.tag ? `#${rule.then.tag}` : null,
    rule.then.pin ? "고정" : null,
    rule.then.stage ? `단계 「${rule.then.stage}」` : null,
  ].filter(Boolean);
  return `${when.length ? when.join(" · ") : "모든 새 작업"} → ${then.length ? then.join(" · ") : "그대로"}`;
}

/**
 * "자동 정리 규칙": an ordered list of 조건 → 배치 for new works, the first that matches decides (no
 * model). Saved rules apply to works made afterwards; works that already exist move only after
 * "미리보기", for the ones ticked, with "적용".
 */
export function RulesDialog() {
  const pkm = usePkm();
  const [rules, setRules] = useState<PkmRule[]>(pkm.pkmState?.rules ?? []);
  const [draft, setDraft] = useState<PkmRule>(BLANK);
  const [changes, setChanges] = useState<RuleChange[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // The projects' stages a rule can fill (the archive stage is not one: it would archive new works).
  const [stages, setStages] = useState<ProjectStage[]>([]);
  useEffect(() => {
    pkm.api.projectStages().then((list) => setStages(list.filter((stage) => !stage.archive)), () => undefined);
  }, [pkm.api]);
  const close = () => pkm.setDialog(null);
  const fail = (error: unknown) => pkm.onToast(error instanceof Error ? error.message : String(error));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && pkm.setDialog(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pkm]);

  const save = async (next: PkmRule[]) => {
    setRules(next);
    setChanges(null);
    try {
      setRules(await pkm.client.saveRules(next));
    } catch (error) {
      fail(error);
    }
  };

  const move = (index: number, step: -1 | 1) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(index + step, 0, rule!);
    void save(next);
  };

  const addDraft = () => {
    const rule: PkmRule = { ...draft, id: draft.id || `rule-${Date.now()}`, name: draft.name.trim() || ruleText(draft) };
    const exists = rules.some((entry) => entry.id === rule.id);
    void save(exists ? rules.map((entry) => (entry.id === rule.id ? rule : entry)) : [...rules, rule]);
    setDraft(BLANK);
  };

  const preview = async () => {
    setBusy(true);
    try {
      const list = await pkm.client.previewRules();
      setChanges(list);
      setTicked(new Set(list.filter((change) => change.suggested).map((change) => change.workId)));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const { applied } = await pkm.client.applyRules([...ticked]);
      pkm.onToast(`작업 ${applied}개를 규칙대로 옮겼습니다.`);
      setChanges(null);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const setWhen = (patch: Partial<PkmRule["when"]>) => setDraft((current) => ({ ...current, when: { ...current.when, ...patch } }));
  const setThen = (patch: Partial<PkmRule["then"]>) => setDraft((current) => ({ ...current, then: { ...current.then, ...patch } }));

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="pkm-dialog rules-dialog" role="dialog" aria-label="자동 정리 규칙">
        <header className="pkm-dialog-head">
          <h2>자동 정리 규칙</h2>
          <button type="button" className="icon-button small" onClick={close} aria-label="닫기">
            <Icon name="x" size={15} />
          </button>
        </header>
        <p className="sheet-hint">새 작업은 위에서부터 처음 맞는 규칙 하나로 자리를 잡습니다(AI 없이). 이미 있는 작업은 "미리보기"에서 골라 "적용"할 때만 옮깁니다.</p>
        <ol className="rule-list">
          {rules.map((rule, index) => (
            <li key={rule.id} className={`rule-row${rule.enabled ? "" : " off"}`}>
              <input type="checkbox" checked={rule.enabled} aria-label="켜기" onChange={(event) => void save(rules.map((entry) => (entry.id === rule.id ? { ...entry, enabled: event.target.checked } : entry)))} />
              <span className="rule-text">
                <strong>{rule.name}</strong>
                <span className="muted">{ruleText(rule)}</span>
              </span>
              <span className="rule-tools">
                <button type="button" className="icon-button small" title="위로" disabled={index === 0} onClick={() => move(index, -1)}>
                  <Icon name="chevronUp" size={13} />
                </button>
                <button type="button" className="icon-button small" title="아래로" disabled={index === rules.length - 1} onClick={() => move(index, 1)}>
                  <Icon name="chevronDown" size={13} />
                </button>
                <button type="button" className="icon-button small" title="고치기" onClick={() => setDraft(rule)}>
                  <Icon name="edit" size={13} />
                </button>
                <button type="button" className="icon-button small" title="지우기" onClick={() => void save(rules.filter((entry) => entry.id !== rule.id))}>
                  <Icon name="x" size={13} />
                </button>
              </span>
            </li>
          ))}
          {!rules.length ? <li className="muted rule-empty">아직 규칙이 없습니다.</li> : null}
        </ol>
        {!rules.some((rule) => rule.then.folder === DISK_FOLDER) ? (
          <button type="button" className="ghost-button small rule-preset" onClick={() => void save([...rules, DISK_RULE])}>
            <Icon name="plus" size={13} /> 기본 묶음 「디스크 위치대로」 넣기 · 작업 폴더가 있는 폴더 이름으로 분류
          </button>
        ) : null}
        <fieldset className="rule-form">
          <legend className="sheet-label">{draft.id ? "규칙 고치기" : "규칙 추가"}</legend>
          <div className="rule-grid">
            <label htmlFor="rule-name">이름</label>
            <input id="rule-name" className="sheet-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="비워 두면 조건으로 이름을 짓습니다" />
            <label htmlFor="rule-cwd">작업 폴더가</label>
            <input id="rule-cwd" className="sheet-input mono" value={draft.when.cwdPrefix ?? ""} onChange={(event) => setWhen({ cwdPrefix: event.target.value || null })} placeholder="~/강의 (그 안의 작업)" spellCheck={false} />
            <label htmlFor="rule-engine">엔진</label>
            <select id="rule-engine" className="sheet-select" value={draft.when.engine ?? ""} onChange={(event) => setWhen({ engine: (event.target.value || null) as PkmRule["when"]["engine"] })}>
              <option value="">모두</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            <label htmlFor="rule-format">문서 형식</label>
            <select id="rule-format" className="sheet-select" value={draft.when.format ?? ""} onChange={(event) => setWhen({ format: (event.target.value || null) as DocFormat | null })}>
              <option value="">모두</option>
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {FORMAT_LABEL[format]}
                </option>
              ))}
            </select>
            <label htmlFor="rule-folder">→ 앱 폴더</label>
            <span className="rule-folder">
              <input id="rule-folder" className="sheet-input" value={draft.then.folder === DISK_FOLDER ? "" : (draft.then.folder ?? "")} disabled={draft.then.folder === DISK_FOLDER} onChange={(event) => setThen({ folder: event.target.value || null })} placeholder="강의/2026 (없으면 만듭니다)" />
              <label className="check-row">
                <input type="checkbox" checked={draft.then.folder === DISK_FOLDER} onChange={(event) => setThen({ folder: event.target.checked ? DISK_FOLDER : null })} />
                디스크 위치대로
              </label>
            </span>
            <label htmlFor="rule-tag">→ 태그</label>
            <input id="rule-tag" className="sheet-input" value={draft.then.tag ?? ""} onChange={(event) => setThen({ tag: event.target.value || null })} placeholder="수업" />
            <label htmlFor="rule-stage">→ 단계</label>
            <select id="rule-stage" className="sheet-select" value={draft.then.stage ?? ""} onChange={(event) => setThen({ stage: event.target.value || null })} title="프로젝트에 단계가 없을 때만 채웁니다">
              <option value="">그대로</option>
              {stages.map((stage) => (
                <option key={stage.name} value={stage.name}>
                  {stage.name} (비어 있을 때)
                </option>
              ))}
            </select>
            <span />
            <label className="check-row">
              <input type="checkbox" checked={draft.then.pin} onChange={(event) => setThen({ pin: event.target.checked })} />
              고정
            </label>
          </div>
          <div className="sheet-actions">
            {draft.id ? (
              <button type="button" className="button small" onClick={() => setDraft(BLANK)}>
                그만두기
              </button>
            ) : null}
            <button type="button" className="button small" disabled={!draft.then.folder && !draft.then.tag && !draft.then.pin && !draft.then.stage} onClick={addDraft}>
              {draft.id ? "규칙 바꾸기" : "규칙 추가"}
            </button>
          </div>
        </fieldset>
        <div className="rule-preview">
          <button type="button" className="button small" disabled={busy || !rules.length} onClick={() => void preview()}>
            미리보기
          </button>
          {changes ? <span className="muted">{changes.length ? `바뀔 작업 ${changes.length}개 · 고른 것만 옮깁니다` : "규칙대로 바뀔 작업이 없습니다."}</span> : null}
        </div>
        {changes?.length ? (
          <>
            <ul className="change-list">
              {changes.map((change) => (
                <li key={change.workId}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={ticked.has(change.workId)}
                      onChange={(event) => {
                        const next = new Set(ticked);
                        if (event.target.checked) next.add(change.workId);
                        else next.delete(change.workId);
                        setTicked(next);
                      }}
                    />
                    <span className="change-title">{change.title}</span>
                    <span className="muted">
                      {change.from ?? "분류 없음"} → {change.to ?? "분류 없음"}
                      {change.tag ? ` · #${change.tag}` : ""}
                      {change.pin ? " · 고정" : ""}
                      {change.stage ? ` · 단계 ${change.stage}` : ""} · 「{change.ruleName}」
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="sheet-actions">
              <button type="button" className="button primary small" disabled={busy || !ticked.size} onClick={() => void apply()}>
                적용 ({ticked.size})
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
