// Keyboard shortcuts the person can change (⋯ › 단축키): one key combination per action, kept in
// the app's prefs (`shortcuts`). "Ctrl" also means Cmd on macOS, as the app's shortcuts always did.
// Letters and digits are read by their physical key, so a Korean input mode does not break them.

export type ShortcutId = "palette" | "content" | "newWork" | "otherPane" | "navigator";

export const SHORTCUTS: { id: ShortcutId; label: string; fallback: string }[] = [
  { id: "palette", label: "찾기·명령 상자", fallback: "Ctrl+K" },
  { id: "content", label: "내용으로 찾기", fallback: "Ctrl+Shift+F" },
  { id: "newWork", label: "새 작업", fallback: "Ctrl+N" },
  // F6 moves between panes in many apps; two panes are optional, so a key that types nothing.
  { id: "otherPane", label: "다른 칸으로 (두 칸일 때)", fallback: "F6" },
  // Notebook Navigator's own key for "focus the navigator"; it opens the sidebar when hidden.
  { id: "navigator", label: "내비게이터로", fallback: "Ctrl+Shift+E" },
];

type KeyPress = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

const MODIFIERS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "Process", "Unidentified", "Dead", "HangulMode", "HanjaMode"]);

/** The combination a key press makes ("Ctrl+Shift+K"), or null for a modifier alone. */
export function comboOf(event: KeyPress): string | null {
  if (MODIFIERS.has(event.key)) return null;
  const code = event.code ?? "";
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** A combination the app can take: with Ctrl or Alt (plain keys are for typing), or a function key. */
export const usableCombo = (combo: string) => /^(Ctrl|Alt)\+/.test(combo) || /(^|\+)F([1-9]|1[0-2])$/.test(combo);

/** The combinations in use: the person's, else the app's. */
export function shortcutsOf(prefs: Record<string, unknown> | null | undefined): Record<ShortcutId, string> {
  const saved = (prefs?.shortcuts && typeof prefs.shortcuts === "object" ? prefs.shortcuts : {}) as Record<string, unknown>;
  return Object.fromEntries(SHORTCUTS.map((entry) => [entry.id, typeof saved[entry.id] === "string" && usableCombo(saved[entry.id] as string) ? (saved[entry.id] as string) : entry.fallback])) as Record<ShortcutId, string>;
}

/** How a combination reads on a key cap: "Ctrl K". */
export const comboLabel = (combo: string) => combo.split("+").join(" ");
