import { useState } from "react";
import type { OfficeInteractionResponse, TranscriptItem } from "@workbench/contracts";

type Approval = Extract<TranscriptItem, { kind: "approval" }>;
export function OfficeQuestion({ item, onAnswer }: { item: Approval; onAnswer: (decision: "accept" | "decline", response?: OfficeInteractionResponse) => void }) {
  const [answers, setAnswers] = useState<OfficeInteractionResponse>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const request = item.officeInteraction!;
  if (item.decision !== null) return <div className="approval-done">
    <strong>{item.title}</strong>
    <span>{item.decision === "accept" ? "답변함" : item.decision === "decline" ? "취소함" : "요청이 끝남"}</span>
    {request.response ? <dl>{request.fields.map(field => <div key={field.id}><dt>{field.prompt}</dt><dd>{[request.response![field.id]].flat().map(value => field.options?.find(option => option.id === value)?.label ?? value).join(", ")}</dd></div>)}</dl> : null}
  </div>;
  const response = Object.fromEntries(request.fields.map(field => {
    const value = answers[field.id] ?? (field.multiple ? [] : "");
    const typed = other[field.id]?.trim();
    return [field.id, typed ? field.multiple ? [...(Array.isArray(value) ? value : [value]), typed] : typed : value];
  }));
  const complete = request.fields.every(field => field.required === false || [response[field.id]].flat().some(value => value?.trim()));
  return <form className="approval-card office-question" aria-label={item.title} onSubmit={event => { event.preventDefault(); if (complete) onAnswer("accept", response); }}>
    <strong className="approval-title">{item.title}</strong>
    {request.fields.map(field => <fieldset key={field.id}>
      <legend>{field.prompt}</legend>
      {field.options?.map(option => <label key={option.id} style={{ display: "block" }}>
        <input type={field.multiple ? "checkbox" : "radio"} name={item.id + field.id}
          checked={field.multiple ? (answers[field.id] ?? []).includes(option.id) : answers[field.id] === option.id && !other[field.id]}
          onChange={event => {
            setAnswers(current => {
              const previous = current[field.id], selected = Array.isArray(previous) ? previous : [];
              return { ...current, [field.id]: field.multiple ? event.target.checked ? [...selected, option.id] : selected.filter(value => value !== option.id) : option.id };
            });
            if (!field.multiple) setOther(current => ({ ...current, [field.id]: "" }));
          }} /> {option.label}
      </label>)}
      {!field.options || field.allowOther ? <textarea aria-label={field.options ? field.prompt + " — 직접 입력" : field.prompt}
        placeholder={field.options ? "직접 입력" : "답변 입력"} rows={2} value={other[field.id] ?? ""}
        onChange={event => { setOther(current => ({ ...current, [field.id]: event.target.value })); if (!field.multiple) setAnswers(current => ({ ...current, [field.id]: "" })); }}
        style={{ width: "100%", boxSizing: "border-box" }} /> : null}
    </fieldset>)}
    <div className="approval-actions">
      <button type="button" className="button" onClick={() => onAnswer("decline")}>취소</button>
      <button type="submit" className="button primary" disabled={!complete}>답변하고 계속</button>
    </div>
  </form>;
}
