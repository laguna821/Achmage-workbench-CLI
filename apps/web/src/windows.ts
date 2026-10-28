// A session in a window of its own (design 6.2): the desktop shell opens another window on the
// same UI with `?session=<id>`; that window shows only this session (no sidebar, no home) and the
// window manager tiles it next to the others. Nothing else changes: both windows read the same
// gateway, so they always agree.

const PARAM = "session";

/** The session this window is for, or null in the main window. */
export function windowSession(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(PARAM);
}

/** Point this window's address at another session (switching inside a detached window). */
export function showInWindow(sessionId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(PARAM, sessionId);
  window.history.replaceState(null, "", url.toString());
}

/**
 * "새 창으로 떼어 내기". In the desktop app the shell opens (or brings forward) the window for that
 * session; in a browser a popup window does the same (it inherits this tab's sign-in token).
 */
export async function detachSession(sessionId: string, title: string, desktop: boolean) {
  if (desktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_session_window", { sessionId, title });
    return;
  }
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(PARAM, sessionId);
  window.open(url.toString(), `session-${sessionId}`, "popup,width=820,height=900");
}
