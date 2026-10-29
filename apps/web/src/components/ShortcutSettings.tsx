import { useEffect, useState } from "react";
import { SHORTCUTS, comboLabel, comboOf, usableCombo, type ShortcutId } from "../shortcuts.ts";
import "../styles/shortcuts.css";

/**
 * ⋯ › 단축키: each action's key combination; press its key cap, then the new combination (Esc
 * leaves it, Backspace puts the app's back). A combination already used by another action is
 * refused with the action's name.
 */
export function ShortcutSettings({ shortcuts, onChange, onRecording }: { shortcuts: Record<ShortcutId, string>; onChange: (id: ShortcutId, combo: string | null) => void; onRecording: (on: boolean) => void }) {
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    onRecording(recording !== null);
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return setRecording(null);
      if (event.key === "Backspace" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        onChange(recording, null);
        setProblem(null);
        return setRecording(null);
      }
      const combo = comboOf(event);
      if (!combo) return;
      if (!usableCombo(combo)) return setProblem("Ctrl이나 Alt를 함께 누르거나 F1~F12를 쓰세요(글자만으로는 입력과 겹칩니다).");
      const taken = SHORTCUTS.find((entry) => entry.id !== recording && shortcuts[entry.id] === combo);
      if (taken) return setProblem(`${comboLabel(combo)}은 「${taken.label}」에 쓰고 있습니다.`);
      onChange(recording, combo);
      setProblem(null);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, shortcuts, onChange, onRecording]);
  useEffect(() => () => onRecording(false), [onRecording]);

  return (
    <div className="shortcut-settings">
      {SHORTCUTS.map((entry) => (
        <div key={entry.id} className="shortcut-row">
          <span>{entry.label}</span>
          <button
            type="button"
            className={`shortcut-key${recording === entry.id ? " recording" : ""}`}
            aria-label={`${entry.label} 단축키 바꾸기 (지금 ${comboLabel(shortcuts[entry.id])})`}
            onClick={() => {
              setProblem(null);
              setRecording(recording === entry.id ? null : entry.id);
            }}
          >
            {recording === entry.id ? "키를 누르세요…" : <kbd>{comboLabel(shortcuts[entry.id])}</kbd>}
          </button>
        </div>
      ))}
      <div className="shortcut-hint muted">{problem ?? (recording ? "Esc 그만두기 · Backspace 기본값" : "칸을 누르고 새 조합을 누릅니다.")}</div>
    </div>
  );
}
