import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "../atomic-write.ts";

// The resource manager's pure rules (0.5.3): how many AI turns may run at once on this computer, who waits
// and in which order, who starts when a slot frees, when memory is too low to start anything, and what one
// turn costs (learned from the engines' process trees). No clock, no process table, no event here — the
// gateway's `ResourceManager` feeds these from what it measures.

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

/** The most turns at once, whatever the memory says (and the most the person can set). */
export const MAX_LIMIT = 32;
/** A request that has waited this long goes first and is no longer kept out by "지금 바로 실행" turns. */
export const AGED_MS = 15 * 60_000;
/** What one turn costs until this computer has measured its own: a Claude Code process with its tools, Codex's share of its app-server. */
export const DEFAULT_COST = { claude: 450 * MiB, codex: 300 * MiB } as const;
/** A learned figure is never taken below this (a reading taken while the process was still starting). */
export const COST_FLOOR = 100 * MiB;
const KEEP_TURNS = 20;

export type Engine = "claude" | "codex";
export type MachineFacts = { totalBytes: number; availableBytes: number; cores: number };
export type LimitSettings = { mode: "auto" | "manual"; manual: number };

/** Kept free for the operating system, the window and everything else the person runs. */
export const reserveFor = (totalBytes: number) => Math.max(GiB, Math.round(totalBytes * 0.1));
/** Below this nothing new starts (memory pressure). */
export const lowMarkFor = (totalBytes: number) => Math.max(512 * MiB, Math.round(totalBytes * 0.05));
/** Pressure ends only this much above the low mark, so it does not flicker. */
export const PRESSURE_MARGIN = 256 * MiB;
/** Most turns wait on the model, but their commands use the processor: two per core, at least two. */
export const ceilingFor = (cores: number) => Math.min(MAX_LIMIT, Math.max(2, 2 * Math.max(1, Math.floor(cores))));

export type Estimate = {
  /** How many may run at once now (자동: from the memory; 직접: the person's number). */
  limit: number;
  /** "약 N개까지 편하게": what the memory allows, before the ceiling (at least 1). */
  comfortable: number;
  ceiling: number;
  /** 전체 메모리. */
  totalBytes: number;
  /** 다른 데 쓰는 몫: what is not left for AI turns (what the rest uses now + the reserve). */
  otherBytes: number;
  reserveBytes: number;
  /** 작업 하나가 쓰는 평균. */
  costBytes: number;
};

/**
 * budget = available now + what running turns' engines already hold − reserve;
 * 자동 limit = clamp(floor(budget / cost), 1, ceiling); 직접 = the person's number in 1…MAX_LIMIT.
 */
export function estimate(facts: MachineFacts, turns: { runningTreeBytes: number; costBytes: number }, settings: LimitSettings = { mode: "auto", manual: 4 }): Estimate {
  const reserveBytes = reserveFor(facts.totalBytes);
  const budget = Math.max(0, facts.availableBytes + Math.max(0, turns.runningTreeBytes) - reserveBytes);
  const cost = Math.max(COST_FLOOR, turns.costBytes);
  const comfortable = Math.max(1, Math.floor(budget / cost));
  const ceiling = ceilingFor(facts.cores);
  const limit = settings.mode === "manual" ? clampManual(settings.manual) : Math.min(comfortable, ceiling);
  return { limit, comfortable, ceiling, totalBytes: facts.totalBytes, otherBytes: Math.max(0, facts.totalBytes - budget), reserveBytes, costBytes: cost };
}

export const clampManual = (value: number) => Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(value) ? Math.round(value) : 1));

/** Pressure starts below the low mark and ends at the low mark + a margin. */
export function pressureAfter(before: boolean, facts: MachineFacts): boolean {
  const low = lowMarkFor(facts.totalBytes);
  return before ? facts.availableBytes < low + PRESSURE_MARGIN : facts.availableBytes < low;
}

/** A request waiting for a slot: its conversation, its id, when it was asked, whether its conversation is on screen. */
export type Waiting = { sessionId: string; requestId: string; at: number; shown: boolean };

/**
 * The line: one entry per conversation (its oldest waiting request — a conversation's own requests keep
 * their order), then: waited ≥ AGED_MS first (oldest first), then conversations on screen, then the rest,
 * each in the order asked.
 */
export function lineOrder<T extends Waiting>(entries: readonly T[], now: number): T[] {
  const first = new Map<string, T>();
  for (const entry of entries) {
    const known = first.get(entry.sessionId);
    if (!known || entry.at < known.at) first.set(entry.sessionId, entry);
  }
  const rank = (entry: T) => (now - entry.at >= AGED_MS ? 0 : entry.shown ? 1 : 2);
  // Stable: two asked in the same millisecond keep the order they came in.
  return [...first.values()].sort((a, b) => rank(a) - rank(b) || a.at - b.at);
}

/**
 * Who starts now, if anyone. Running turns started with "지금 바로 실행" count; but once the head of the line
 * has waited AGED_MS only the ordinary running turns are counted for it, so pressing 지금 바로 실행 again and
 * again cannot keep it waiting. Under memory pressure nothing starts unless nothing runs at all.
 */
export function nextToStart<T extends Waiting>(state: { limit: number; pressure: boolean; running: readonly { forced: boolean }[]; line: readonly T[] }, now: number): T | null {
  const head = state.line[0];
  if (!head) return null;
  if (state.pressure) return state.running.length === 0 ? head : null;
  const counted = now - head.at >= AGED_MS ? state.running.filter((turn) => !turn.forced).length : state.running.length;
  return counted < Math.max(1, state.limit) ? head : null;
}

/** What asks for a slot. Answers to a running turn, a stop, a steer and the plan's go-ahead never wait. */
export type StartKind = "turn" | "document" | "schedule" | "phone" | "handover" | "web" | "approval" | "question" | "stop" | "steer" | "plan-go";
export const neverWaits = (kind: StartKind) => kind === "approval" || kind === "question" || kind === "stop" || kind === "steer" || kind === "plan-go";

/** The reason a request waits, in the person's words. */
export function waitingReason(state: { pressure: boolean; limit: number }): string {
  return state.pressure ? "메모리가 부족해 잠시 기다립니다" : `지금 동시에 ${state.limit}개까지 돌리고 있습니다`;
}

type CostFile = Partial<Record<Engine, number[]>>;

/**
 * What one turn costs, per engine: the mean of the peaks of the last 20 turns' process trees, kept in a
 * small JSON file so a restart does not forget it. Until an engine has a turn measured, its default.
 */
export class CostBook {
  private readonly file: string | null;
  private peaks: Record<Engine, number[]> = { claude: [], codex: [] };
  constructor(file: string | null) {
    this.file = file;
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as CostFile;
      for (const engine of ["claude", "codex"] as const) {
        const list = Array.isArray(raw?.[engine]) ? raw[engine]!.filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0) : [];
        this.peaks[engine] = list.slice(-KEEP_TURNS);
      }
    } catch { /* No file yet, or unreadable: the defaults. */ }
  }
  record(engine: Engine, peakBytes: number) {
    if (!Number.isFinite(peakBytes) || peakBytes <= 0) return;
    this.peaks[engine] = [...this.peaks[engine], Math.round(peakBytes)].slice(-KEEP_TURNS);
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeAtomic(this.file, JSON.stringify(this.peaks));
    } catch { /* Kept in memory; written with the next turn. */ }
  }
  figure(engine: Engine): { bytes: number; learned: boolean; turns: number } {
    const list = this.peaks[engine];
    if (!list.length) return { bytes: DEFAULT_COST[engine], learned: false, turns: 0 };
    return { bytes: Math.max(COST_FLOOR, Math.round(list.reduce((sum, value) => sum + value, 0) / list.length)), learned: true, turns: list.length };
  }
  /** The figure the limit uses: the larger of the engines this computer has measured; the larger default until then. */
  cost(): { bytes: number; learned: boolean } {
    const learned = (["claude", "codex"] as const).map((engine) => this.figure(engine)).filter((figure) => figure.learned);
    if (learned.length) return { bytes: Math.max(...learned.map((figure) => figure.bytes)), learned: true };
    return { bytes: Math.max(DEFAULT_COST.claude, DEFAULT_COST.codex), learned: false };
  }
}
