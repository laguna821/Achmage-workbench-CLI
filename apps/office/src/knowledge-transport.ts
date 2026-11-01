import { dispatch, exposeSettingsBridges, useTransport } from "./platform/electron-renderer.ts";
import { KNOWLEDGE_HOME_CHANNELS, type KnowledgeHomeReply } from "../../../packages/contracts/src/knowledge-home.ts";

const host = new URLSearchParams(location.search).get("host");
if (!host || window.parent === window) throw new Error("Workbench의 지식베이스에서 열어 주세요.");
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
let stopped = false;
const post = (value: unknown) => window.parent.postMessage(value, host);
const report = (error: unknown) => window.dispatchEvent(new CustomEvent("workbench:knowledge-error", { detail: error instanceof Error ? error.message : String(error) }));
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || event.origin !== host) return;
  if (event.data?.type === "knowledge:theme") { document.documentElement.dataset.theme = event.data.theme === "dark" ? "dark" : "light"; return; }
  if (event.data?.type === "knowledge:chunk") { dispatch("ai:stream-chunk", [event.data.chunk]); return; }
  if (event.data?.type === "knowledge:refresh") { dispatch("ai:settings-changed", []); window.dispatchEvent(new Event("workbench:knowledge-corpus-changed")); window.dispatchEvent(new Event("workbench:knowledge-skills-changed")); return; }
  const data = event.data as KnowledgeHomeReply;
  if (data?.type !== "knowledge:reply") return;
  const call = pending.get(data.requestId); if (!call) return;
  pending.delete(data.requestId); clearTimeout(call.timer);
  if (data.error) { report(data.error); call.reject(new Error(data.error)); } else call.resolve(data.value);
});
export function homeRequest(channel: string, args: unknown[] = []) {
  if (stopped || !KNOWLEDGE_HOME_CHANNELS.has(channel)) return Promise.reject(new Error("연결되지 않은 지식베이스 요청입니다."));
  return new Promise<unknown>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => { pending.delete(requestId); post({ type: "knowledge:cancel", requestId }); reject(new Error("요청을 완료하지 못했습니다. 저장한 문서가 있는지 확인해 주세요.")); }, 660_000);
    pending.set(requestId, { resolve, reject, timer });
    post({ type: "knowledge:request", requestId, channel, args });
  });
}
useTransport({
  async invoke(channel, args) {
    const result = await homeRequest(channel, args);
    if (channel === "ai:set-settings") {
      if (args[0] && typeof args[0] === "object") Object.assign(args[0], result);
      dispatch("ai:settings-changed", []); return undefined;
    }
    if (channel.startsWith("ai:subscription-") && channel !== "ai:subscription-codex-image") {
      const statuses = channel.endsWith("statuses") || channel.endsWith("recheck") ? result : await homeRequest("ai:subscription-statuses");
      dispatch("ai:subscription-changed", [statuses]);
    }
    return result;
  },
  send() {},
});
exposeSettingsBridges();
const skillCall = <T = unknown>(operation: string, input?: unknown) => homeRequest("home:skills", [{ operation, input }]) as Promise<T>;
const noDocument = () => Promise.reject(new Error("양식 미리보기는 문서 탭에서 사용할 수 있습니다."));
// The original home has no current document/preview. Its cards save instructions;
// template skills open real copies, whose document bridge takes over the request.
Object.assign(window, { aiOfficeUserSkills: {
  list: () => skillCall("list"), read: (id: string) => skillCall("read", { id }),
  aiRead: (id: string) => skillCall("ai-read", { id }), aiReadFile: (id: string, path: string) => skillCall("ai-read-file", { id, path }),
  suggestName: (title: string) => skillCall<string>("suggest-name", { title }),
  checkName: (name: string, forId?: string, card?: unknown) => skillCall("check-name", { name, forId, card }),
  saveFromCard: async (input: unknown) => { const value = await skillCall("save-card", input); window.dispatchEvent(new Event("workbench:knowledge-skills-changed")); return value; },
  openTemplate: (input: Record<string, unknown>) => skillCall("open-template", { ...input, requestId: crypto.randomUUID() }),
  focusTab: (tabId: string) => skillCall("focus-tab", { tabId }),
  openSettings: () => homeRequest("home:skill-settings"),
  onChanged: (listener: () => void) => { window.addEventListener("workbench:knowledge-skills-changed", listener); return () => window.removeEventListener("workbench:knowledge-skills-changed", listener); },
  openPreview: noDocument, previewOriginal: noDocument, finishPreview: noDocument,
  takeHandoff: async () => null, onPreviewEnded: () => () => {},
} });
export const knowledgeReady = () => post({ type: "knowledge:ready" });
const timer = window.setInterval(() => { if (!document.hidden && !stopped) dispatch("ai:settings-changed", []); }, 2500);
window.addEventListener("pagehide", () => {
  stopped = true; clearInterval(timer);
  for (const [requestId, call] of pending) { clearTimeout(call.timer); post({ type: "knowledge:cancel", requestId }); call.reject(new Error("지식베이스 창을 닫았습니다.")); }
  pending.clear();
});
