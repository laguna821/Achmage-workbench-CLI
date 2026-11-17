import type { SequencedEvent, Session, UiPrefs } from "@workbench/contracts";
import chimeUrl from "./assets/sounds/chime.wav";
import bellUrl from "./assets/sounds/bell.wav";
import popUrl from "./assets/sounds/pop.wav";
import riseUrl from "./assets/sounds/rise.wav";
import fallUrl from "./assets/sounds/fall.wav";

// 완료 소리 (0.5.3): a short sound when a conversation's or a document AI's turn ends, a different one
// when it needs the person, one when it fails — also with the window hidden, minimised or another
// project in front. The web view plays it (the main window is only hidden when closed, its
// background throttling is off, and wry lets media play without a gesture on all three systems).
// The files are the app's own, made by scripts/sounds/make-done-sounds.mjs.

export type SoundKind = "done" | "needs" | "failed";
export type SoundId = "chime" | "bell" | "pop" | "rise" | "fall";
export const SOUND_CHOICES: readonly { id: SoundId; label: string; url: string }[] = [
  { id: "chime", label: "맑은 두 음", url: chimeUrl },
  { id: "bell", label: "작은 종", url: bellUrl },
  { id: "pop", label: "톡", url: popUrl },
  { id: "rise", label: "올라가는 세 음", url: riseUrl },
  { id: "fall", label: "내려가는 두 음", url: fallUrl },
];
export const SOUND_KIND_LABEL: Record<SoundKind, string> = { done: "끝났을 때", needs: "확인이 필요할 때", failed: "실패했을 때" };

export type DoneSoundPrefs = { on: boolean; volume: number; done: SoundId; needs: SoundId; failed: SoundId; quietOnScreen: boolean };
// 0.5.3: 45 % for people who never moved the slider (70 was a little loud on a laptop); a stored level is kept.
export const DONE_SOUND_DEFAULTS: DoneSoundPrefs = { on: true, volume: 45, done: "chime", needs: "rise", failed: "fall", quietOnScreen: true };
/** The keys in the gateway's screen preferences (flat, so a partial save never drops a sibling). */
export const DONE_SOUND_KEYS = { on: "doneSound", volume: "doneSoundVolume", done: "doneSoundDone", needs: "doneSoundNeeds", failed: "doneSoundFailed", quietOnScreen: "doneSoundQuietOnScreen" } as const;

const isSound = (value: unknown): value is SoundId => SOUND_CHOICES.some(choice => choice.id === value);
export function doneSoundPrefs(prefs: UiPrefs): DoneSoundPrefs {
  const flag = (key: string, fallback: boolean) => typeof prefs[key] === "boolean" ? prefs[key] as boolean : fallback;
  const sound = (key: string, fallback: SoundId) => isSound(prefs[key]) ? prefs[key] as SoundId : fallback;
  const volume = prefs[DONE_SOUND_KEYS.volume];
  return {
    on: flag(DONE_SOUND_KEYS.on, DONE_SOUND_DEFAULTS.on),
    volume: typeof volume === "number" && Number.isFinite(volume) && volume >= 0 && volume <= 100 ? Math.round(volume) : DONE_SOUND_DEFAULTS.volume,
    done: sound(DONE_SOUND_KEYS.done, DONE_SOUND_DEFAULTS.done),
    needs: sound(DONE_SOUND_KEYS.needs, DONE_SOUND_DEFAULTS.needs),
    failed: sound(DONE_SOUND_KEYS.failed, DONE_SOUND_DEFAULTS.failed),
    quietOnScreen: flag(DONE_SOUND_KEYS.quietOnScreen, DONE_SOUND_DEFAULTS.quietOnScreen),
  };
}

/** The same rule as the host's attention rows (notifications.ts): approval waiting → needs; turn end not stopped by the person → done / failed. */
export function soundKindOf(event: SequencedEvent): SoundKind | null {
  if (event.type !== "item.upserted") return null;
  const item = event.item;
  if (item.kind === "approval") return item.decision === null ? "needs" : null;
  if (item.kind === "turnEnd" && item.cause !== "stop") return item.status === "completed" ? "done" : "failed";
  return null;
}

const RANK: Record<SoundKind, number> = { done: 1, failed: 2, needs: 3 };
/**
 * Never a burst: what arrives within a short gather plays once as the most urgent kind; then for
 * GAP ms nothing sounds — what the last sound already covers (same or lower) is dropped, a more
 * urgent kind waits for the gap's end (needs > failed > done).
 */
export class SoundLimiter {
  static readonly GAP = 1500;
  static readonly GATHER = 120;
  private last: { at: number; kind: SoundKind } | null = null;
  private pending: SoundKind | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly play: (kind: SoundKind) => void;
  private readonly now: () => number;
  constructor(play: (kind: SoundKind) => void, now: () => number = Date.now) { this.play = play; this.now = now; }
  push(kind: SoundKind) {
    const now = this.now(), cooling = this.last !== null && now - this.last.at < SoundLimiter.GAP;
    if (cooling && RANK[kind] <= RANK[this.last!.kind] && this.pending === null) return;
    if (this.pending === null || RANK[kind] > RANK[this.pending]) this.pending = kind;
    if (this.timer !== null) return;
    const wait = cooling ? this.last!.at + SoundLimiter.GAP - now : SoundLimiter.GATHER;
    this.timer = setTimeout(this.flush, Math.max(0, wait));
  }
  private flush = () => {
    this.timer = null;
    const kind = this.pending; this.pending = null;
    if (!kind) return;
    this.last = { at: this.now(), kind };
    this.play(kind);
  };
  close() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; this.pending = null; }
}

export type SoundScreen = { /** The window is shown and focused. */ windowShown: boolean; /** Conversations laid out on screen (sessionsOnScreen). */ onScreen: ReadonlySet<string> };
/** Decides per live event; each item sounds once (an item upserted again, a reconnect, never twice). */
export class DoneSounds {
  private readonly seen = new Set<string>();
  private readonly limiter: Pick<SoundLimiter, "push">;
  constructor(limiter: Pick<SoundLimiter, "push">) { this.limiter = limiter; }
  take(event: SequencedEvent, session: Session | undefined, prefs: DoneSoundPrefs, screen: SoundScreen): SoundKind | null {
    const kind = soundKindOf(event);
    if (!kind || event.type !== "item.upserted") return null;
    const key = `${event.sessionId}:${event.item.id}:${kind}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    if (!prefs.on || prefs.volume <= 0 || session?.muted || session?.archivedAt) return null;
    if (prefs.quietOnScreen && screen.windowShown && screen.onScreen.has(event.sessionId)) return null;
    this.limiter.push(kind);
    return kind;
  }
}

/** Plays a bundled sound through the web view (one element per file, reused). A refused play is silent. */
export function soundPlayer(make: (url: string) => HTMLAudioElement = url => new Audio(url)) {
  const elements = new Map<SoundId, HTMLAudioElement>();
  return (id: SoundId, volume: number) => {
    const choice = SOUND_CHOICES.find(entry => entry.id === id);
    if (!choice || volume <= 0) return;
    let element = elements.get(id);
    if (!element) { element = make(choice.url); element.preload = "auto"; elements.set(id, element); }
    element.volume = Math.min(1, Math.max(0, volume / 100));
    try { element.currentTime = 0; } catch { /* not loaded yet */ }
    void element.play()?.catch(() => undefined);
  };
}
