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
  if (!models.length) return null;

  const fallback = models.find((model) => model.isDefault) ?? models[0];
  const selected = (value.model && models.find((model) => model.id === value.model)) || fallback;
  const effectiveEffort = value.effort ?? selected.defaultEffort;

  return (
    <>
      <div className="anchor">
        <button type="button" className="plain-select" onClick={() => setOpen(open === "model" ? null : "model")} aria-expanded={open === "model"} title={selected.description ?? undefined}>
          {selected.label}
          <Icon name={open === "model" ? "chevronUp" : "chevronDown"} size={13} />
        </button>
        <Popover open={open === "model"} onClose={close} placement="above" align="right" className="model-menu">
          <div className="menu-label">모델 · 다음 메시지부터 적용</div>
          {models.map((model) => (
            <MenuItem
              key={model.id}
              active={model.id === selected.id}
              hint={model.isDefault ? "기본" : undefined}
              onSelect={() => {
                // Keep the effort only if the new model supports it.
                const effort = value.effort && model.efforts.includes(value.effort) ? value.effort : null;
                onChange({ model: model.isDefault && !value.model ? null : model.id, effort });
                close();
              }}
            >
              {model.label}
            </MenuItem>
          ))}
        </Popover>
      </div>
      {selected.efforts.length ? (
        <div className="anchor">
          <button type="button" className="plain-select" onClick={() => setOpen(open === "effort" ? null : "effort")} aria-expanded={open === "effort"} title="추론 강도">
            {effectiveEffort ? effortLabel(effectiveEffort) : "기본 강도"}
            <Icon name={open === "effort" ? "chevronUp" : "chevronDown"} size={13} />
          </button>
          <Popover open={open === "effort"} onClose={close} placement="above" align="right">
            <div className="menu-label">추론 강도</div>
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
