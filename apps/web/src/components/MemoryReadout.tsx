import { useEffect, useId, useRef, useState } from "react";
import { PROVIDER_LABEL, type AppMemory } from "@workbench/contracts";

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
 * Said with the parts when the numbers are resident sets (macOS `ps`, Windows' working set) rather than
 * Linux's proportional shares, and when the web view's page processes could not be counted (macOS) — so a
 * number that differs from the system's own monitor is not taken for a wrong one (0.5.4).
 */
export const RSS_NOTE = "실제 사용(RSS) 기준: 여러 프로세스가 함께 쓰는 메모리는 프로세스마다 셉니다";
export const PAGES_NOTE = "macOS에서는 웹 화면을 그리는 프로세스가 빠져 있어 창은 실제보다 작게 나옵니다";

/**
 * The app's memory for the readout: read every 30 s while the window is visible and has the focus, and
 * not at all while it is hidden (a window in sight without the focus reads once, so the line is not empty).
 * Null — nothing to show — while it is turned off (`read` null), when the gateway does not know, and
 * when the call fails.
 */
export function useAppMemory(read: (() => Promise<AppMemory>) | null, again = 0): KnownMemory | null {
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
  // Asked to read again now (engines were just closed): one read, the 30 s rhythm unchanged.
  useEffect(() => {
    if (!again || !on) return;
    let stopped = false;
    reader.current?.().then((value) => { if (!stopped) setMemory(value.known ? value : null); }, () => undefined);
    return () => { stopped = true; };
  }, [again, on]);
  return memory;
}

/** An engine's row: its conversation (Codex's shared app-server: how many), the engine, and whether it rests. */
function engineLabel(engine: NonNullable<KnownMemory["engines"]>[number]) {
  const name = PROVIDER_LABEL[engine.provider];
  const what = engine.sessions.length === 1 ? engine.sessions[0]!.title : `${name} 대화 ${engine.sessions.length}개`;
  return `${what} · ${name} · ${engine.idle ? "쉬는 중" : "일하는 중"}`;
}

/**
 * "메모리 0.5 GB" (and "· 쉬는 탭 3" while tabs rest). Hover or focus shows the three parts in a small
 * popover; its last line about resting tabs is there only when `sleeping` is given. With engines alive
 * (0.5.3 B1) it lists each engine process with its conversation and memory, and offers
 * "쉬는 엔진 지금 끄기" (idle ones only; a running turn is never touched) — the popover is then a group
 * the keyboard can enter (Tab from the text), not a tooltip.
 */
export function MemoryReadout({ memory, sleeping, onCloseIdle }: { memory: KnownMemory; sleeping?: number; onCloseIdle?: () => Promise<number> }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const id = useId();
  const engines = memory.engines ?? [];
  const interactive = engines.length > 0;
  const closeIdle = onCloseIdle && engines.some((engine) => engine.idle)
    ? () => { void onCloseIdle().then((closed) => setSaid(closed ? `쉬는 엔진 ${closed}개를 껐습니다. 그 대화는 다음 메시지에서 이어집니다.` : "끌 엔진이 없습니다."), () => setSaid("엔진을 끄지 못했습니다.")); }
    : null;
  return (
    <div className="memory-readout" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setSaid(null); } }}>
      <span className="memory-readout-text" tabIndex={0} aria-describedby={open && !interactive ? id : undefined} aria-controls={open && interactive ? id : undefined} aria-expanded={interactive ? open : undefined} onClick={() => setOpen(true)}
        onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
        메모리 {gigabytes(memory.totalBytes)}{sleeping ? ` · 쉬는 탭 ${sleeping}` : ""}
      </span>
      {open ? (
        <div id={id} role={interactive ? "group" : "tooltip"} aria-label={interactive ? "메모리 자세히" : undefined} className="popover popover-above popover-right memory-pop"
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
          <dl className="memory-parts">
            <div><dt>창</dt><dd>{partSize(memory.windowBytes)}</dd></div>
            <div><dt>AI 엔진과 도구</dt><dd>{partSize(memory.toolsBytes)}</dd></div>
            <div><dt>게이트웨이</dt><dd>{partSize(memory.gatewayBytes)}</dd></div>
          </dl>
          {memory.measure === "rss" ? <p className="memory-note">{RSS_NOTE}</p> : null}
          {memory.pagesLeftOut ? <p className="memory-note">{PAGES_NOTE}</p> : null}
          {interactive ? <>
            <dl className="memory-parts memory-engines" aria-label="AI 엔진">
              {engines.map((engine) => <div key={`${engine.provider}:${engine.sessions.map((session) => session.id).join(",")}`}><dt>{engineLabel(engine)}</dt><dd>{engine.bytes === null ? "—" : partSize(engine.bytes)}</dd></div>)}
            </dl>
            {closeIdle ? <button type="button" className="text-button memory-close-idle" onClick={closeIdle}>쉬는 엔진 지금 끄기</button> : null}
            {said ? <p className="memory-note" role="status">{said}</p> : null}
          </> : null}
          {sleeping !== undefined ? <p className="memory-note">지금 보이지 않는 탭은 10분 뒤 쉬게 합니다</p> : null}
        </div>
      ) : null}
    </div>
  );
}
