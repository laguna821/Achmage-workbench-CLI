import type { WorkspaceLayoutRecord } from "@workbench/contracts";
import type { Api } from "./api.ts";

/** Serialize writes per workspace and retain a conflicting local layout until an explicit choice. */
export class LayoutPersistence {
  private readonly api: Pick<Api, "layout" | "saveLayout">;
  private readonly known = new Map<string, WorkspaceLayoutRecord | null>();
  private readonly queues = new Map<string, Promise<WorkspaceLayoutRecord | null>>();
  private readonly failures = new Map<string, unknown>();
  constructor(api: Pick<Api, "layout" | "saveLayout">) { this.api = api; }
  async read(key: string) {
    await this.queues.get(key)?.catch(() => undefined);
    const { record } = await this.api.layout(key);
    this.known.set(key, record); this.failures.delete(key);
    return record;
  }
  write(key: string, layout: Record<string, unknown>): Promise<WorkspaceLayoutRecord | null> {
    const json = JSON.stringify(layout);
    const save = async () => {
      if (this.failures.has(key)) throw this.failures.get(key);
      const current = this.known.get(key);
      if (current && JSON.stringify(current.layout) === json) return current;
      try {
        const { record } = await this.api.saveLayout(key, current?.revision ?? 0, layout);
        this.known.set(key, record);
        return record;
      } catch (error) { this.failures.set(key, error); throw error; }
    };
    const next = (this.queues.get(key) ?? Promise.resolve(null)).catch(() => null).then(save);
    this.queues.set(key, next);
    return next;
  }
}
