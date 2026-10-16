import type {
  ApiError,
  Folder,
  Provider,
  SequencedEvent,
  Session,
  Snapshot,
  TranscriptItem,
  UiPrefs,
  Work,
} from "@workbench/contracts";

const TOKEN_KEY = "workbench.token";

/** The desktop shell opens the UI with `?token=`; keep it for this window and drop it from the URL. */
export function readToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_WORKBENCH_TOKEN ?? null;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: ApiError) {
    super(body.message);
    this.status = status;
    this.code = body.code;
  }
}

export class Api {
  private readonly token: string;
  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({ code: "invalid_response", message: response.statusText }))) as T & ApiError;
    if (!response.ok) throw new ApiRequestError(response.status, json);
    return json;
  }

  snapshot = () => this.request<Snapshot>("GET", "/api/snapshot");
  items = (sessionId: string) => this.request<{ seq: number; items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`);
  createFolder = (name: string, parentId: string | null) => this.request<Folder>("POST", "/api/folders", { name, parentId });
  createWork = (title: string, folderId: string | null, cwd: string | null) => this.request<Work>("POST", "/api/works", { title, folderId, cwd });
  updateWork = (workId: string, patch: Partial<Pick<Work, "title" | "folderId" | "activeSessionId">>) =>
    this.request<Work>("PATCH", `/api/works/${workId}`, patch);
  createSession = (workId: string, provider: Provider, options?: { purpose?: string; model?: string | null; effort?: string | null }) =>
    this.request<Session>("POST", `/api/works/${workId}/sessions`, { provider, ...options });
  updateSession = (sessionId: string, patch: { purpose?: string; model?: string | null; effort?: string | null }) =>
    this.request<Session>("PATCH", `/api/sessions/${sessionId}`, patch);
  send = (sessionId: string, requestId: string, text: string) =>
    this.request<{ duplicate: boolean }>("POST", `/api/sessions/${sessionId}/messages`, { requestId, text });
  interrupt = (sessionId: string) => this.request("POST", `/api/sessions/${sessionId}/interrupt`);
  answer = (sessionId: string, itemId: string, decision: "accept" | "decline") =>
    this.request("POST", `/api/sessions/${sessionId}/approvals/${encodeURIComponent(itemId)}`, { decision });
  login = (provider: Provider) => this.request<{ url: string | null; message: string }>("POST", `/api/providers/${provider}/login`);
  refreshProviders = () => this.request("POST", "/api/providers/refresh");

  /**
   * Subscribe to events after `since`. Reconnects with the last seen seq so nothing is applied
   * twice; if the host can no longer replay that far, `onResync` reloads the snapshot.
   */
  savePrefs(prefs: UiPrefs) {
    return this.request<{ prefs: UiPrefs }>("PUT", "/api/prefs", { prefs });
  }

  events(since: number, onEvent: (event: SequencedEvent) => void, onResync: () => void, onStatus: (connected: boolean) => void) {
    let lastSeq = since;
    let source: EventSource | null = null;
    let closed = false;
    let retry: number | null = null;
    const connect = () => {
      source = new EventSource(`/api/events?since=${lastSeq}&token=${encodeURIComponent(this.token)}`);
      source.onopen = () => onStatus(true);
      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as SequencedEvent;
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        onEvent(event);
      };
      source.addEventListener("resync", () => {
        source?.close();
        onResync();
      });
      source.onerror = () => {
        onStatus(false);
        source?.close();
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      source?.close();
    };
  }
}
