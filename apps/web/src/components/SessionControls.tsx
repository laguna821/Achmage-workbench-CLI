import { useCallback, useState } from "react";
import { ACCESS_LABEL, ACCESS_MODES, type AccessMode, type ContextUsage, type Provider } from "@workbench/contracts";
import { Icon, type IconName } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";

const ACCESS_ICON: Record<AccessMode, IconName> = { ask: "shield", auto: "bolt", full: "unlock" };

/** What each access does with this engine, in the words of what the user will see happen. */
function accessHelp(mode: AccessMode, provider: Provider) {
  if (mode === "ask") return "명령을 실행하거나 파일을 바꾸기 전에 매번 묻습니다.";
  if (mode === "full") return "묻지 않고 진행합니다. 작업 폴더 밖의 파일과 인터넷까지 씁니다.";
  return provider === "codex"
    ? "작업 폴더 안에서는 묻지 않고, 폴더 밖이나 인터넷을 쓸 때만 묻습니다."
    : "파일 수정은 묻지 않고, 명령을 실행할 때만 묻습니다.";
}

/**
 * How freely the engine acts ("권한"), under the input like Codex's and Claude Code's mode switch.
 * A change applies at once (approvals waiting on screen are answered if the new access allows
 * them) and becomes the default for new sessions of the engine.
 */
export function AccessPicker({ provider, value, onChange }: { provider: Provider; value: AccessMode; onChange: (mode: AccessMode) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="anchor">
      <button
        type="button"
        className={`plain-select access-select access-${value}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`권한: ${ACCESS_LABEL[value]} — ${accessHelp(value, provider)}`}
      >
        <Icon name={ACCESS_ICON[value]} size={14} />
        {ACCESS_LABEL[value]}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={13} />
      </button>
      <Popover open={open} onClose={close} placement="above" align="left" className="access-menu">
        <div className="menu-label">권한 · 바로 적용, 새 세션에도 이어짐</div>
        {ACCESS_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={mode === value}
            className={`menu-item two-line access-option access-${mode}${mode === value ? " active" : ""}`}
            onClick={() => {
              onChange(mode);
              close();
            }}
          >
            <Icon name={ACCESS_ICON[mode]} size={15} className="access-option-icon" />
            <span className="access-option-text">
              <span className="access-option-name">{ACCESS_LABEL[mode]}</span>
              <span className="access-option-help">{accessHelp(mode, provider)}</span>
            </span>
          </button>
        ))}
      </Popover>
    </div>
  );
}

const tokens = (count: number) => (count >= 10_000 ? `${Math.round(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));

/**
 * How full the conversation's context is, as a small ring next to the access; opened, the
 * figures, where the engine compacts on its own, and "지금 압축".
 */
export function ContextGauge({ context, canCompact, onCompact }: { context: ContextUsage | null; canCompact: boolean; onCompact: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!context) return null;
  const share = context.window ? Math.min(1, context.used / context.window) : null;
  const percent = share === null ? null : Math.round(share * 100);
  const tone = share === null ? "" : share >= 0.9 ? " full" : share >= 0.75 ? " high" : "";
  const summary = context.window ? `${tokens(context.used)} / ${tokens(context.window)} 토큰` : `약 ${tokens(context.used)} 토큰`;
  const compactAt = context.compactAt && context.window ? `${tokens(context.compactAt)}(${Math.round((context.compactAt / context.window) * 100)}%)` : null;
  return (
    <div className="anchor">
      <button type="button" className={`plain-select context-gauge${tone}`} onClick={() => setOpen(!open)} aria-expanded={open} title={`컨텍스트 ${percent === null ? "" : `${percent}% · `}${summary}`}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="context-ring">
          <circle cx="8" cy="8" r="6" className="context-ring-track" />
          {share !== null ? <circle cx="8" cy="8" r="6" className="context-ring-fill" strokeDasharray={`${(share * 37.7).toFixed(2)} 37.7`} transform="rotate(-90 8 8)" /> : null}
        </svg>
        {percent === null ? tokens(context.used) : `${percent}%`}
      </button>
      <Popover open={open} onClose={close} placement="above" align="left" className="context-menu-card">
        <div className="menu-label">컨텍스트</div>
        <div className="context-detail">
          {share !== null ? (
            <div className={`context-bar${tone}`}>
              <span style={{ width: `${Math.max(2, share * 100)}%` }} />
            </div>
          ) : null}
          <div className="context-figures">{percent !== null ? `${percent}% · ${summary}` : summary}</div>
          <div className="context-note">
            {compactAt ? `${compactAt}에 이르면 엔진이 스스로 앞부분을 요약해 압축합니다.` : "가득 차면 엔진이 스스로 앞부분을 요약해 압축합니다."}
          </div>
          <button
            type="button"
            className="button small"
            disabled={!canCompact}
            onClick={() => {
              onCompact();
              close();
            }}
            title={canCompact ? "앞부분을 요약해 공간을 비웁니다" : "응답이 끝난 뒤에 압축할 수 있습니다"}
          >
            지금 압축
          </button>
        </div>
      </Popover>
    </div>
  );
}
