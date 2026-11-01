import { dispatch, exposeSettingsBridges, useTransport } from "./platform/electron-renderer.ts";
import { OFFICE_SETTINGS_CHANNELS, OFFICE_FILE_SEARCH_CHANNELS, type OfficeSettingsFrameReply } from "../../../packages/contracts/src/office-settings.ts";

const host = new URLSearchParams(location.search).get("host");
if (!host || window.parent === window) throw new Error("Workbench의 문서 AI 설정 메뉴에서 열어 주세요.");
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
const post = (message: unknown) => window.parent.postMessage(message, host);
let revision: string | undefined, theme = "light", stopped = false;
let fileSearchRevision: string | undefined;
const snapshot = (value: unknown) => value as { revision: string; settings: Record<string, unknown>; legacySecrets: number };
const report = (message: string) => window.dispatchEvent(new CustomEvent("workbench:settings-error", { detail: message }));
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || event.origin !== host) return;
  if (event.data?.type === "office-settings:theme") { theme = event.data.theme === "dark" ? "dark" : "light"; document.documentElement.dataset.theme = theme; return; }
  const data = event.data as OfficeSettingsFrameReply;
  if (data?.type !== "office-settings:reply") return;
  const request = pending.get(data.requestId); if (!request) return;
  pending.delete(data.requestId); window.clearTimeout(request.timer);
  if (data.error) { report(data.error); request.reject(new Error(data.error)); } else request.resolve(data.value);
});
export function request(channel: string, args: unknown[] = []) {
  if (!OFFICE_SETTINGS_CHANNELS.has(channel) || stopped) return Promise.reject(new Error("사용할 수 없는 설정 요청입니다."));
  return new Promise<unknown>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => { pending.delete(requestId); post({ type: "office-settings:cancel", requestId }); reject(new Error("설정 요청의 응답을 기다리지 못했습니다. 다시 확인해 주세요.")); }, 660_000);
    pending.set(requestId, { resolve, reject, timer });
    post({ type: "office-settings:request", requestId, channel, args, revision: OFFICE_FILE_SEARCH_CHANNELS.has(channel) ? fileSearchRevision : revision });
  });
}
function takeSnapshot(value: unknown, announce: boolean) {
  const next = snapshot(value), changed = revision !== undefined && revision !== next.revision;
  revision = next.revision;
  window.dispatchEvent(new CustomEvent("workbench:settings-legacy", { detail: next.legacySecrets }));
  if (announce && changed) dispatch("ai:settings-changed", []);
  return next.settings;
}
useTransport({
  async invoke(channel, args) {
    if (channel === "home:get-file-search-settings" || channel === "home:set-file-search-settings") {
      if (channel === "home:set-file-search-settings" && !fileSearchRevision) fileSearchRevision = snapshot(await request("home:get-file-search-settings")).revision;
      const next = snapshot(await request(channel, args)); fileSearchRevision = next.revision;
      if (channel === "home:set-file-search-settings" && args[0] && typeof args[0] === "object") Object.assign(args[0], next.settings);
      return next.settings;
    }
    if (channel === "ai:get-settings") return takeSnapshot(await request(channel), false);
    if (channel === "ai:set-settings") {
      if (!revision) await request("ai:get-settings").then((value) => takeSnapshot(value, false));
      const settings = takeSnapshot(await request(channel, args), false);
      // Original writeAiSettings returns the very draft it passed to preload. Update that
      // object so the next save uses the server's fresh opaque references, not expired ones.
      if (args[0] && typeof args[0] === "object") Object.assign(args[0], settings);
      dispatch("ai:settings-changed", []); return undefined;
    }
    const result = await request(channel, args);
    if (channel.startsWith("drive:") && !["drive:list", "drive:open"].includes(channel)) dispatch("drive:state-changed", [channel === "drive:state" ? result : await request("drive:state")]);
    if (["ai:free-connect", "ai:free-disconnect", "ai:subscription-metered"].includes(channel)) {
      takeSnapshot(await request("ai:get-settings"), false); dispatch("ai:settings-changed", []);
    }
    if (channel.startsWith("ai:subscription-") && channel !== "ai:subscription-codex-image") {
      const statuses = channel.endsWith("statuses") || channel.endsWith("recheck") ? result : await request("ai:subscription-statuses");
      dispatch("ai:subscription-changed", [statuses]);
    }
    return result;
  },
  send() {},
});
exposeSettingsBridges();
await import("@ieum/apps/shell/src/preload/index.ts");
await import("./settings-view.jsx");
post({ type: "office-settings:ready" });
let polling = false;
const timer = window.setInterval(async () => {
  if (polling || document.hidden || stopped) return;
  polling = true;
  try {
    if (!new URLSearchParams(location.search).has("view")) {
      takeSnapshot(await request("ai:get-settings"), true);
      dispatch("ai:subscription-changed", [await request("ai:subscription-statuses")]);
    }
    dispatch("drive:state-changed", [await request("drive:state")]);
  } catch { /* the bridge already reports the failure; drafts stay mounted */ }
  finally { polling = false; }
}, 2500);
window.addEventListener("pagehide", () => {
  stopped = true; clearInterval(timer);
  for (const [requestId, item] of pending) { clearTimeout(item.timer); post({ type: "office-settings:cancel", requestId }); item.reject(new Error("설정 창을 닫았습니다.")); }
  pending.clear();
});
