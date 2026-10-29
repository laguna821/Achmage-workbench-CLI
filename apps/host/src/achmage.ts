import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AchmageBrief } from "@workbench/contracts";

// The user's Achmage runtime, when this computer has one: a work's brief for the project page,
// by the project note's `achmage_work` key. Read-only and without a model (`work-brief`); what it
// returns is shown as a record, never followed. Nothing at all on a computer without Achmage.

const WORK_ID = /^work-[0-9a-f]{8,64}$/;
const KEEP_MS = 10 * 60_000;

/** A brief as the launcher prints it (only the fields shown). */
type BriefJson = {
  status?: string;
  candidates?: { workId?: string; title?: string; lastCapturedAt?: string; devices?: string[] }[];
  context?: unknown;
};

/** The first readable summary in a brief's context, if it has one (its shape varies by work). */
function summaryOf(context: unknown): string | null {
  if (!context || typeof context !== "object") return null;
  for (const key of ["summary", "goal", "lastResult", "next", "nextAction"]) {
    const value = (context as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 400);
  }
  return null;
}

export function briefFrom(workId: string, json: BriefJson): AchmageBrief {
  const candidate = json.candidates?.find((entry) => entry.workId === workId) ?? null;
  return {
    workId,
    found: Boolean(candidate),
    title: candidate?.title ?? null,
    lastCapturedAt: candidate?.lastCapturedAt ? Date.parse(candidate.lastCapturedAt) || null : null,
    devices: candidate?.devices ?? [],
    summary: summaryOf(json.context),
  };
}

export class Achmage {
  private readonly launcher: string;
  private readonly state: string;
  private readonly kept = new Map<string, { at: number; brief: Promise<AchmageBrief | null> }>();

  constructor(launcher = process.env.WORKBENCH_ACHMAGE_LAUNCHER ?? join(homedir(), ".local/state/achmage/achmage-launcher.py"), state = process.env.WORKBENCH_ACHMAGE_STATE ?? join(homedir(), ".local/state/achmage")) {
    this.launcher = launcher;
    this.state = state;
  }

  get available() {
    return existsSync(this.launcher);
  }

  /** A work's brief (kept ten minutes), or null: no Achmage here, not a work id, or it did not answer. */
  brief(workId: string): Promise<AchmageBrief | null> {
    if (!WORK_ID.test(workId) || !this.available) return Promise.resolve(null);
    const kept = this.kept.get(workId);
    if (kept && Date.now() - kept.at < KEEP_MS) return kept.brief;
    const brief = new Promise<AchmageBrief | null>((done) => {
      execFile("python3", [this.launcher, "--state", this.state, "work-brief", "--work-id", workId, "--max-chars", "4000"], { timeout: 20_000, maxBuffer: 1_000_000 }, (error, stdout) => {
        if (error) return done(null);
        try {
          done(briefFrom(workId, JSON.parse(stdout) as BriefJson));
        } catch {
          done(null);
        }
      });
    });
    this.kept.set(workId, { at: Date.now(), brief });
    return brief;
  }
}
