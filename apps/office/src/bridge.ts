import type { OfficeHostMessage, OfficePageMessage } from "@workbench/contracts";
import { encodeHwpSave, type HwpSaveMetadata, type TabSpot } from "../../../packages/contracts/src/hwp.ts";

// The office page runs on the editors' own origin (apps/host/src/editors.ts). It talks only to the
// Workbench window that embeds it (the parent frame, on the app's origin) and to the gateway, with
// the token the window hands over: it reads and saves this one document.

export type Init = Extract<OfficeHostMessage, { type: "office:init" }>;

/** The origin of the Workbench window around this page. */
const host = (() => {
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  return ancestors?.length ? ancestors[0]! : (new URLSearchParams(location.search).get("host") ?? location.origin);
})();

export function post(message: OfficePageMessage) {
  if (window.parent !== window) window.parent.postMessage(message, host);
}

export function listen(handler: (message: OfficeHostMessage) => void) {
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== host || event.source !== window.parent) return;
    const message = event.data as OfficeHostMessage;
    if (message && typeof message.type === "string") handler(message);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** Say hello and wait for the document this page edits. */
export function handshake(): Promise<Init> {
  return new Promise((resolve) => {
    const stop = listen((message) => {
      if (message.type !== "office:init") return;
      stop();
      resolve(message);
    });
    post({ type: "office:ready" });
  });
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Gateway {
  private token: string;
  constructor(token: string) {
    this.token = token;
    listen((message) => { if (message.type === "office:grant") this.token = message.token; });
  }

  private async call(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
    const response = await fetch(path, { method, headers: { authorization: `Bearer ${this.token}`, ...headers }, body });
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new GatewayError(response.status, json.code ?? "error", json.message ?? response.statusText);
    }
    return response;
  }

  /** The bytes of one revision of a document. */
  async raw(artifactId: string, revision: number) {
    return (await this.call("GET", `/api/artifacts/${artifactId}/raw?revision=${revision}`)).arrayBuffer();
  }

  /** Save edited bytes as the next revision; refused (409) when the document moved on. */
  async saveBytes(artifactId: string, expectedRevision: number, data: ArrayBuffer) {
    // The window may hear of the new revision from the gateway before this answer: it is ours.
    post({ type: "office:saving" });
    const response = await this.call("PUT", `/api/artifacts/${artifactId}/bytes?expectedRevision=${expectedRevision}`, data, { "content-type": "application/octet-stream" });
    return (await response.json()) as { id: string; revision: number; sha256: string };
  }

  async saveText(artifactId: string, expectedRevision: number, text: string) {
    post({ type: "office:saving" });
    const response = await this.call("PUT", `/api/artifacts/${artifactId}/text?expectedRevision=${expectedRevision}`, text, { "content-type": "text/plain; charset=utf-8" });
    return (await response.json()) as { id: string; revision: number; sha256: string };
  }

  async previewInfo(artifactId: string): Promise<{ url: string }> {
    return (await this.call("GET", `/api/artifacts/${artifactId}/html-preview`)).json();
  }

  async updatePreview(artifactId: string, text: string) {
    await this.call("PUT", `/api/artifacts/${artifactId}/html-preview`, text, { "content-type": "text/html; charset=utf-8" });
  }

  async openHwp(artifactId: string, revision: number) {
    const response = await this.call("GET", `/api/artifacts/${artifactId}/hwp/open?revision=${revision}`);
    return { bytes: await response.arrayBuffer(), trackingDropped: response.headers.get("x-workbench-tracking-dropped") === "true", saveBlocked: response.headers.get("x-workbench-save-blocked") === "true" };
  }

  async hwpTabs(artifactId: string, revision: number, bytes: Uint8Array, format?: "hwp" | "hwpx"): Promise<TabSpot[]> {
    return (await this.call("POST", `/api/artifacts/${artifactId}/hwp/tabs?revision=${revision}${format ? `&format=${format}` : ""}`, bytes.slice().buffer)).json();
  }

  async saveHwp(artifactId: string, revision: number, bytes: Uint8Array, metadata: HwpSaveMetadata) {
    post({ type: "office:saving" });
    const response = await this.call("POST", `/api/artifacts/${artifactId}/hwp/save?revision=${revision}`, encodeHwpSave(metadata, bytes), { "content-type": "application/octet-stream" });
    return (await response.json()) as { id: string; revision: number; sha256: string };
  }

  async repairHwp(artifactId: string, revision: number, bytes: Uint8Array, metadata: HwpSaveMetadata) {
    return (await this.call("POST", `/api/artifacts/${artifactId}/hwp/repair?revision=${revision}`, encodeHwpSave(metadata, bytes), { "content-type": "application/octet-stream" })).arrayBuffer();
  }
}

/** Callbacks registered by the editor (`onX(handler)` returns its own removal). */
export class Events {
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  on(name: string) {
    return (handler: (...args: unknown[]) => void) => {
      let set = this.handlers.get(name);
      if (!set) this.handlers.set(name, (set = new Set()));
      set.add(handler);
      return () => set!.delete(handler);
    };
  }
  emit(name: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(name) ?? []) handler(...args);
  }
  has(name: string) {
    return (this.handlers.get(name)?.size ?? 0) > 0;
  }
}

/**
 * A stand-in for an Electron bridge the editor expects but Workbench does not provide: `onX`
 * registrations return a removal function, `consumeX` answers null, plain calls resolve to
 * `fallback[name]` or null. Explicit members win; `absent` members stay missing, for the
 * features the editor only turns on when its host offers them.
 */
export function stubBridge<T extends object>(members: T, fallback: Record<string, unknown> = {}, absent: string[] = []): T {
  const seen = new Set<string>();
  return new Proxy(members, {
    has(target, key) {
      return key in target || (typeof key === "string" && !absent.includes(key));
    },
    get(target, key) {
      if (key in target) return (target as Record<string | symbol, unknown>)[key];
      if (typeof key !== "string" || key === "then" || absent.includes(key)) return undefined;
      if (/^on[A-Z]/.test(key)) return () => () => {};
      if (key.startsWith("consume")) return async () => null;
      if (key in fallback) return async () => fallback[key];
      // Unknown calls answer null; list them once so a missing member is easy to find.
      if (!seen.has(key)) {
        seen.add(key);
        console.debug(`[workbench office] not provided: ${key}`);
      }
      return async () => null;
    },
  });
}
