import { useEffect, useRef, useState } from "react";
import { PROPERTY_TYPES, STAGE_KEY, type PropertyField, type PropertyType } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { Icon } from "../Icon.tsx";
import { keyLabel } from "./PropertiesPanel.tsx";

/**
 * "속성 템플릿": the properties every project shows from the start (a name, a kind, a hint), so a
 * new project only needs its values typed. Edited here, or taken from a Markdown file's front
 * matter (the user's own note template); "기본값으로" goes back to the app's.
 */
export function TemplateDialog({ api, onClose, onSaved, onError }: { api: Api; onClose: () => void; onSaved: () => void; onError: (error: unknown) => void }) {
  const [fields, setFields] = useState<PropertyField[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.propertyTemplate().then(setFields, onError);
  }, [api, onError]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const change = (index: number, patch: Partial<PropertyField>) => setFields((current) => current && current.map((field, at) => (at === index ? { ...field, ...patch } : field)));
  const move = (index: number, by: number) =>
    setFields((current) => {
      if (!current) return current;
      const next = [...current];
      const [field] = next.splice(index, 1);
      next.splice(Math.max(0, Math.min(next.length, index + by)), 0, field!);
      return next;
    });

  const save = async (reset: boolean) => {
    setBusy(true);
    try {
      const saved = await api.savePropertyTemplate(reset ? null : (fields ?? []).filter((field) => field.key.trim()));
      setFields(saved);
      onSaved();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const fromFile = async (picked: File | undefined) => {
    if (!picked) return;
    try {
      const imported = await api.importPropertyTemplate(await picked.text());
      // The stage stays first: it is the project's own.
      const stage = imported.some((field) => field.key === STAGE_KEY) ? [] : [{ key: STAGE_KEY, type: "stage" as PropertyType }];
      setFields([...stage, ...imported]);
      setNotice(`「${picked.name}」의 속성 ${imported.length}개를 가져왔습니다. 형식을 확인하고 저장하세요.`);
    } catch (error) {
      onError(error);
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="stage-dialog template-dialog" role="dialog" aria-label="속성 템플릿">
        <header className="template-head">
          <h2>속성 템플릿</h2>
          <button type="button" className="icon-button small" onClick={onClose} aria-label="닫기">
            <Icon name="x" size={15} />
          </button>
        </header>
        <p className="sheet-hint">모든 프로젝트의 속성 칸에 처음부터 보이는 목록입니다. 프로젝트마다 값만 채우면 됩니다. 값을 채우기 전에는 노트에 쓰지 않습니다.</p>
        {notice ? <div className="notice compact">{notice}</div> : null}
        {fields ? (
          <ol className="template-fields">
            {fields.map((field, index) => (
              <li key={index} className="template-field">
                <span className="template-order">
                  <button type="button" className="icon-button small" title="위로" disabled={index === 0} onClick={() => move(index, -1)}>
                    <Icon name="chevronUp" size={13} />
                  </button>
                  <button type="button" className="icon-button small" title="아래로" disabled={index === fields.length - 1} onClick={() => move(index, 1)}>
                    <Icon name="chevronDown" size={13} />
                  </button>
                </span>
                <input
                  className="sheet-input template-key"
                  value={field.key}
                  aria-label="속성 이름"
                  placeholder="속성 이름"
                  disabled={field.type === "stage"}
                  title={field.key !== keyLabel(field.key) ? `노트에는 ${field.key}로 씁니다` : undefined}
                  onChange={(event) => change(index, { key: event.target.value })}
                />
                <select className="sheet-select" aria-label="형식" value={field.type} disabled={field.type === "stage"} onChange={(event) => change(index, { type: event.target.value as PropertyType })}>
                  {PROPERTY_TYPES.filter((entry) => entry.type !== "stage" || field.type === "stage").map((entry) => (
                    <option key={entry.type} value={entry.type}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <input className="sheet-input template-hint" value={field.hint ?? ""} aria-label="빈 칸에 보일 안내" placeholder="빈 칸에 보일 안내 (선택)" onChange={(event) => change(index, { hint: event.target.value })} />
                <button type="button" className="icon-button small" title="빼기" aria-label={`${field.key} 빼기`} onClick={() => setFields(fields.filter((_, at) => at !== index))}>
                  <Icon name="x" size={13} />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="muted">불러오는 중…</div>
        )}
        <div className="template-tools">
          <button type="button" className="ghost-button small" onClick={() => setFields([...(fields ?? []), { key: "", type: "text" }])}>
            <Icon name="plus" size={13} /> 속성 추가
          </button>
          <button type="button" className="ghost-button small" onClick={() => file.current?.click()} title="노트 템플릿 MD 파일의 맨 위 속성(YAML)으로 목록을 만듭니다">
            <Icon name="download" size={13} /> MD 파일에서 가져오기
          </button>
          <input ref={file} type="file" accept=".md,.markdown,text/markdown,text/plain" hidden onChange={(event) => void fromFile(event.target.files?.[0])} />
        </div>
        <div className="stage-foot">
          <button type="button" className="button small" disabled={busy} onClick={() => void save(true)}>
            기본값으로
          </button>
          <span className="stage-spacer" />
          <button type="button" className="button small" onClick={onClose}>
            그만두기
          </button>
          <button type="button" className="button small primary" disabled={busy || !fields} onClick={() => void save(false)}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
