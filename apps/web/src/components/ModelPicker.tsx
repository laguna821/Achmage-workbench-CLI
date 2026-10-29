import { useCallback, useState } from "react";
import { EFFORT_LABEL, type ModelOption } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";

export type ModelChoice = { model: string | null; effort: string | null };

const effortLabel = (effort: string) => EFFORT_LABEL[effort] ?? effort;

/**
 * Model and reasoning-effort pickers. Lists come from the engine itself (Codex `model/list`,
 * Claude Code initialize). `null` means "engine default"; changes apply from the next message.
 */
export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelOption[];
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
}) {
  const [open, setOpen] = useState<"model" | "effort" | null>(null);
  const close = useCallback(() => setOpen(null), []);
  if (!models.length && !value.model) return null;

  const fallback = models.find((model) => model.isDefault) ?? models[0];
  const known = value.model ? models.find((model) => model.id === value.model) : fallback;
  // A saved/custom model can disappear from a refreshed list. Its id is still sent to the engine:
  // never label that request as a different default model, or silently replace the selection.
  const selected: ModelOption = known ?? {
    id: value.model!, label: value.model!, description: "현재 모델 목록에 없는 선택입니다. 다른 모델을 고르거나 엔진 기본값으로 바꿀 수 있습니다.",
    efforts: [], defaultEffort: null, isDefault: false,
  };
  const effectiveEffort = value.effort ?? selected.defaultEffort;
  const description = [selected.description, selected.resolvedModel ? `실제 모델: ${selected.resolvedModel}` : null].filter(Boolean).join(" · ");

  return (
    <>
      <div className="anchor">
        <button type="button" className="plain-select" onClick={() => setOpen(open === "model" ? null : "model")} aria-expanded={open === "model"} title={description || undefined}>
          {selected.label}
          <Icon name={open === "model" ? "chevronUp" : "chevronDown"} size={13} />
        </button>
        <Popover open={open === "model"} onClose={close} placement="above" align="right" className="model-menu">
          <div className="menu-label">모델 · 다음 메시지부터 적용</div>
          {!known ? <div className="menu-label">현재 선택: {value.model} · 목록에서 확인되지 않음</div> : null}
          <MenuItem active={!value.model} hint={fallback?.label} onSelect={() => { onChange({ model: null, effort: null }); close(); }}>
            엔진 기본값
          </MenuItem>
          {models.map((model) => (
            <MenuItem
              key={model.id}
              active={model.id === value.model}
              hint={model.isDefault ? "기본" : undefined}
              onSelect={() => {
                // Keep the effort only if the new model supports it.
                const effort = value.effort && model.efforts.includes(value.effort) ? value.effort : null;
                onChange({ model: model.id, effort });
                close();
              }}
            >
              {model.label}
            </MenuItem>
          ))}
        </Popover>
      </div>
      {selected.efforts.length || value.effort ? (
        <div className="anchor">
          <button type="button" className="plain-select" onClick={() => setOpen(open === "effort" ? null : "effort")} aria-expanded={open === "effort"} title="추론 강도">
            {effectiveEffort ? effortLabel(effectiveEffort) : "기본 강도"}
            <Icon name={open === "effort" ? "chevronUp" : "chevronDown"} size={13} />
          </button>
          <Popover open={open === "effort"} onClose={close} placement="above" align="right">
            <div className="menu-label">추론 강도</div>
            <MenuItem active={!value.effort} onSelect={() => { onChange({ model: value.model, effort: null }); close(); }}>
              기본 강도
            </MenuItem>
            {selected.efforts.map((effort) => (
              <MenuItem
                key={effort}
                active={effort === effectiveEffort}
                hint={effort === selected.defaultEffort ? "기본" : undefined}
                onSelect={() => {
                  onChange({ model: value.model, effort: effort === selected.defaultEffort && !value.effort ? null : effort });
                  close();
                }}
              >
                {effortLabel(effort)}
              </MenuItem>
            ))}
          </Popover>
        </div>
      ) : null}
    </>
  );
}
