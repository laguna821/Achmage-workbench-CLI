import { useCallback, useRef, useState } from "react";
import { EFFORT_LABEL, type ModelOption } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import "../styles/model-picker.css";

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
  onRefresh,
  inherited,
}: {
  models: ModelOption[];
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  onRefresh?: () => Promise<unknown>;
  /** A role supplies defaults; choosing a model/effort here makes it an explicit session value. */
  inherited?: ModelChoice & { name: string };
}) {
  const [open, setOpen] = useState<"model" | "effort" | "custom" | null>(null);
  const [customId, setCustomId] = useState("");
  const composing = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true); setError("");
    try { await onRefresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRefreshing(false); }
  };
  const close = useCallback(() => setOpen(null), []);
  const modelId = value.model ?? inherited?.model ?? null;
  const fallback = models.find((model) => model.isDefault) ?? models[0];
  const known = modelId ? models.find((model) => model.id === modelId) : fallback;
  // A saved/custom model can disappear from a refreshed list. Its id is still sent to the engine:
  // never label that request as a different default model, or silently replace the selection.
  const selected: ModelOption = known ?? {
    id: modelId ?? "", label: modelId ?? "모델 선택", description: modelId ? "현재 모델 목록에 없는 선택입니다. ID는 그대로 다음 요청에 전달됩니다." : "모델 목록을 확인하거나 모델 ID를 직접 입력할 수 있습니다.",
    efforts: [], defaultEffort: null, isDefault: false,
  };
  const effectiveEffort = value.effort ?? inherited?.effort ?? selected.defaultEffort;
  const description = [selected.description, selected.resolvedModel ? `실제 모델: ${selected.resolvedModel}` : null, inherited && !value.model ? `${inherited.name} 역할 기본값` : null].filter(Boolean).join(" · ");
  const modelOpen = open === "model" || open === "custom";

  return (
    <>
      <div className="anchor">
        <button type="button" className="plain-select" onClick={() => { setOpen(modelOpen ? null : "model"); if (!modelOpen) void refresh(); }} aria-label={`${selected.label}${inherited && !value.model ? " · 역할" : ""}`} aria-haspopup={open === "custom" ? "dialog" : "menu"} aria-expanded={modelOpen} title={description || undefined}>
          {selected.label}{inherited && !value.model ? <span className="model-inherited"> · 역할</span> : null}
          <Icon name={modelOpen ? "chevronUp" : "chevronDown"} size={13} />
        </button>
        <Popover open={modelOpen} onClose={close} placement="above" align="right" className="model-menu" role={open === "custom" ? "dialog" : "menu"} label={open === "custom" ? "모델 ID 직접 입력" : "모델 선택"}>
          {open === "custom" ? <form className="model-custom-form" onSubmit={event => {
            event.preventDefault();
            if (composing.current || !customId.trim()) return;
            onChange({ model: customId.trim(), effort: customId.trim() === modelId ? value.effort : null }); close();
          }}>
            <label>모델 ID<input autoFocus required value={customId} onChange={event => setCustomId(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} placeholder="엔진에 전달할 모델 ID" /></label>
            <p className="muted">입력한 ID를 다음 요청에 그대로 보냅니다. 목록 새로고침으로 바뀌지 않습니다.</p>
            <div><button type="button" className="button small" onClick={() => setOpen("model")}>목록으로</button><button type="submit" className="button small primary" disabled={!customId.trim()}>이 ID 사용</button></div>
          </form> : <>
          <div className="menu-label">모델 · 다음 메시지부터 적용</div>
          {onRefresh ? <MenuItem disabled={refreshing} disabledReason="최신 모델 목록을 확인하고 있습니다." onSelect={() => void refresh()}>{refreshing ? "최신 모델 확인 중…" : "모델 목록 새로고침"}</MenuItem> : null}
          {error ? <div className="menu-label" role="alert">{error}</div> : null}
          {!known && modelId ? <div className="menu-label">현재 선택: {modelId} · 목록에서 확인되지 않음</div> : null}
          {!models.length && !refreshing ? <div className="menu-label">발견된 모델이 없습니다. 모델 ID를 직접 입력할 수 있습니다.</div> : null}
          <MenuItem active={!value.model} hint={inherited?.model ?? fallback?.label} onSelect={() => { onChange({ model: null, effort: null }); close(); }}>
            {inherited ? "역할 기본값" : "엔진 기본값"}
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
          <div className="menu-divider" />
          <MenuItem onSelect={() => { setCustomId(modelId ?? ""); composing.current = false; setOpen("custom"); }}>모델 ID 직접 입력…</MenuItem>
          </>}
        </Popover>
      </div>
      {selected.efforts.length || effectiveEffort ? (
        <div className="anchor">
          <button type="button" className="plain-select" onClick={() => setOpen(open === "effort" ? null : "effort")} aria-expanded={open === "effort"} title="추론 강도">
            {effectiveEffort ? effortLabel(effectiveEffort) : "기본 강도"}
            <Icon name={open === "effort" ? "chevronUp" : "chevronDown"} size={13} />
          </button>
          <Popover open={open === "effort"} onClose={close} placement="above" align="right">
            <div className="menu-label">추론 강도</div>
            <MenuItem active={!value.effort} hint={inherited?.effort ? effortLabel(inherited.effort) : undefined} onSelect={() => { onChange({ model: value.model, effort: null }); close(); }}>
              {inherited?.effort ? "역할 기본 강도" : "기본 강도"}
            </MenuItem>
            {selected.efforts.map((effort) => (
              <MenuItem
                key={effort}
                active={effort === value.effort}
                hint={effort === selected.defaultEffort ? "기본" : undefined}
                onSelect={() => {
                  onChange({ model: value.model, effort });
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
