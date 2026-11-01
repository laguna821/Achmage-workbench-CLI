import { useEffect, useRef, useState } from "react";
import type { Api } from "../api.ts";
import { OFFICE_SETTINGS_CHANNELS, type OfficeSettingsFrameRequest } from "../../../../packages/contracts/src/office-settings.ts";
import { OFFICE_PREFERENCES_CHANNELS } from "../../../../packages/contracts/src/office-preferences.ts";
import { OFFICE_MCP_SETTINGS_CHANNELS } from "../../../../packages/contracts/src/office-mcp.ts";
import { OFFICE_DRIVE_SETTINGS_CHANNELS, type OfficeDriveAttachments } from "../../../../packages/contracts/src/office-drive.ts";
import "../styles/office-settings.css";

/** Only this exact frame may request full Office settings operations. It never gets the host token. */
export function OfficeSettings({ api, theme, onClose, mode = "ai", onPicked, attachmentContext }: { api: Api; theme: "light" | "dark"; onClose(): void; mode?: "ai" | "drive" | "drive-picker"; onPicked?(value: OfficeDriveAttachments): void; attachmentContext?: { artifactId: string; editorToken: string } }) {
  const frame = useRef<HTMLIFrameElement>(null), [page, setPage] = useState<{ origin: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef(crypto.randomUUID()), calls = useRef(new Map<string, AbortController>()), currentTheme = useRef(theme);
  currentTheme.current = theme;
  const announceTheme = () => { if (page) frame.current?.contentWindow?.postMessage({ type: "office-settings:theme", theme: currentTheme.current }, page.origin); };
  useEffect(() => {
    let active = true;
    api.request<{ origin: string; url: string }>("GET", "/api/office-ai/page").then((value) => { if (active) setPage(value); }, (reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [api]);
  useEffect(announceTheme, [theme, page]);
  useEffect(() => {
    if (!page) return;
    let alive = true;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== page.origin) return;
      if (event.data?.type === "office-settings:ready") { announceTheme(); return; }
      if (event.data?.type === "office-settings:cancel") { calls.current.get(event.data.requestId)?.abort(); return; }
      const message = event.data as OfficeSettingsFrameRequest;
      if (message?.type !== "office-settings:request" || typeof message.requestId !== "string" || !/^[\w-]{1,128}$/.test(message.requestId) || !OFFICE_SETTINGS_CHANNELS.has(message.channel) || !Array.isArray(message.args) || message.args.length > 4) return;
      const reply = (value?: unknown, error?: string) => { if (alive) frame.current?.contentWindow?.postMessage({ type: "office-settings:reply", requestId: message.requestId, value, error }, page.origin); };
      if (calls.current.has(message.requestId)) return;
      if (calls.current.size >= 24) { reply(undefined, "진행 중인 설정 요청을 마친 뒤 다시 시도해 주세요."); return; }
      const controller = new AbortController(); calls.current.set(message.requestId, controller);
      const call = async () => {
        const options = { signal: controller.signal };
        if (message.channel.startsWith("drive-picker:")) {
          if (mode !== "drive-picker") throw new Error("첨부 선택창에서만 사용할 수 있습니다.");
          if (message.channel === "drive-picker:cancel") { onClose(); return { ok: true }; }
          const result = await api.request<OfficeDriveAttachments>("POST", "/api/office-drive/attach", { picks: message.args[0], ...attachmentContext }, options);
          if (result.ok) onPicked?.(result);
          return result;
        }
        if (OFFICE_DRIVE_SETTINGS_CHANNELS.has(message.channel)) {
          if (mode === "drive-picker" && !["drive:state", "drive:list"].includes(message.channel)) throw new Error("첨부 선택창의 요청이 아닙니다.");
          const result = await api.request<{ ok?: boolean }>("POST", "/api/office-drive/invoke", { channel: message.channel, args: message.args }, options);
          if (message.channel === "drive:open" && result?.ok) onClose();
          return result;
        }
        if (mode === "drive-picker") throw new Error("첨부 선택창의 요청이 아닙니다.");
        if (OFFICE_PREFERENCES_CHANNELS.has(message.channel)) return api.request("POST", "/api/office-preferences", { channel: message.channel, args: message.args }, options);
        if (message.channel === "ai:get-settings") return api.request("GET", "/api/office-ai/settings", undefined, options);
        if (message.channel === "ai:set-settings") return api.request("PUT", "/api/office-ai/settings", { settings: message.args[0], expectedRevision: message.revision }, options);
        if (OFFICE_MCP_SETTINGS_CHANNELS.has(message.channel)) {
          const value = await api.request<{ path?: string }>("POST", "/api/office-mcp/invoke", { channel: message.channel, args: message.args }, options);
          if (message.channel === "home:open-mcp-log-file" && value?.path) {
            const { revealItemInDir } = await import("@tauri-apps/plugin-opener"); await revealItemInDir(value.path);
          }
          return value;
        }
        return api.request("POST", "/api/office-ai/invoke", { channel: message.channel, args: message.args, owner: owner.current }, options);
      };
      void call().then((value) => reply(value), (reason: Error) => { if (!controller.signal.aborted) reply(undefined, reason.message); }).finally(() => calls.current.delete(message.requestId));
    };
    window.addEventListener("message", receive);
    return () => { alive = false; window.removeEventListener("message", receive); for (const call of calls.current.values()) call.abort(); calls.current.clear(); };
  }, [api, page]);
  return <div className="office-settings-overlay">
    <section className="office-settings-dialog" role="dialog" aria-modal="true" aria-label={mode === "ai" ? "문서 AI 설정" : mode === "drive" ? "Google Drive" : "Drive에서 첨부"}>
      <header><h2>{mode === "ai" ? "문서 AI 설정" : mode === "drive" ? "Google Drive" : "Drive에서 첨부"}</h2><button type="button" className="icon-button" aria-label={mode === "ai" ? "문서 AI 설정 닫기" : "Drive 닫기"} onClick={onClose}>×</button></header>
      {error ? <p role="alert">{error}</p> : page ? <iframe ref={frame} title={mode === "ai" ? "문서 AI 설정 화면" : "Google Drive 화면"} src={`${page.url}?host=${encodeURIComponent(location.origin)}${mode === "ai" ? "" : `&view=${mode}`}`} sandbox="allow-scripts allow-same-origin allow-modals" onLoad={announceTheme} /> : <p role="status">설정을 불러오고 있습니다.</p>}
    </section>
  </div>;
}
