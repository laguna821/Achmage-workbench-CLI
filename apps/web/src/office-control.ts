import { useCallback, useEffect, useRef } from "react";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { windowId } from "./document-session.ts";
import { controlDocument } from "./document-commands.ts";

export function useOfficeControl(api: Api | null, main: boolean, open: (artifact: Artifact) => Promise<void>, onError: (error: unknown) => void) {
  const handlers = useRef({ open, onError }); handlers.current = { open, onError };
  const active = useRef(new Set<string>());
  const notify = useCallback(() => {
    if (!api) return;
    void api.officeControl(windowId, main).then(({ commands }) => {
      for (const command of commands) {
        if (active.current.has(command.id)) continue;
        active.current.add(command.id);
        void (async () => {
          try {
            const reply = command.kind === "renderer" ? await controlDocument(command.viewId, command.request) : await (async () => {
              await handlers.current.open(command.artifact);
              if ("__TAURI_INTERNALS__" in window) {
                const { getCurrentWindow } = await import("@tauri-apps/api/window");
                await getCurrentWindow().show(); await getCurrentWindow().setFocus();
              } else window.focus();
              return { status: "ok" as const, result: { opened: command.artifact.path } };
            })();
            await api.officeControlReply(command.id, windowId, reply);
          } catch (error) {
            await api.officeControlReply(command.id, windowId, { status: "error", error: { reason: "app_unavailable", message: String(error) } }).catch(() => {});
          } finally { active.current.delete(command.id); }
        })();
      }
    }).catch(() => {});
  }, [api, main]);
  useEffect(notify, [notify]);
  useEffect(() => {
    if (!api || !main || !("__TAURI_INTERNALS__" in window)) return;
    let closed = false, stop: (() => void) | undefined;
    const drain = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const paths = await invoke<string[]>("take_open_files");
      for (const path of paths) {
        const reply = await api.openOfficePath(path);
        if (!reply.ok) handlers.current.onError(new Error(reply.error.message));
      }
    };
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen("office-open-files", () => { void drain().catch(handlers.current.onError); });
      if (closed) { unlisten(); return; }
      stop = unlisten; await drain();
    }).catch(error => { if (!closed) handlers.current.onError(error); });
    return () => { closed = true; stop?.(); };
  }, [api, main]);
  return notify;
}
