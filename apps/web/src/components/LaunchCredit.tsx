import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import "../styles/launch-credit.css";

// The design editor (apps/design) is built from Doory, which is under the Attribution Assurance
// License (vendor/doory/LICENSE). Clause 2: "each time the resulting executable program or a program
// dependent thereon is launched, a prominent display (e.g., splash screen or banner text) of the
// Author's attribution information": (a) Name ("Siam"), (b) Professional identification ("Creator
// and maintainer of Doory"), (c) URL ("https://github.com/shaongitbd/doory"). The three items stand
// here verbatim; LaunchCredit.test.tsx reads them back from the licence text.
export const DOORY_ATTRIBUTION = { name: "Siam", role: "Creator and maintainer of Doory", url: "https://github.com/shaongitbd/doory" } as const;

/** How long the line stays at the least, whatever the person does (except its own 닫기). */
export const LAUNCH_CREDIT_MIN_MS = 10_000;
/** Place changes this soon after launch are the app settling on its first screen, not the person moving. */
const SETTLE_MS = 1_500;

// Once per launch: a launch is this page's life (the desktop window starting, or a phone opening
// the app); the line keeps its clock and its "done" across remounts (first run → the work area).
let launch: { at: number; done: boolean } | null = null;
/** Tests only: start a new launch. */
export function resetLaunchCredit() { launch = null; }

/**
 * The banner line at the foot of the work area, on whatever screen the app opens: "디자인 편집기"
 * and the three items. It stays at least LAUNCH_CREDIT_MIN_MS and until the first navigation the
 * person makes (a change of `place` after they pressed or typed anything), or until its own 닫기.
 */
export function LaunchCredit({ place }: { place: string }) {
  if (!launch) launch = { at: Date.now(), done: false };
  const started = launch.at;
  const [shown, setShown] = useState(() => !launch!.done);
  const [timeUp, setTimeUp] = useState(() => Date.now() - started >= LAUNCH_CREDIT_MIN_MS);
  const [moved, setMoved] = useState(false);
  const acted = useRef(false);
  const first = useRef(place);
  const line = useRef<HTMLDivElement>(null);

  // Under the panes the line takes real room: its height goes to the parent (--launch-credit-h), whose
  // margin the panes measure around — the composer at the foot of a conversation is never covered.
  useLayoutEffect(() => {
    const element = line.current, parent = element?.parentElement;
    if (!element || !parent) return;
    const set = () => parent.style.setProperty("--launch-credit-h", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    set();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(set);
    observer?.observe(element);
    return () => { observer?.disconnect(); parent.style.removeProperty("--launch-credit-h"); };
  }, [shown]);

  useEffect(() => {
    if (!shown || timeUp) return;
    const timer = setTimeout(() => setTimeUp(true), Math.max(0, LAUNCH_CREDIT_MIN_MS - (Date.now() - started)));
    return () => clearTimeout(timer);
  }, [shown, timeUp, started]);
  useEffect(() => {
    if (!shown) return;
    const mark = () => { if (Date.now() - started >= SETTLE_MS) acted.current = true; };
    for (const type of ["pointerdown", "keydown", "click"]) window.addEventListener(type, mark, true);
    return () => { for (const type of ["pointerdown", "keydown", "click"]) window.removeEventListener(type, mark, true); };
  }, [shown, started]);
  useEffect(() => {
    if (place === first.current) return;
    if (acted.current) setMoved(true);
    else first.current = place;
  }, [place]);
  useEffect(() => {
    if (shown && timeUp && moved) { launch!.done = true; setShown(false); }
  }, [shown, timeUp, moved]);

  if (!shown) return null;
  return <div ref={line} className="launch-credit" role="note" aria-label="디자인 편집기 저작자 표시">
    <span className="launch-credit-lead">디자인 편집기에 쓴 오픈소스:</span>
    <span className="launch-credit-text">
      {DOORY_ATTRIBUTION.name}, {DOORY_ATTRIBUTION.role},{" "}
      <a href={DOORY_ATTRIBUTION.url} target="_blank" rel="noreferrer">{DOORY_ATTRIBUTION.url}</a>
    </span>
    <button type="button" className="icon-button small launch-credit-close" aria-label="저작자 표시 닫기" title="저작자 표시 닫기" onClick={() => { launch!.done = true; setShown(false); }}>
      <Icon name="x" size={14} />
    </button>
  </div>;
}
