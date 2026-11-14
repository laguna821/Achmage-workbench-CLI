import { useState } from "react";
import { PROVIDER_LABEL, type Provider, type ProviderStatus } from "@workbench/contracts";
import { resetIn, usageText } from "../format.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

const ENGINES: Provider[] = ["claude", "codex"];

const tone = (used: number) => (used >= 90 ? " full" : used >= 75 ? " high" : "");

/**
 * Plan limits of both engines in one box at the foot of the sidebar: a bar per window
 * (5시간, 주간), amber from 75 %, red from 90 %. Pressing it reads them again. Folded (remembered)
 * it is one line that still says each engine's highest use.
 */
export function UsageCard({ providers, onRefresh, folded = false, onFold }: { providers: Partial<Record<Provider, ProviderStatus>>; onRefresh: () => Promise<unknown>; folded?: boolean; onFold?: (folded: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const engines = ENGINES.filter((provider) => providers[provider]?.installed);
  if (!engines.length) return null;
  const peaks = engines.flatMap((provider) => {
    const used = providers[provider]!.usage.flatMap((window) => (window.usedPercent === null ? [] : [Math.min(100, Math.max(0, window.usedPercent))]));
    return used.length ? [{ provider, used: Math.max(...used) }] : [];
  });
  return (
    <section className={`usage-card${folded ? " folded" : ""}`} aria-label="사용 한도">
      <header className="usage-head">
        {onFold ? (
          <button type="button" className="nav-fold" aria-expanded={!folded} title={folded ? "사용 한도 펼치기" : "사용 한도 접기"} onClick={() => onFold(!folded)}>
            <Icon name={folded ? "chevronRight" : "chevronDown"} size={13} />
            <span>사용 한도</span>
          </button>
        ) : (
          <span>사용 한도</span>
        )}
        {folded ? (
          <span className="usage-peaks">
            {peaks.map(({ provider, used }) => (
              <span key={provider} className={`usage-peak${tone(used)}`} title={`${PROVIDER_LABEL[provider]} · 가장 많이 쓴 한도`}>
                <EngineMark provider={provider} size={13} />
                <span className="usage-percent">{Math.round(used)}%</span>
              </span>
            ))}
          </span>
        ) : null}
        <button
          type="button"
          className="icon-button small"
          title="다시 읽기"
          aria-label="사용 한도 다시 읽기"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onRefresh().finally(() => setBusy(false));
          }}
        >
          {busy ? <span className="spinner small" /> : <Icon name="refresh" size={13} />}
        </button>
      </header>
      {folded ? null : engines.map((provider) => {
        const status = providers[provider]!;
        const windows = status.usage.filter((window) => window.usedPercent !== null).slice(0, 2);
        return (
          <div key={provider} className="usage-engine">
            <span className="usage-name">
              <EngineMark provider={provider} size={13} />
              {PROVIDER_LABEL[provider]}
            </span>
            {windows.length ? (
              <span className="usage-windows">
                {windows.map((window) => {
                  const used = Math.min(100, Math.max(0, window.usedPercent ?? 0));
                  return (
                    <span key={window.label} className={`usage-window${tone(used)}`} title={usageText(window)}>
                      <span className="usage-label">{window.label.replace(" · ", " ")}</span>
                      <span className="usage-bar">
                        <span style={{ width: `${Math.max(used, 2)}%` }} />
                      </span>
                      <span className="usage-percent">{Math.round(used)}%</span>
                      {window.resetsAt && used >= 75 ? <span className="usage-reset">{resetIn(window.resetsAt)}</span> : null}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className="usage-none">{status.loggedIn === false ? "로그인 필요" : "첫 요청 뒤 표시"}</span>
            )}
          </div>
        );
      })}
    </section>
  );
}
