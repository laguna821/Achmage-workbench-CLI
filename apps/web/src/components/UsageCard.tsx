import { useState, type ReactNode } from "react";
import { Popover } from "./Popover.tsx";
import { PROVIDER_LABEL, type Provider, type ProviderStatus } from "@workbench/contracts";
import { resetIn, usageText } from "../format.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";

const ENGINES: Provider[] = ["claude", "codex"];

const tone = (used: number) => (used >= 90 ? " full" : used >= 75 ? " high" : "");

/** A window's label without middle dots ("주간 · Opus" from an older gateway reads "주간 Opus"). */
const plain = (label: string) => label.replace(/\s*·\s*/g, " ");

/** One limit: its label, a thin bar (accent; attention from 75 %, danger from 90 %), the percentage and, from 75 %, when it resets. */
function Limit({ window }: { window: ProviderStatus["usage"][number] }) {
  const used = Math.min(100, Math.max(0, window.usedPercent ?? 0));
  return (
    <li className={`usage-window${tone(used)}`} title={usageText(window)}>
      <span className="usage-label">{plain(window.label)}</span>
      <span className="usage-bar" aria-hidden><span style={{ width: `${Math.max(used, 2)}%` }} /></span>
      <span className="usage-percent">{Math.round(used)}%</span>
      {window.resetsAt && used >= 75 ? <span className="usage-reset">{resetIn(window.resetsAt)}</span> : null}
    </li>
  );
}

/**
 * Plan limits of both engines at the foot of the list column (atlas-look, the owner: bars, not numbers
 * alone; every limit the engine reports, Fable too): the engine's mark and name head its group, then one
 * line per limit. Pressing ↻ reads them again. Folded (remembered) it is one line that still says each
 * engine's highest use.
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
              <span key={provider} className={`usage-peak${tone(used)}`} title={`${PROVIDER_LABEL[provider]}, 가장 많이 쓴 한도`}>
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
        const windows = status.usage.filter((window) => window.usedPercent !== null);
        return (
          <div key={provider} className="usage-engine">
            <span className="usage-name">
              <EngineMark provider={provider} size={13} />
              {PROVIDER_LABEL[provider]}
            </span>
            {windows.length ? (
              <ul className="usage-windows">
                {windows.map((window) => <Limit key={window.label} window={window} />)}
              </ul>
            ) : (
              <span className="usage-none">{status.loggedIn === false ? "로그인 필요" : "첫 요청 뒤 표시"}</span>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * 창 아래 줄 (atlas-look): a slim line along the window's bottom edge, as Orca has. 사용 한도 표시 = 창 아래 줄
 * puts each engine's mark and its limits there as short bars with percentages in one row (a click opens the
 * full card); `end` is what the line holds at its right end (메모리 표시). With neither there is no line.
 */
export function UsageLine({ providers, onRefresh, end }: { providers: Partial<Record<Provider, ProviderStatus>>; onRefresh: () => Promise<unknown>; end?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const engines = ENGINES.filter((provider) => providers[provider]?.installed);
  if (!engines.length && !end) return null;
  return (
    <div className="usage-line" role="group" aria-label={!engines.length ? "메모리" : end ? "사용 한도와 메모리" : "사용 한도"}>
      {engines.length ? <button type="button" className="usage-line-key" aria-expanded={open} aria-haspopup="dialog" title="사용 한도 자세히" onClick={() => setOpen(!open)}>
        {engines.map((provider) => {
          const windows = providers[provider]!.usage.filter((window) => window.usedPercent !== null);
          return (
            <span key={provider} className="usage-line-engine">
              <EngineMark provider={provider} size={12} />
              <span className="visually-hidden">{PROVIDER_LABEL[provider]}</span>
              {windows.length ? <ul className="usage-windows">{windows.map((window) => <Limit key={window.label} window={window} />)}</ul>
                : <span className="usage-none">{providers[provider]!.loggedIn === false ? "로그인 필요" : "첫 요청 뒤 표시"}</span>}
            </span>
          );
        })}
      </button> : null}
      {engines.length ? <Popover open={open} onClose={() => setOpen(false)} placement="above" className="usage-line-pop" label="사용 한도">
        <UsageCard providers={providers} onRefresh={onRefresh} />
      </Popover> : null}
      {end}
    </div>
  );
}
