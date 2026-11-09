import type { OfficeInteractionField, OfficeInteractionResponse } from "../../../packages/contracts/src/office-execution.ts";

/** Same question, whether it is observed in the original tab or after reopening. */
export function executionQuestionFields(parent: HTMLElement, fields: OfficeInteractionField[]) {
  const readers: [string, () => string | string[]][] = [];
  for (const field of fields) {
    const group = document.createElement("fieldset"), legend = document.createElement("legend");
    legend.textContent = field.prompt; group.append(legend); group.style.marginBottom = "12px";
    const choices: HTMLInputElement[] = [];
    for (const option of field.options ?? []) {
      const label = document.createElement("label"), input = document.createElement("input");
      input.type = field.multiple ? "checkbox" : "radio"; input.name = field.id; input.value = option.id;
      label.style.display = "block"; label.append(input, document.createTextNode(option.label)); group.append(label); choices.push(input);
    }
    let other: HTMLTextAreaElement | undefined;
    if (!field.options || field.allowOther) {
      other = document.createElement("textarea"); other.setAttribute("aria-label", field.options ? field.prompt + " — 직접 입력" : field.prompt);
      other.placeholder = field.options ? "직접 입력" : "답변 입력"; other.rows = 2; other.style.cssText = "width:100%;box-sizing:border-box";
      if (field.options) other.oninput = () => { if (!field.multiple && other!.value) for (const choice of choices) choice.checked = false; };
      for (const choice of choices) choice.onchange = () => { if (!field.multiple && other) other.value = ""; };
      group.append(other);
    }
    readers.push([field.id, () => {
      const selected = choices.filter(input => input.checked).map(input => input.value);
      if (other?.value.trim()) selected.push(other.value);
      return field.multiple ? selected : selected[0] ?? "";
    }]);
    parent.append(group);
  }
  return (): OfficeInteractionResponse => Object.fromEntries(readers.map(([id, read]) => [id, read()]));
}
