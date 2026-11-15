import { useEffect, useId, useRef, useState } from "react";
import type { AppMemory } from "@workbench/contracts";

// 메모리 표시 (0.5.1): what the app uses now, small and muted at the right end of the window's bottom
// line, as Orca shows it — "메모리 0.5 GB". The gateway sums it (`GET /api/memory`); the window only asks.

export type KnownMemory = Extract<AppMemory, { known: true }>;

const MB = 1024 * 1024, GB = 1024 * MB;
/** The total: always GB with one decimal ("0.5 GB"). */
const gigabytes = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
/** A part: MB below 1 GB (a part of 80 MB would read "0.1 GB"), GB from there. */
const partSize = (bytes: number) => (bytes >= GB ? gigabytes(bytes) : `${Math.round(bytes / MB)} MB`);

export const MEMORY_REFRESH_MS = 30_000;

/**
 * The app's memory for the readout: read every 30 s while the window is visible and has the focus, and
 * not at all while it is hidden (a window in sight without the focus reads once, so the line is not empty).
 * Null — nothing to show — while it is turned off (`read` null), when the gateway does not know, and
 * when the call fails.
 */
export function useAppMemory(read: (() => Promise<AppMemory>) | null): KnownMemory | null {
  const [memory, setMemory] = useState<KnownMemory | null>(null);
  const reader = useRef(read);
  reader.current = read;
  const on = read !== null;
  useEffect(() => {
    if (!on) { setMemory(null); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let askedAt = -Infinity;
    const ask = () => {
      askedAt = Date.now();
      reader.current?.().then((value) => { if (!stopped) setMemory(value.known ? value : null); }, () => { if (!stopped) setMemory(null); });
    };
    const tick = () => { ask(); timer = setTimeout(tick, MEMORY_REFRESH_MS); };
    const sync = () => {
      const visible = document.visibilityState === "visible";
      if (visible && document.hasFocus()) {
        timer ??= setTimeout(tick, Math.max(0, askedAt + MEMORY_REFRESH_MS - Date.now()));
        return;
      }
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (visible && askedAt === -Infinity) ask();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, [on]);
  return memory;
}

/**
 * "메모리 0.5 GB" (and "· 쉬는 탭 3" while tabs rest). Hover or focus shows the three parts in a small
 * popover; its last line about resting tabs is there only when `sleeping` is given.
 */
export function MemoryReadout({ memory, sleeping }: { memory: KnownMemory; sleeping?: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="memory-readout" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      <span className="memory-readout-text" tabIndex={0} aria-describedby={open ? id : undefined} onClick={() => setOpen(true)}
        onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
        메모리 {gigabytes(memory.totalBytes)}{sleeping ? ` · 쉬는 탭 ${sleeping}` : ""}
      </span>
      {open ? (
        <div id={id} role="tooltip" className="popover popover-above popover-right memory-pop">
          <dl className="memory-parts">
            <div><dt>창</dt><dd>{partSize(memory.windowBytes)}</dd></div>
            <div><dt>AI 엔진과 도구</dt><dd>{partSize(memory.toolsBytes)}</dd></div>
            <div><dt>게이트웨이</dt><dd>{partSize(memory.gatewayBytes)}</dd></div>
          </dl>
          {sleeping !== undefined ? <p className="memory-note">지금 보이지 않는 탭은 10분 뒤 쉬게 합니다</p> : null}
        </div>
      ) : null}
    </div>
  );
}
