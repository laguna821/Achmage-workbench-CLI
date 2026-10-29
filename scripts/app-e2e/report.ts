import { writeFileSync } from "node:fs";
import { join } from "node:path";

// PASS/FAIL lines with a detail and the screenshot that shows it, plus observations (INFO) that are
// recorded without a verdict (what a picker lists, what an opener was asked to open).

export type Step = { scenario: string; step: string; ok: boolean; detail: string; shot: string | null };
export type Note = { scenario: string; text: string; data?: unknown };

export class Report {
  readonly outDir: string;
  readonly steps: Step[] = [];
  readonly notes: Note[] = [];

  constructor(outDir: string) {
    this.outDir = outDir;
  }

  path(name: string) {
    return join(this.outDir, name);
  }

  check(scenario: string, step: string, ok: boolean, detail = "", shot: string | null = null) {
    this.steps.push({ scenario, step, ok, detail, shot });
    console.log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${step}${detail ? ` — ${detail}` : ""}${shot ? `\n     shot: ${shot}` : ""}`);
  }

  note(scenario: string, text: string, data?: unknown) {
    this.notes.push({ scenario, text, data });
    console.log(`INFO [${scenario}] ${text}`);
  }

  write(extra: Record<string, unknown> = {}) {
    writeFileSync(join(this.outDir, "results.json"), JSON.stringify({ ...extra, steps: this.steps, notes: this.notes }, null, 2));
  }

  summary() {
    const failed = this.steps.filter((step) => !step.ok).length;
    return `${this.steps.length - failed}/${this.steps.length} passed`;
  }
}
