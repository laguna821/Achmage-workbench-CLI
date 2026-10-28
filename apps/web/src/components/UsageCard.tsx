import { useState } from "react";
import { PROVIDER_LABEL, type Provider, type ProviderStatus } from "@workbench/contracts";
import { resetIn, usageText } from "../format.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

const ENGINES: Provider[] = ["claude", "codex"];

/**
 * Plan limits of both engines in one box at the foot of the sidebar: a bar per window
 * (5시간, 주간), amber from 75 %, red from 90 %. Pressing it reads them again.
 */
export function UsageCard({ providers, onRefresh }: { providers: Partial<Record<Provider, ProviderStatus>>; onRefresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const engines = ENGINES.filter((provider) => providers[provider]?.installed);
  if (!engines.length) return null;
  return (
    <section className="usage-card" aria-label="사용 한도">
      <header className="usage-head">
        <span>사용 한도</span>
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
      {engines.map((provider) => {
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
                    <span key={window.label} className={`usage-window${used >= 90 ? " full" : used >= 75 ? " high" : ""}`} title={usageText(window)}>
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
