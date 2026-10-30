import type { OfficeHostMessage, OfficePageMessage } from "@workbench/contracts";
import { encodeHwpSave, type HwpSaveMetadata, type TabSpot } from "../../../packages/contracts/src/hwp.ts";
import { encodePdfRequest, type PdfRequest, type PdfSaveResult } from "../../../packages/contracts/src/pdf.ts";

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

  private async call(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
    const response = await fetch(path, { method, headers: { authorization: `Bearer ${this.token}`, ...headers }, body, signal });
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new GatewayError(response.status, json.code ?? "error", json.message ?? response.statusText);
    }
    return response;
  }

  setToken(token: string) { this.token = token; }
  /** Capture the capability for one run; switching panes must not retarget its requests. */
  aiSession(artifactId: string) {
    const token = this.token, base = `/api/artifacts/${artifactId}/ai/`;
    const call = (operation: string, body?: unknown, signal?: AbortSignal) => this.call(body === undefined ? "GET" : "POST", `${base}${operation}`, body === undefined ? undefined : JSON.stringify(body), { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal);
    return {
      json: async <T = unknown>(operation: string, body?: unknown, signal?: AbortSignal): Promise<T> => (await call(operation, body, signal)).json(),
      stream: async (body: unknown, chunk: (value: unknown) => void, signal?: AbortSignal) => {
        const response = await call("stream", body, signal);
        if (!response.body) throw new Error("AI 응답 스트림을 열지 못했습니다.");
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = "", bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            buffer += decoder.decode(next.value, { stream: !next.done });
            bytes += next.value?.byteLength ?? 0;
            if (buffer.length > 4_000_000 || bytes > 64_000_000) throw new Error("AI 응답의 크기 한도를 넘었습니다.");
            let end: number;
            while ((end = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              if (line.trim()) chunk(JSON.parse(line));
            }
            if (next.done) { if (buffer.trim()) chunk(JSON.parse(buffer)); break; }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      },
    };
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

  async textAssets(artifactId: string): Promise<{ baseUrl: string }> {
    return (await this.call("GET", `/api/artifacts/${artifactId}/assets`)).json();
  }

  async saveImage(artifactId: string, revision: number, bytes: ArrayBuffer, name?: string): Promise<string> {
    const response = await this.call("POST", `/api/artifacts/${artifactId}/image?expectedRevision=${revision}&name=${encodeURIComponent(name ?? "image")}`, bytes, { "content-type": "application/octet-stream" });
    return (await response.json() as { path: string }).path;
  }

  async readImage(artifactId: string, src: string): Promise<{ base64: string; mime: string }> {
    return (await this.call("GET", `/api/artifacts/${artifactId}/image?src=${encodeURIComponent(src)}`)).json();
  }

  async updatePreview(artifactId: string, text: string) {
    await this.call("PUT", `/api/artifacts/${artifactId}/html-preview`, text, { "content-type": "text/html; charset=utf-8" });
  }

  async openHwp(artifactId: string, revision: number) {
    const response = await this.call("GET", `/api/artifacts/${artifactId}/hwp/open?revision=${revision}`);
    return { bytes: await response.arrayBuffer(), trackingDropped: response.headers.get("x-workbench-tracking-dropped") === "true", saveBlocked: response.headers.get("x-workbench-save-blocked") === "true" };
  }

  async openMindmap(artifactId: string, revision: number): Promise<{ status: string; bytes?: Uint8Array }> {
    const response = await this.call("GET", `/api/artifacts/${artifactId}/mindmap/open?revision=${revision}`);
    if (response.headers.get("content-type")?.includes("application/json")) return response.json();
    return { status: "ok", bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  async openEpub<T>(artifactId: string, revision: number, restored?: ArrayBuffer): Promise<T> {
    return (await this.call("POST", `/api/artifacts/${artifactId}/epub/open?revision=${revision}${restored ? "&restore=1" : ""}`, restored)).json();
  }

  async epub<T = unknown>(artifactId: string, session: string, operation: string, args: unknown = {}): Promise<T> {
    if (operation === "save") post({ type: "office:saving" });
    return (await this.call("POST", `/api/artifacts/${artifactId}/epub/${operation}?session=${session}`, JSON.stringify(args), { "content-type": "application/json" })).json();
  }

  async epubCheckpoint(artifactId: string, session: string) {
    const response = await this.call("POST", `/api/artifacts/${artifactId}/epub/checkpoint?session=${session}`);
    return { bytes: await response.arrayBuffer(), baseRevision: Number(response.headers.get("x-epub-revision")), checkpoint: response.headers.get("x-epub-checkpoint") };
  }

  closeEpub(artifactId: string, session: string) {
    return fetch(`/api/artifacts/${artifactId}/epub/close?session=${session}`, { method: "POST", headers: { authorization: `Bearer ${this.token}` }, keepalive: true });
  }

  async checkMindmap(artifactId: string, revision: number, bytes: Uint8Array): Promise<{ status: string }> {
    return (await this.call("POST", `/api/artifacts/${artifactId}/mindmap/check?revision=${revision}`, bytes.slice().buffer)).json();
  }

  async saveMindmap(artifactId: string, revision: number, bytes: Uint8Array): Promise<{ revision: number }> {
    post({ type: "office:saving" });
    return (await this.call("POST", `/api/artifacts/${artifactId}/mindmap/save?revision=${revision}`, bytes.slice().buffer)).json();
  }

  async pdf<T = unknown>(artifactId: string, revision: number, operation: string, request: PdfRequest, source?: ArrayBuffer): Promise<T> {
    if (["save", "blank-page", "page-size", "crop"].includes(operation)) post({ type: "office:saving" });
    const response = await this.call("POST", `/api/artifacts/${artifactId}/pdf/${operation}?revision=${revision}`, encodePdfRequest(request, source), { "content-type": "application/octet-stream" });
    return (operation === "recover" ? response.arrayBuffer() : response.json()) as Promise<T>;
  }

  savePdf(artifactId: string, revision: number, request: PdfRequest, source?: ArrayBuffer) {
    return this.pdf<PdfSaveResult>(artifactId, revision, "save", request, source);
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
