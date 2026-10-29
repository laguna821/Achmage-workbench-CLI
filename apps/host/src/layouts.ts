import { GLOBAL_LAYOUT, validWorkspaceLayout, type WorkspaceLayoutRecord } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";
import type { Workspaces } from "./workspaces.ts";

/** Independent records keep large/many layouts out of the 64 KB global preferences object. */
export class WorkspaceLayouts {
  private readonly store: Store;
  private readonly workspaces: Workspaces;
  constructor(store: Store, workspaces: Workspaces) {
    this.store = store; this.workspaces = workspaces;
    const prefs = store.getMeta("ui.prefs");
    if (prefs && !store.getMeta("layouts.legacyPrefs")) store.setMeta("layouts.legacyPrefs", prefs);
  }
  private key(id: string) {
    if (id !== GLOBAL_LAYOUT) this.workspaces.get(id);
    return `workspace-layout:${id}`;
  }
  read(id: string): WorkspaceLayoutRecord | null {
    const raw = this.store.getMeta(this.key(id));
    return raw ? JSON.parse(raw) as WorkspaceLayoutRecord : null;
  }
  write(id: string, expectedRevision: unknown, layout: unknown): WorkspaceLayoutRecord {
    const key = this.key(id);
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0 || !validWorkspaceLayout(layout)) throw new HttpError(400, "invalid_layout", "탭과 창 배치 형식이 올바르지 않습니다.");
    if (JSON.stringify(layout).length > 512_000) throw new HttpError(413, "layout_too_large", "이 작업공간의 화면 상태가 너무 큽니다.");
    return this.store.transaction(() => {
      const current = this.read(id);
      if ((current?.revision ?? 0) !== expectedRevision) throw new HttpError(409, "layout_conflict", "다른 창에서 이 작업공간의 배치를 바꿨습니다. 현재 배치는 유지했습니다.");
      const record: WorkspaceLayoutRecord = { key: id, revision: Number(expectedRevision) + 1, layout, updatedAt: Date.now() };
      this.store.setMeta(key, JSON.stringify(record));
      return record;
    });
  }
}
