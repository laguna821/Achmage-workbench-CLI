// The window keys at the top bar's right end (0.5.3): 내려놓기, 전체 화면 / 원래 크기로, 닫기 — for desktops
// whose windows have no title bar of their own (niri and other tiling compositors). The desktop shell's
// `window_keys` command acts on the window and says what this desktop can do (window_keys.rs).
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";

/** 설정 › 화면 › 창 단추. */
export type WindowKeysPref = "auto" | "always" | "hidden";
export const WINDOW_KEYS_PREFS: { id: WindowKeysPref; label: string }[] = [{ id: "auto", label: "자동" }, { id: "always", label: "항상" }, { id: "hidden", label: "숨김" }];
export const readWindowKeysPref = (raw: unknown): WindowKeysPref => raw === "always" || raw === "hidden" ? raw : "auto";

/** What the shell knows: the desktop, whether it tiles, what 내려놓기 does, full screen now. */
export type WindowShell = { desktop: string; tiling: boolean; minimize: "minimize" | "tray" | "none"; fullscreen: boolean; did?: string | null };

/** 자동 = shown where the window has no title bar with these buttons (a tiling desktop); never outside the app. */
export function windowKeysShown(pref: WindowKeysPref, shell: WindowShell | null): boolean {
  if (!shell || pref === "hidden") return false;
  return pref === "always" || shell.tiling;
}

/** The words of 설정's row for this computer. */
export function windowKeysNote(shell: WindowShell | null): string {
  if (!shell) return "";
  const place = shell.desktop ? `이 컴퓨터(${shell.desktop})` : "이 컴퓨터";
  return shell.tiling
    ? `${place}는 창에 제목 표시줄이 없어 자동이면 보입니다.${shell.minimize === "tray" ? " 내려놓기는 창을 트레이로 숨깁니다(트레이의 Achmage에서 다시 열기)." : shell.minimize === "none" ? " 이 화면은 창을 내려놓지 못해 내려놓기는 없습니다." : ""}`
    : `${place}는 창의 제목 표시줄에 같은 단추가 있어 자동이면 숨깁니다.`;
}

type Invoke = (action: "state" | "minimize" | "fullscreen" | "close") => Promise<WindowShell>;
const shellInvoke: Invoke = async (action) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WindowShell>("window_keys", { action });
};

/** The shell's answer (null outside the desktop app, or before it answers). */
export function useWindowShell(desktop: boolean, invoke: Invoke = shellInvoke) {
  const [shell, setShell] = useState<WindowShell | null>(null);
  const refresh = useCallback(() => { if (desktop) void invoke("state").then(setShell).catch(() => setShell(null)); }, [desktop, invoke]);
  useEffect(() => {
    refresh();
    if (!desktop) return;
    // Full screen can also end by the compositor's own key: the window's size says so.
    let timer = 0;
    const resized = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 150); };
    window.addEventListener("resize", resized);
    return () => { window.removeEventListener("resize", resized); window.clearTimeout(timer); };
  }, [desktop, refresh]);
  const act = useCallback((action: "minimize" | "fullscreen" | "close") => { void invoke(action).then(setShell).catch(() => undefined); }, [invoke]);
  return { shell, act };
}

export function WindowKeys({ shell, onAct }: { shell: WindowShell; onAct: (action: "minimize" | "fullscreen" | "close") => void }) {
  const full = shell.fullscreen;
  return <div className="window-keys" role="group" aria-label="창">
    {shell.minimize !== "none" ? <button type="button" className="icon-button window-key" aria-label="내려놓기" title={shell.minimize === "tray" ? "내려놓기 · 트레이로 숨김 (트레이의 Achmage에서 다시 열기)" : "내려놓기"} onClick={() => onAct("minimize")}><Icon name="windowMinimize" size={16} /></button> : null}
    <button type="button" className="icon-button window-key" aria-label={full ? "원래 크기로" : "전체 화면"} title={full ? "원래 크기로" : "전체 화면"} onClick={() => onAct("fullscreen")}><Icon name={full ? "fullscreenExit" : "fullscreen"} size={16} /></button>
    <button type="button" className="icon-button window-key window-key-close" aria-label="닫기" title="닫기 · 창만 닫고 작업은 계속됩니다" onClick={() => onAct("close")}><Icon name="x" size={16} /></button>
  </div>;
}
