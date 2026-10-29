import type { Artifact, DocumentAccess } from "@workbench/contracts";
import type { FontFamily } from "@/types/api";

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

export class Gateway {
  private readonly token: string;
  private readonly blobs = new Map<string, Promise<string>>();
  private access?: DocumentAccess;

  constructor(token: string, access?: DocumentAccess) {
    this.token = token;
    this.access = access;
  }

  setAccess(access: DocumentAccess) { this.access = access; }

  private async request<T>(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    const scoped: Record<string, string> = this.access ? { "x-workbench-view": this.access.viewId, "x-workbench-write": this.access.writeToken ?? "" } : {};
    const response = await fetch(path, { method, headers: { authorization: `Bearer ${this.token}`, ...scoped, ...headers }, body });
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

  exportFile(artifactId: string, file: Blob, name: string) {
    return this.request<{ path: string; name: string; artifactId: string | null }>("POST", `/api/artifacts/${artifactId}/exports`, file, {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(name),
    });
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
      url = fetch(`/api/artifacts/${artifactId}/asset?src=${encodeURIComponent(src)}`, { headers: { authorization: `Bearer ${this.token}` } }).then(async (response) => {
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
