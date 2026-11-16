/**
 * What the document's AI turn is doing, told to whoever draws it (the Hangul editor's hold line and
 * its dock status). Only reports; never changes a turn. Every format's turn reports here; only the
 * Hangul page listens today.
 *
 * - `start`: a turn was sent from this view (before preparation).
 * - `tool`: a tool line started (`running`) or ended; `edit` when the tool changes the document.
 * - `text`: the answer grew.
 * - `alive`: a sign of life without anything to show (an observation, a heartbeat).
 * - `remote`: the turn is owned by another renderer (the independent executor) — the document is
 *   held for its whole length, see `hwp-hold.ts`.
 * - `observed`: a reopened view found a running executor turn it did not start (`turnId`), or none.
 * - `end`: the turn ended (completed / failed / interrupted), or this view lost it (`lost`).
 */
export type TurnActivity =
  | { kind: "start" }
  | { kind: "tool"; id: string; name: string; title?: string; status: "running" | "completed" | "failed"; edit: boolean }
  | { kind: "text"; text: string }
  | { kind: "alive" }
  | { kind: "remote"; turnId: string }
  | { kind: "observed"; turnId: string | null }
  | { kind: "end"; status: "completed" | "failed" | "interrupted" | "lost"; error?: string };

const listeners = new Set<(event: TurnActivity) => void>();
export function onTurnActivity(listener: (event: TurnActivity) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function reportTurnActivity(event: TurnActivity) {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* a drawing failure never changes the turn */ }
  }
}

/**
 * The tools that change a Hangul document (vendor apps/hwp/src/renderer/ai/hwp-skill.ts). Named, not
 * guessed: a tool not in this list reads. (`make_hangul_document` makes a NEW file beside it and
 * never changes the open document, so it holds nothing.)
 */
export const HWP_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "replace_text", "replace_all", "insert_paragraphs", "delete_paragraph", "insert_table", "insert_image",
  "format_text", "format_paragraph", "replace_selection", "format_selection", "create_style", "edit_style",
  "merge_cells", "split_cell", "format_cells", "fill_cells", "check_boxes", "add_to_table", "remove_from_table",
  "delete_table", "fill_field", "insert_toc", "refresh_toc", "insert_note", "edit_note", "delete_note",
]);

