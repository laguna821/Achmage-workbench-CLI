import { GiB, PRESSURE_MARGIN, lowMarkFor, type MachineFacts } from "./core.ts";

// The resource manager's second step (0.5.4), pure rules: the pressure ladder, which running turn is the least
// urgent, and what this computer can enforce of a per-conversation memory cap.

/**
 * Under memory pressure, in order, one rung at a time:
 * 1 stop admitting (nothing new starts; every next request waits in the line),
 * 2 close idle engines now (the 2.5-minute rule brought forward),
 * 3 put off-screen tabs to sleep now (the window's tab sleep),
 * 4 relieve the least urgent running turn — its engine gives memory back to swap (Linux, own scope; it keeps
 *   running, only slower), and its next request waits. NOT a pause: measured on this machine, stopping an
 *   engine (SIGSTOP or a cgroup freeze) frees no memory and stalls its connection to the model.
 */
export type Stage = 0 | 1 | 2 | 3 | 4;
export type Ladder = { stage: Stage; since: number };
/** A rung is held at least this long before the next one (one sample of the manager is 5 s). */
export const LADDER_STEP_MS = 5_000;

/**
 * Starts below the low mark (rung 1); climbs one rung per LADDER_STEP_MS while memory stays below it; holds its
 * rung inside the margin (between the low mark and the low mark + PRESSURE_MARGIN); comes down to 0 at once
 * only above the margin. So a reading wavering around the low mark starts it once and never makes it flap.
 */
export function ladderAfter(before: Ladder, facts: MachineFacts, now: number): Ladder {
  const low = lowMarkFor(facts.totalBytes);
  if (facts.availableBytes >= low + PRESSURE_MARGIN) return before.stage === 0 ? before : { stage: 0, since: now };
  if (facts.availableBytes >= low) return before;
  if (before.stage === 0) return { stage: 1, since: now };
  if (before.stage < 4 && now - before.since >= LADDER_STEP_MS) return { stage: (before.stage + 1) as Stage, since: now };
  return before;
}

export type RunningTurn = { sessionId: string; shown: boolean; forced: boolean; since: number; bytes: number | null };

/**
 * The running turn that can best wait: never one on screen; one the person did not start with 지금 바로 실행
 * before one they did; then the one holding the most memory; then the one started last.
 */
export function leastUrgent(turns: readonly RunningTurn[]): RunningTurn | null {
  const candidates = turns.filter((turn) => !turn.shown);
  candidates.sort((a, b) => Number(a.forced) - Number(b.forced) || (b.bytes ?? 0) - (a.bytes ?? 0) || b.since - a.since);
  return candidates[0] ?? null;
}

/** 대화당 메모리 상한: 끔, then sizes. */
export const CAP_CHOICES: readonly (number | null)[] = [null, 1 * GiB, 2 * GiB, 3 * GiB, 4 * GiB, 6 * GiB, 8 * GiB];

/**
 * enforced: Linux with cgroup v2, its memory controller and `systemd-run --user --scope` — each Claude
 * conversation's engine (and every command it runs) gets its own scope with MemoryHigh / MemoryMax.
 * unavailable: a Linux without them (the settings say "이 컴퓨터에서는 상한을 걸 수 없습니다").
 * advised: Windows (a Job Object would need a native helper the gateway does not have) and macOS (no per-tree
 * memory cap for an ordinary app): the number is a recommended value only.
 */
export type CapSupport = "enforced" | "unavailable" | "advised";
export type ScopeProbe = { cgroup2: boolean; memory: boolean; systemdRun: boolean };
export function capSupport(platform: string, probe: ScopeProbe | null): CapSupport {
  if (platform === "win32" || platform === "darwin") return "advised";
  if (platform !== "linux" || !probe) return "unavailable";
  return probe.cgroup2 && probe.memory && probe.systemdRun ? "enforced" : "unavailable";
}
