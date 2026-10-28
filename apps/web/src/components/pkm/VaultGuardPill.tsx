import { useState } from "react";
import type { AccessMode, Provider } from "@workbench/contracts";
import { Icon } from "../Icon.tsx";
import { Popover } from "../Popover.tsx";
import { useOptionalPkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

/**
 * A pill under the input (after access and context) while a vault is attached: the engine cannot
 * write into it. Under full access it turns into a warning, saying what is still guarded and what not:
 * Claude's file tools stay blocked (a hook) but a shell command can reach further; Codex has no
 * sandbox at all then.
 */
export function VaultGuardPill({ provider, access, workId }: { provider: Provider; access: AccessMode; workId: string | null }) {
  const pkm = useOptionalPkm();
  const [open, setOpen] = useState(false);
  const status = pkm?.tree?.status;
  if (!pkm || !status?.path) return null;
  const pins = workId ? (pkm.pkmState?.pins[workId] ?? []) : [];
  const weak = access === "full";
  // Short on purpose: it shares the bar with access, context, model and engine. Calm, it is only the
  // shield (the tooltip says the rest); under full access the warning is spelled out.
  const label = weak ? (provider === "codex" ? "보호 꺼짐" : "보호 일부") : "";
  return (
    <div className="anchor pkm-pill-anchor">
      <button
        type="button"
        className={`pkm-pill vault-guard-pill${weak ? " warn" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`${weak ? "전체 접근에서는 볼트 쓰기를 다 막지 못합니다" : "볼트 읽기 전용: 엔진이 볼트에 쓰지 못하게 막고 있습니다"}${pins.length ? ` · 이 작업에 고정한 노트 ${pins.length}개` : ""}`}
        aria-label={`볼트 ${weak ? label : "읽기 전용"}${pins.length ? `, 고정 노트 ${pins.length}` : ""}`}
      >
        <Icon name="shield" size={13} />
        {label ? <span className="pkm-pill-label">{label}</span> : null}
        {pins.length ? (
          <span className="vault-guard-pins" aria-hidden>
            <Icon name="pin" size={11} />
            {pins.length}
          </span>
        ) : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} placement="above" align="left" className="vault-guard-pop">
        <div className="menu-label">볼트 {status.name} · 사람 원본</div>
        <p className="vault-guard-text">
          {weak
            ? provider === "codex"
              ? "전체 접근에서는 Codex에 샌드박스가 없어 볼트에 쓸 수 있습니다. 볼트를 지키려면 묻기나 자동으로 바꾸세요."
              : "전체 접근에서도 Claude의 파일 쓰기·고치기는 막지만, 셸 명령은 일부만 알아봅니다. 볼트를 확실히 지키려면 묻기나 자동으로 바꾸세요."
            : provider === "codex"
              ? "Codex는 볼트를 쓰기 가능 경로 밖에 둔 샌드박스에서 돕니다. 읽기는 됩니다."
              : "Claude가 볼트 안에 쓰거나 고치려 하면 Workbench가 막습니다(PreToolUse). 읽기는 됩니다."}
        </p>
        <p className="vault-guard-text muted">새 세션은 작업 이름·볼트 위치·이 작업에 고정한 노트 경로를 맥락 카드(2KB 이하)로 받습니다.</p>
      </Popover>
    </div>
  );
}
