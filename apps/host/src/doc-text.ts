// Search over Hangul and Office documents (design §7, P0): the index reads them through their text
// view — the embedded rhwp WASM for Hangul, IeumOffice for Word, PowerPoint and Excel — made
// in the background after a revision is recorded, one document at a time. Until the new text is
// ready the previous entry stays (and for good when no tool can read the file here). No AI.

/** Index one revision (its text view, made when not kept yet); throws or does nothing when it cannot. */
export type IndexJob = (artifactId: string, revision: number) => Promise<void>;

export class BackgroundIndex {
  /** Revisions waiting, by document (a newer revision takes the place of one still waiting). */
  private readonly waiting = new Map<string, number>();
  private running: Promise<void> | null = null;
  private readonly job: IndexJob;

  constructor(job: IndexJob) {
    this.job = job;
  }

  /** Index this revision after the ones already waiting. */
  add(artifactId: string, revision: number) {
    this.waiting.set(artifactId, Math.max(revision, this.waiting.get(artifactId) ?? 0));
    this.running ??= this.drain();
  }

  /** Resolves once nothing waits or runs (tests). */
  async settled() {
    while (this.running) await this.running;
  }

  private async drain() {
    // Never inside the caller's work (a revision is being recorded): a moment later.
    await new Promise((done) => setImmediate(done));
    while (this.waiting.size) {
      const [artifactId, revision] = this.waiting.entries().next().value!;
      this.waiting.delete(artifactId);
      try {
        await this.job(artifactId, revision);
      } catch {
        // No tool, a file it cannot read, or the database closing: the entry stays as it was.
      }
    }
    this.running = null;
  }
}
