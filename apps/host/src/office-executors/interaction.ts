import type { OfficeInteractionField, OfficeInteractionResponse } from "@workbench/contracts";
import { HttpError } from "../errors.ts";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const invalid = () => new HttpError(400, "office_question_answer", "문서의 질문과 답변을 확인해 주세요.");
export function interactionFields(raw: unknown): OfficeInteractionField[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > 24) throw invalid();
  const ids = new Set<string>();
  return raw.map(field => {
    if (!object(field) || !text(field.id, 100) || !/^[A-Za-z0-9_.:-]+$/.test(field.id) || ids.has(field.id)
      || !text(field.prompt, 8_000) || !field.prompt.trim()) throw invalid();
    ids.add(field.id);
    for (const key of ["multiple", "required", "allowOther"]) if (field[key] !== undefined && typeof field[key] !== "boolean") throw invalid();
    if (field.options !== undefined) {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 100) throw invalid();
      const choices = new Set<string>();
      for (const choice of field.options) {
        if (!object(choice) || !text(choice.id, 500) || !choice.id || choices.has(choice.id) || !text(choice.label, 4_000) || !choice.label.trim()) throw invalid();
        choices.add(choice.id);
      }
    }
    return structuredClone(field) as OfficeInteractionField;
  });
}
export function interactionResponse(fields: OfficeInteractionField[], raw: unknown): OfficeInteractionResponse {
  if (!object(raw) || JSON.stringify(raw).length > 64_000 || Object.keys(raw).some(key => !fields.some(field => field.id === key))) throw invalid();
  const result: OfficeInteractionResponse = Object.create(null);
  for (const field of fields) {
    const value = raw[field.id] ?? (field.multiple ? [] : "");
    if (field.multiple ? !Array.isArray(value) : !text(value, 16_000)) throw invalid();
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 100 || values.some(entry => !text(entry, 16_000)) || new Set(values).size !== values.length) throw invalid();
    if (field.required !== false && !values.some(entry => (entry as string).trim())) throw invalid();
    if (field.options && !field.allowOther && values.some(entry => entry !== "" && !field.options!.some(option => option.id === entry))) throw invalid();
    result[field.id] = value as string | string[];
  }
  return result;
}
