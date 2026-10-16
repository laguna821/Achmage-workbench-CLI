import type {
  ApiError,
  Artifact,
  ArtifactRevision,
  DocRef,
  Handoff,
  Proposal,
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
  send = (sessionId: string, requestId: string, text: string, refs: DocRef[] = []) =>
    this.request<{ duplicate: boolean }>("POST", `/api/sessions/${sessionId}/messages`, { requestId, text, refs });
  handoff = (request: { requestId: string; sourceSessionId: string; targetSessionId: string; text: string; refs: DocRef[] }) =>
    this.request<Handoff>("POST", "/api/handoffs", request);
  openFile = (workId: string, path: string) => this.request<Artifact>("POST", `/api/works/${workId}/artifacts`, { path });
  artifactText = (artifactId: string, revision?: number) =>
    this.request<{ artifact: Artifact; revision: number; text: string; editable: boolean; view: boolean }>(
      "GET",
      `/api/artifacts/${artifactId}/text${revision ? `?revision=${revision}` : ""}`,
    );
  saveArtifact = (artifactId: string, expectedRevision: number, text: string) =>
    this.request<Artifact>("PUT", `/api/artifacts/${artifactId}/text`, { expectedRevision, text });
  pages = (artifactId: string, revision?: number) =>
    this.request<{ revision: number; pages: { page: number; width: number; height: number; svg: string }[] }>(
      "GET",
      `/api/artifacts/${artifactId}/pages${revision ? `?revision=${revision}` : ""}`,
    );
  revisions = (artifactId: string) => this.request<ArtifactRevision[]>("GET", `/api/artifacts/${artifactId}/revisions`);
  adoptDisk = (artifactId: string) => this.request<Artifact>("POST", `/api/artifacts/${artifactId}/adopt-disk`);
  revert = (artifactId: string, toRevision: number) => this.request<Artifact>("POST", `/api/artifacts/${artifactId}/revert`, { toRevision });
  previewUrl = (artifactId: string, revision?: number) =>
    this.request<{ url: string; revision: number }>("POST", `/api/artifacts/${artifactId}/preview${revision ? `?revision=${revision}` : ""}`);
  editPdf = (artifactId: string, edit: { rotate?: { pages: number[]; degrees: number }[]; delete?: number[] }) =>
    this.request<Artifact>("POST", `/api/artifacts/${artifactId}/pdf-edit`, edit);
  proposal = (proposalId: string) =>
    this.request<{ proposal: Proposal; artifact: Artifact; base: string; proposed: string; current: string }>("GET", `/api/proposals/${proposalId}`);
  applyProposal = (proposalId: string) => this.request<{ proposal: Proposal; artifact: Artifact }>("POST", `/api/proposals/${proposalId}/apply`);
  discardProposal = (proposalId: string) => this.request<Proposal>("POST", `/api/proposals/${proposalId}/discard`);
  /** Raw bytes of a revision (PDF viewer). */
  async raw(artifactId: string, revision?: number): Promise<ArrayBuffer> {
    const response = await fetch(`/api/artifacts/${artifactId}/raw${revision ? `?revision=${revision}` : ""}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new ApiRequestError(response.status, { code: "raw_failed", message: response.statusText });
    return response.arrayBuffer();
  }
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
