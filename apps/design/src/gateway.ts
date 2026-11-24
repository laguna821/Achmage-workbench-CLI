import type { Artifact, DesignDraft, DocumentAccess } from "@workbench/contracts";
import type { FontFamily } from "@/types/api";
import { listen, post } from "./bridge";

// The Workbench gateway, seen from the design page. Images are fetched with the token and handed to
// Fabric as blob: URLs (an <img> cannot send the Authorization header).

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    // The editor reads a revision conflict by name and shows its own banner.
    if (status === 409) this.name = "RevisionConflictError";
  }
}

/** One read asked of the Workbench window (a phone joined to the PC: this page has no /api/ of its own). */
function relayed(path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = window.setTimeout(() => { stop(); reject(new GatewayError(504, "relay_timeout", "PC에서 디자인을 읽어 오지 못했습니다.")); }, 60_000);
    const stop = listen((message) => {
      if (message.type !== "design:fetched" || message.id !== id) return;
      stop(); window.clearTimeout(timer);
      if (!message.body) { reject(new GatewayError(message.status || 502, "relay_failed", message.message ?? "PC에서 디자인을 읽어 오지 못했습니다.")); return; }
      resolve(new Response(message.body, { status: message.status, headers: { "content-type": message.contentType } }));
    });
    post({ type: "design:fetch", id, path });
  });
}

export class Gateway {
  private readonly token: string;
  private readonly blobs = new Map<string, Promise<string>>();
  private access?: DocumentAccess;
  /** Reads go through the Workbench window (design:fetch) and nothing is written: the phone reads only. */
  private readonly relay: boolean;

  constructor(token: string, access?: DocumentAccess, relay = false) {
    this.token = token;
    this.access = access;
    this.relay = relay;
  }

  setAccess(access: DocumentAccess) { this.access = access; }

  private async request<T>(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    const scoped: Record<string, string> = this.access ? { "x-workbench-view": this.access.viewId, "x-workbench-write": this.access.writeToken ?? "" } : {};
    if (this.relay && method !== "GET") throw new GatewayError(403, "remote_read_only", "휴대폰에서는 디자인을 읽기만 합니다. 고치려면 PC에서 여세요.");
    const response = this.relay ? await relayed(path) : await fetch(path, { method, headers: { authorization: `Bearer ${this.token}`, ...scoped, ...headers }, body });
    const json = (await response.json().catch(() => ({ code: "invalid_response", message: response.statusText }))) as T & { code?: string; message?: string };
    if (!response.ok) throw new GatewayError(response.status, json.code ?? "error", json.message ?? response.statusText);
    return json;
  }

  text(artifactId: string, revision: number | null) {
    return this.request<{ artifact: Artifact; revision: number; text: string; editable: boolean }>(
      "GET",
      `/api/artifacts/${artifactId}/text${revision ? `?revision=${revision}` : ""}`,
    );
  }

  save(artifactId: string, expectedRevision: number, text: string) {
    return this.request<Artifact>("PUT", `/api/artifacts/${artifactId}/text`, JSON.stringify({ expectedRevision, text }), { "content-type": "application/json" });
  }

  upload(artifactId: string, file: Blob, name: string) {
    return this.request<{ src: string }>("POST", `/api/artifacts/${artifactId}/assets`, file, {
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(name),
    });
  }

  exportFile(artifactId: string, file: Blob, name: string, revision: number | null = null) {
    return this.request<{ path: string; name: string; artifactId: string | null }>("POST", `/api/artifacts/${artifactId}/exports`, file, {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(name),
      ...(revision !== null ? { "x-design-revision": String(revision) } : {}),
    });
  }

  drafts(artifactId: string) { return this.request<DesignDraft[]>("GET", `/api/artifacts/${artifactId}/design-drafts`); }
  keepDraft(artifactId: string, baseRevision: number, text: string) {
    return this.request<DesignDraft>("PUT", `/api/artifacts/${artifactId}/design-drafts`, JSON.stringify({ baseRevision, text }), { "content-type": "application/json" });
  }
  removeDraft(artifactId: string, draft: DesignDraft) {
    return this.request<{ removed: boolean }>("DELETE", `/api/artifacts/${artifactId}/design-drafts`, JSON.stringify(draft), { "content-type": "application/json" });
  }
  copy(artifactId: string, baseRevision: number, text: string) {
    return this.request<Artifact>("POST", `/api/artifacts/${artifactId}/design-copy`, JSON.stringify({ baseRevision, text }), { "content-type": "application/json" });
  }

  dispose() {
    for (const url of this.blobs.values()) void url.then((value) => URL.revokeObjectURL(value)).catch(() => {});
    this.blobs.clear();
  }

  fonts() {
    return this.request<{ fonts: { family: string; category: FontFamily["category"]; korean: boolean }[] }>("GET", "/api/fonts");
  }

  /** A URL Fabric can load for a document src: relative paths are the design's own files. */
  resolve(artifactId: string, src: string): Promise<string> {
    if (!src || /^(data|blob|https?):/i.test(src)) return Promise.resolve(src);
    const key = `${artifactId}\n${src}`;
    let url = this.blobs.get(key);
    if (!url) {
      const path = `/api/artifacts/${artifactId}/asset?src=${encodeURIComponent(src)}`;
      url = (this.relay ? relayed(path) : fetch(path, { headers: { authorization: `Bearer ${this.token}` } })).then(async (response) => {
        if (!response.ok) throw new GatewayError(response.status, "asset_missing", `이미지를 불러오지 못했습니다: ${src}`);
        return URL.createObjectURL(await response.blob());
      });
      url.catch(() => this.blobs.delete(key));
      this.blobs.set(key, url);
    }
    return url;
  }

  /** Remember a just-uploaded file under its document src, so it is not downloaded again. */
  remember(artifactId: string, src: string, file: Blob) {
    this.blobs.set(`${artifactId}\n${src}`, Promise.resolve(URL.createObjectURL(file)));
  }
}
