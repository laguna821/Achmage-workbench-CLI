// Removing a document open in an editor goes through that editor's own leave path — the
// save-on-leave guard its tab uses when it closes (leave-gate.ts, DocumentView's leave guard). The
// removal is sent only after every editor answered "saved, or nothing to save" within a bounded
// time. Dirty flags are only used to decide whether to ask first: an editor that reports late (the
// Office and design editors post theirs from an iframe) says "unknown" and is treated as dirty.

export type EditorState = boolean | "unknown";
/** `same`: the app's own comparison, the editor's text equals the saved revision (information only). */
export type EditorHandle = { dirty: () => EditorState; same?: () => boolean };

export class EditorRegistry {
  private readonly views = new Map<string, Map<string, EditorHandle>>();
  /** A view's handle for a document (null when the view goes). */
  set(artifactId: string, viewId: string, handle: EditorHandle | null) {
    const views = this.views.get(artifactId) ?? new Map<string, EditorHandle>();
    if (handle) views.set(viewId, handle);
    else views.delete(viewId);
    if (views.size) this.views.set(artifactId, views);
    else this.views.delete(artifactId);
  }
  /** What each open view of a document says about unsaved edits. */
  states(artifactId: string): EditorState[] {
    return [...(this.views.get(artifactId)?.values() ?? [])].map((handle) => handle.dirty());
  }
  /** Every view that reports edits holds the saved revision's text, by the app's own comparison. */
  looksSaved(artifactId: string): boolean {
    const reporting = [...(this.views.get(artifactId)?.values() ?? [])].filter((handle) => handle.dirty() !== false);
    return reporting.length > 0 && reporting.every((handle) => handle.same?.() === true);
  }
}

/** Every editor leaves (saves) through its own guard; a failure, or no answer in time, refuses. */
export async function leaveEditors(guards: Array<() => Promise<void>>, timeoutMs = 8000): Promise<void> {
  await Promise.all(guards.map((guard) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("저장을 확인하지 못해 목록에서 빼지 않았습니다. 편집기를 확인한 뒤 다시 해 주세요.")), timeoutMs);
    guard().then(() => { clearTimeout(timer); resolve(); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  })));
}

/**
 * With an editor that is dirty or cannot tell: ask first ("저장하고 계속" / 취소; `certain` says
 * which). Then every open editor leaves through its own path, and only then is the removal sent.
 */
export async function removeAfterSaving<T>(states: EditorState[], ask: (certain: boolean) => Promise<boolean>, leave: () => Promise<void>, send: () => Promise<T>): Promise<T | "cancelled"> {
  if (states.some((state) => state !== false) && !(await ask(states.includes(true)))) return "cancelled";
  await leave();
  return send();
}
