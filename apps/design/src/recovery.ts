import type { DesignDraft } from "@workbench/contracts";

type DraftGateway = {
  keepDraft(id: string, revision: number, text: string): Promise<DesignDraft>;
  removeDraft(id: string, draft: DesignDraft): Promise<unknown>;
};

/** Serialises recovery writes and exact deletes independently of doory's autosave timer. */
export class DesignRecovery {
  private pending = Promise.resolve();
  private observed: string;
  private generation = 0;
  private savedRevision = 0;
  private current: DesignDraft | null = null;
  savedText: string;
  recovered: DesignDraft | null;
  private readonly options: { gateway: DraftGateway; artifactId: string; original: string; recovered?: DesignDraft; onError(message: string): void };
  constructor(options: DesignRecovery["options"]) {
    this.options = options;
    this.observed = this.savedText = options.original;
    this.recovered = options.recovered ?? null;
  }
  private enqueue(run: () => Promise<void>) {
    this.pending = this.pending.then(run).catch((error: unknown) => {
      this.options.onError(`편집 복구본을 보관하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.pending;
  }
  observe(raw: string, revision: number, prepare: () => Promise<string>) {
    if (raw === this.observed) return this.pending;
    this.observed = raw;
    const generation = ++this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      const text = await prepare();
      if (generation !== this.generation) return;
      if (text === this.savedText) {
        if (this.current) await this.remove(this.current);
        return;
      }
      this.current = await this.options.gateway.keepDraft(this.options.artifactId, Math.max(revision, this.savedRevision), text);
    });
  }
  saved(text: string, revision?: number) {
    this.savedText = text;
    if (revision !== undefined) this.savedRevision = Math.max(this.savedRevision, revision);
    return this.enqueue(async () => {
      if (this.current?.text === text) await this.remove(this.current);
      else if (this.current && this.current.baseRevision < this.savedRevision) {
        // Edits made while an earlier autosave was in flight now descend from that successful save.
        this.current = await this.options.gateway.keepDraft(this.options.artifactId, this.savedRevision, this.current.text);
      }
      // An explicit recovery followed by a successful save finishes that recovery, even after editing it.
      if (this.recovered) { await this.remove(this.recovered); this.recovered = null; }
    });
  }
  private async remove(draft: DesignDraft) {
    await this.options.gateway.removeDraft(this.options.artifactId, draft);
    if (this.current === draft) this.current = null;
  }
  async copied(text: string) {
    await this.pending;
    if (this.current?.text === text) await this.remove(this.current);
    if (this.recovered) { await this.remove(this.recovered); this.recovered = null; }
  }
  drain() { return this.pending; }
}
