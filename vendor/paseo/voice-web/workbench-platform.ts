/** Workbench compatibility for Paseo's three app-only imports. No recording or transport logic. */
export const isElectronRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export function generateMessageId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export const i18n = { t: (key: string) => key.endsWith("daemonClientDisconnected") ? "음성 서버 연결이 끊겼습니다." : "음성 서버를 사용할 수 없습니다." };
