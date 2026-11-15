import { focusedPane, setPane, type Layout } from "./panes.ts";
import { activateTab, activeTab, contentKey, findTab, withTabs } from "./tabs.ts";
import { DEVICE_LAYOUT, GLOBAL_LAYOUT, type WorkspaceLayoutRecord } from "@workbench/contracts";
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

/**
 * Which stored record this window reads and writes (skin 2 · B). A phone or another remote client
 * keeps its own record (`DEVICE_LAYOUT`, resolved by the device gateway to `device:<its id>`), so it
 * never contends with the desktop over `global`. The desktop keeps its chosen workspace scope while
 * that workspace exists, else `global`.
 */
export function layoutKey({ remote, scope, workspaces }: { remote: boolean; scope: unknown; workspaces: Record<string, unknown> }): string {
  if (remote) return DEVICE_LAYOUT;
  return typeof scope === "string" && (scope === GLOBAL_LAYOUT || Object.hasOwn(workspaces, scope)) ? scope : GLOBAL_LAYOUT;
}

/** The one quiet notice after a restore that skipped tabs (nothing on disk is lost by skipping a tab). */
export const skippedNotice = (skipped: number, ofGoneProjects = 0) => {
  // Tabs of a project that no longer exists are said for what they are (technical review M10).
  const gone = Math.min(ofGoneProjects, skipped), other = skipped - gone;
  const parts = [gone ? `지운 프로젝트의 탭 ${gone}개를 닫았습니다.` : "", other ? `탭 ${other}개${gone ? "는" : "를"} 열 수 없어 건너뛰었습니다. 대화와 문서는 그대로 있습니다.` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
};
