import { useState } from "react";
import { CREATE_LABEL, type CreatableFormat, type CreateTarget, type DocumentTools } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";

const ORDER: CreatableFormat[] = ["hwpx", "docx", "pptx", "xlsx", "markdown", "design", "html"];

/** Which tool a new document of each format needs on this computer, and whether it is there. */
function availability(format: CreatableFormat, tools: DocumentTools | null): string | null {
  if (format === "hwpx") return tools?.kordoc.available ? null : "kordoc 필요";
  if (format === "docx" || format === "pptx" || format === "xlsx") return tools?.ieumoffice.available ? null : "이음오피스 필요";
  return null;
}

/** "새 문서로": the request's result becomes a new document in the chosen format. */
export function CreateTargetButton({ tools, onPick }: { tools: DocumentTools | null; onPick: (format: CreatableFormat) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="anchor">
      <button type="button" className="icon-button" onClick={() => setOpen(!open)} title="결과를 새 문서로 만들기" aria-label="새 문서로 만들기">
        <Icon name="plus" size={17} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} placement="above" align="right">
        <div className="menu-label">결과를 새 문서로 · 기존 파일은 덮어쓰지 않음</div>
        {ORDER.map((format) => {
          const missing = availability(format, tools);
          return (
            <MenuItem
              key={format}
              hint={missing ?? undefined}
              onSelect={() => {
                setOpen(false);
                onPick(format);
              }}
            >
              새 {CREATE_LABEL[format]} 문서
            </MenuItem>
          );
        })}
      </Popover>
    </div>
  );
}

/** The chosen new document, with its name editable before sending. */
export function CreateChip({ target, onChange, onClear }: { target: CreateTarget; onChange: (target: CreateTarget) => void; onClear: () => void }) {
  return (
    <span className="ref-chip create-chip">
      <Icon name="plus" size={12} /> 새 {CREATE_LABEL[target.format]}:
      <input
        className="create-name"
        value={target.name}
        size={Math.max(6, target.name.length + 1)}
        onChange={(event) => onChange({ ...target, name: event.target.value })}
        aria-label="새 문서 이름"
        placeholder="새 문서"
      />
      <button type="button" onClick={onClear} aria-label="새 문서 취소">
        <Icon name="x" size={11} />
      </button>
    </span>
  );
}

/** A file name without its document extension (for a new document named after its source). */
export function stemOf(name: string) {
  return name.replace(/\.design\.json$/i, "").replace(/\.[^.]+$/, "");
}
