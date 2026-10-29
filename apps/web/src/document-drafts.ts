type TextDraft = { baseRevision: number; text: string; at: number };
const prefix = (artifactId: string) => `workbench.docDraft.${artifactId}`;

/** Each editor retains its own recovery copy; a reader never clears another editor's draft. */
export function keepDraft(artifactId: string, viewId: string, value: TextDraft | null) {
  try {
    const key = `${prefix(artifactId)}.${viewId}`;
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch { /* A failed local copy must not prevent normal revision saving. */ }
}
export function newestDraft(artifactId: string): (TextDraft & { key: string }) | null {
  try {
    const start = prefix(artifactId), found: (TextDraft & { key: string })[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)!;
      if (key !== start && !key.startsWith(`${start}.`)) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key)!);
        if (value && typeof value.text === "string" && Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 1) found.push({ key, text: value.text, baseRevision: value.baseRevision, at: Number(value.at) || 0 });
      } catch { /* Leave unknown entries intact. */ }
    }
    return found.sort((a, b) => b.at - a.at)[0] ?? null;
  } catch { return null; }
}
/** Clear only the exact recovered snapshot after it has been saved, never a newer draft. */
export function clearRecoveredDraft(draft: (TextDraft & { key: string }) | null) {
  if (!draft) return;
  try {
    const stored = JSON.parse(localStorage.getItem(draft.key) ?? "null");
    if (stored?.text === draft.text && stored?.baseRevision === draft.baseRevision && (Number(stored.at) || 0) === draft.at) localStorage.removeItem(draft.key);
  } catch { /* Preserve unknown data. */ }
}
