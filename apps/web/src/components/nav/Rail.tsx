import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { BrandSymbol } from "../BrandMark.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import type { RailDest } from "./model.ts";

// The rail (N1, the owner's navigation): the far-left deep-navy strip of the app's six places,
// Slack's icon rail without Slack. 지금 is the home "오늘" page; 프로젝트 · 문서 · 활동 · 볼트 choose
// what the one white list column beside it shows; 찾기 is the existing search (Ctrl+K). The brand
// mark heads it; the running work and the settings stand at its foot. Exactly one place is lit.

export type RailPlace = "now" | RailDest | "search";

export const RAIL_ITEMS: { id: RailPlace; label: string; icon: IconName; hint: string }[] = [
  { id: "now", label: "지금", icon: "home", hint: "오늘: 확인할 것, 새 답, 하던 일" },
  { id: "projects", label: "프로젝트", icon: "project", hint: "폴더별 전체 프로젝트" },
  { id: "docs", label: "문서", icon: "file", hint: "모든 프로젝트의 문서" },
  { id: "activity", label: "활동", icon: "clock", hint: "진행 중인 일과 시간순 기록" },
  { id: "search", label: "찾기", icon: "search", hint: "프로젝트, 대화, 문서 찾기" },
  { id: "vault", label: "볼트", icon: "book", hint: "옵시디언 볼트 (읽기 전용)" },
];

/** Alt+1 … Alt+6 reach the six places (shown in each one's tooltip). */
export const railKey = (index: number) => `Alt+${index + 1}`;

export function Rail({
  modeKeys = false,
  lit,
  attention,
  running,
  compact,
  searchHint,
  onPlace,
  onRunning,
  settings,
  greet = false,
  onGreeted,
  omit,
}: {
  /** The place lit (one at most). */
  lit: RailPlace | null;
  /** Conversations waiting for the person (확인 필요), counted on 지금. */
  attention: number;
  /** Conversations at work, the foot's "진행 N". */
  running: number;
  /** A narrow window: the rail keeps its labels (always shown) and narrows its tiles. */
  compact: boolean;
  searchHint: string;
  onPlace: (place: RailPlace) => void;
  onRunning: () => void;
  /** The settings key and its menu (the same menu as the top bar's ⋯), drawn by the app. */
  settings: ReactNode;
  /** "홈 로고 움직임": the mark's entrance of this launch (once), and its end. */
  greet?: boolean;
  /** The focused view has work modes (Alt+1–5 are theirs, K1): the rail leaves those keys and its tooltips do not offer them. */
  modeKeys?: boolean;
  onGreeted?: (event: { animationName: string }) => void;
  /** Places not offered here (a phone joined to the PC: 볼트). */
  omit?: readonly RailPlace[];
}) {
  const ref = useRef<HTMLElement>(null);
  const place = useRef(onPlace);
  place.current = onPlace;
  const modesRef = useRef(modeKeys);
  modesRef.current = modeKeys;
  // Alt+1 … Alt+6 from anywhere (not while a key is being recorded or typed into a text field's IME).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      const index = /^Digit([1-6])$/.exec(event.code)?.[1];
      if (!index || (modesRef.current && Number(index) <= 5)) return;
      event.preventDefault();
      place.current(RAIL_ITEMS[Number(index) - 1]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // ↑↓ move between the rail's keys (one Tab stop for the rail's places, as a toolbar).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const keys = [...(ref.current?.querySelectorAll<HTMLElement>("[data-rail]") ?? [])];
    const at = keys.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    keys[(next + keys.length) % keys.length]?.focus();
  };
  const tabStop = lit && RAIL_ITEMS.some((item) => item.id === lit) ? lit : "projects";
  return (
    <nav ref={ref} className={`nav-rail${compact ? " compact" : ""}`} aria-label="전역 탐색" onKeyDown={onKeyDown}>
      <button type="button" tabIndex={-1} className={`rail-brand${greet ? " greet" : ""}`} onAnimationEnd={onGreeted} onClick={() => onPlace("now")} title="지금" aria-label="Achmage, 지금">
        <BrandSymbol size={26} />
      </button>
      <ul className="rail-places">
        {RAIL_ITEMS.map((item, index) => {
          if (omit?.includes(item.id)) return null;
          const current = lit === item.id;
          const count = item.id === "now" && attention ? attention : 0;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`rail-key${current ? " current" : ""}`}
                data-rail={item.id}
                aria-current={current ? "page" : undefined}
                aria-label={count ? `${item.label}, 확인 필요 ${count}개` : item.label}
                title={`${item.label}: ${item.id === "search" ? searchHint : item.hint}${modeKeys && index < 5 ? "" : ` (${railKey(index)})`}`}
                tabIndex={item.id === tabStop ? 0 : -1}
                onClick={() => onPlace(item.id)}
              >
                <span className="rail-icon" aria-hidden>
                  <Icon name={item.icon} size={20} />
                  {count ? <span className="rail-count">{count > 9 ? "9+" : count}</span> : null}
                </span>
                <span className="rail-label">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="rail-foot">
        {running ? (
          <button type="button" className="rail-key rail-running" data-rail="running" tabIndex={-1} onClick={onRunning} aria-label={`진행 중 ${running}개, 활동에서 보기`} title={`진행 중 ${running}개, 활동에서 보기`}>
            <span className="rail-icon" aria-hidden>
              <span className="rail-turn" />
            </span>
            <span className="rail-label">{`진행 ${running}`}</span>
          </button>
        ) : null}
        {settings}
      </div>
    </nav>
  );
}
