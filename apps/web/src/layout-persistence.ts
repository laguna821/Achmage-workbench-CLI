import { focusedPane, setPane, type Layout } from "./panes.ts";
import { activateTab, activeTab, contentKey, findTab, withTabs } from "./tabs.ts";
import type { WorkspaceLayoutRecord } from "@workbench/contracts";
import type { Api } from "./api.ts";

/**
 * Serialize reads and writes per workspace and retain a conflicting local layout until an explicit
 * choice. Reads join the same queue as writes: a read answered after this window's own write landed
 * would otherwise take the window back to the older revision, and its next write would conflict with
 * itself (U38).
 */
export class LayoutPersistence {
  private readonly api: Pick<Api, "layout" | "saveLayout">;
  private readonly known = new Map<string, WorkspaceLayoutRecord | null>();
  private readonly queues = new Map<string, Promise<WorkspaceLayoutRecord | null>>();
  private readonly failures = new Map<string, unknown>();
  constructor(api: Pick<Api, "layout" | "saveLayout">) { this.api = api; }
  read(key: string): Promise<WorkspaceLayoutRecord | null> {
    return this.enqueue(key, async () => {
      const { record } = await this.api.layout(key);
      // What the gateway holds now is what the window knows, also when its revision is lower than
      // before (its data was restored): reads are in the queue, so none can be older than a write.
      this.known.set(key, record); this.failures.delete(key);
      return record;
    });
  }
  private enqueue(key: string, run: () => Promise<WorkspaceLayoutRecord | null>) {
    const next = (this.queues.get(key) ?? Promise.resolve(null)).catch(() => null).then(run);
    this.queues.set(key, next);
    return next;
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
    return this.enqueue(key, save);
  }
}

/**
 * The gateway's stored layout, read after the window opened on this device's copy. When the person
 * already chose something in between (`chosen`: a navigation ran), that choice is not undone: the
 * view they went to stays in front — its tab if the stored layout has one, else added — and the
 * stored tabs are kept.
 */
export function keepChosen<V>(restored: Layout<V>, current: Layout<V>, chosen: boolean): Layout<V> {
  if (!chosen) return restored;
  const shown = activeTab(focusedPane(current));
  const found = findTab(restored, contentKey(shown));
  if (found) return { ...activateTab(restored, found.pane.id, found.tab.id), focus: found.pane.id };
  const target = restored.focus;
  return withTabs({ ...setPane(restored, target, { view: shown.view, workId: shown.workId, sessionId: shown.sessionId }), focus: target }, restored);
}
