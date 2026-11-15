// Documents whose unsaved edits the person dropped in an embedded editor (저장하지 않고 옮기기).
// Those editors keep their own recovery copy of unsaved bytes and restore it on the next opening;
// the mark makes that opening ask them not to recover, so they drop the copy instead. Kept in this
// device's storage (as the editors' copies are) until the next opening takes it, so it survives
// closing the app between the choice and that opening.

const KEY = "workbench.discardedEdits";

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}
function write(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids));
    else localStorage.removeItem(KEY);
  } catch { /* Without storage the editor recovers as before. */ }
}

export function markDiscarded(artifactId: string) {
  const ids = read();
  if (!ids.includes(artifactId)) write([...ids, artifactId]);
}

/** True once after `markDiscarded`: the opening that takes it asks the editor not to recover. */
export function takeDiscarded(artifactId: string): boolean {
  const ids = read();
  if (!ids.includes(artifactId)) return false;
  write(ids.filter((entry) => entry !== artifactId));
  return true;
}
