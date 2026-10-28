import type {
  AgentBrowserStatus,
  ApiError,
  Artifact,
  Attachment,
  EngineCommand,
  ImportCandidate,
  ImportRequest,
  ArtifactRevision,
  CreateTarget,
  DocImageResult,
  DocRef,
  DocumentTools,
  DrawRequest,
  DrawResult,
  EditorGrant,
  ExportMarkdownRequest,
  ExportMarkdownResult,
  Handoff,
  ImageUploadCheck,
  ImageUploadInput,
  ImageUploadView,
  IntegrationsView,
  LinkTurn,
  Proposal,
  Folder,
  Provider,
  SearchResult,
  SendResult,
  SequencedEvent,
  Session,
  Snapshot,
  SessionLink,
  StartLinkRequest,
  Timeline,
  TranscriptItem,
  UiPrefs,
  UpdateFolderRequest,
  UpdateSessionRequest,
  UpdateWorkRequest,
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
  updateFolder = (folderId: string, patch: UpdateFolderRequest) => this.request<Folder>("PATCH", `/api/folders/${folderId}`, patch);
  search = (query: string, options: { provider?: Provider | null; archived?: boolean; folderId?: string | null } = {}) => {
    const params = new URLSearchParams({ q: query });
    if (options.provider) params.set("provider", options.provider);
    if (options.archived) params.set("archived", "1");
    if (options.folderId) params.set("folderId", options.folderId);
    return this.request<SearchResult>("GET", `/api/search?${params}`);
  };
  exportMarkdown = (sessionId: string, request: ExportMarkdownRequest) => this.request<ExportMarkdownResult>("POST", `/api/sessions/${sessionId}/export`, request);
  createWork = (title: string, folderId: string | null, cwd: string | null) => this.request<Work>("POST", "/api/works", { title, folderId, cwd });
  updateWork = (workId: string, patch: UpdateWorkRequest) => this.request<Work>("PATCH", `/api/works/${workId}`, patch);
  createSession = (workId: string, provider: Provider, options?: { purpose?: string; model?: string | null; effort?: string | null; browser?: boolean }) =>
    this.request<Session>("POST", `/api/works/${workId}/sessions`, { provider, ...options });
  updateSession = (sessionId: string, patch: UpdateSessionRequest) => this.request<Session>("PATCH", `/api/sessions/${sessionId}`, patch);
  /** A new Markdown page in the work folder. */
  createPage = (workId: string, name = "") => this.request<Artifact>("POST", `/api/works/${workId}/pages`, { name });
  /** "가져오기": conversations an engine keeps on this computer, and continuing one here. */
  importCandidates = (provider: Provider, query: string) =>
    this.request<{ candidates: ImportCandidate[] }>("GET", `/api/import?${new URLSearchParams({ provider, q: query })}`).then((result) => result.candidates);
  importSession = (request: ImportRequest) => this.request<Session>("POST", "/api/import", request);
  /** "/" in the input: the session engine's commands and skills. */
  commands = (sessionId: string) => this.request<{ commands: EngineCommand[] }>("GET", `/api/sessions/${sessionId}/commands`);
  /** Compact the conversation now (the engine also does so on its own when the context is full). */
  compact = (sessionId: string) => this.request<{ ok: boolean }>("POST", `/api/sessions/${sessionId}/compact`);
  send = (
    sessionId: string,
    requestId: string,
    text: string,
    refs: DocRef[] = [],
    create: CreateTarget | null = null,
    mode: "auto" | "steer" | "queue" = "auto",
    attachments: Attachment[] = [],
    plan = false,
  ) => this.request<SendResult>("POST", `/api/sessions/${sessionId}/messages`, { requestId, text, refs, create, mode, attachments, plan });
  /** A pasted or dropped file, kept by the gateway until a request names it. */
  async uploadAttachment(file: File): Promise<Attachment> {
    const response = await fetch("/api/attachments", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "붙여넣은 이미지.png") },
      body: file,
    });
    const json = (await response.json().catch(() => ({ code: "invalid_response", message: response.statusText }))) as Attachment & ApiError;
    if (!response.ok) throw new ApiRequestError(response.status, json);
    return json;
  }
  /** Requests waiting for the turn to end: send now (steer when possible), change, or drop. */
  sendQueued = (sessionId: string, queuedId: string) => this.request<SendResult>("POST", `/api/sessions/${sessionId}/queue/${encodeURIComponent(queuedId)}/send`);
  updateQueued = (sessionId: string, queuedId: string, text: string) => this.request<Session>("PATCH", `/api/sessions/${sessionId}/queue/${encodeURIComponent(queuedId)}`, { text });
  cancelQueued = (sessionId: string, queuedId: string) => this.request<Session>("DELETE", `/api/sessions/${sessionId}/queue/${encodeURIComponent(queuedId)}`);
  /** "그림": draw with GPT Image through Codex; the picture comes back as a card in this conversation. */
  draw = (sessionId: string, request: DrawRequest) => this.request<DrawResult>("POST", `/api/sessions/${sessionId}/images`, request);
  handoff = (request: { requestId: string; sourceSessionId: string; targetSessionId: string; text: string; refs: DocRef[]; attachments?: Attachment[] }) =>
    this.request<Handoff>("POST", "/api/handoffs", request);
  /** "세션 잇기": start, pause, go on, cut, one more round; what was exchanged, as turns or Markdown. */
  startLink = (request: StartLinkRequest) => this.request<SessionLink>("POST", "/api/links", request);
  pauseLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/pause`);
  resumeLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/resume`);
  stopLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/stop`);
  extendLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/extend`);
  linkTurns = (linkId: string) => this.request<{ link: SessionLink; turns: LinkTurn[] }>("GET", `/api/links/${linkId}/turns`);
  exportLink = (linkId: string, request: ExportMarkdownRequest) => this.request<ExportMarkdownResult>("POST", `/api/links/${linkId}/export`, request);
  openFile = (workId: string, path: string) => this.request<Artifact>("POST", `/api/works/${workId}/artifacts`, { path });
  createDesign = (workId: string, name: string, preset: string) => this.request<Artifact>("POST", `/api/works/${workId}/designs`, { name, preset });
  officePages = (artifactId: string, revision: number) =>
    this.request<{ revision: number; pages: { page: number; width: number; height: number }[] }>("GET", `/api/artifacts/${artifactId}/office-pages?revision=${revision}`);
  proposalOfficePages = (proposalId: string, side: "base" | "proposed") =>
    this.request<{ side: string; pages: { page: number; width: number; height: number }[] }>("GET", `/api/proposals/${proposalId}/office-pages?side=${side}`);
  openExternal = (artifactId: string) => this.request<{ app: string }>("POST", `/api/artifacts/${artifactId}/open-external`);
  refreshTools = () => this.request<DocumentTools>("POST", "/api/tools/refresh");
  /** The agent browser: install, the plain sign-in window, bring the window forward, pause a session. */
  browser = {
    install: () => this.request<AgentBrowserStatus>("POST", "/api/agent-browser/install"),
    login: (url: string | null) => this.request<AgentBrowserStatus>("POST", "/api/agent-browser/login", { url }),
    closeLogin: () => this.request<AgentBrowserStatus>("POST", "/api/agent-browser/login/close"),
    focus: () => this.request<{ ok: boolean; message: string }>("POST", "/api/agent-browser/focus"),
    pause: (sessionId: string, paused: boolean) => this.request<AgentBrowserStatus>("POST", "/api/agent-browser/pause", { sessionId, paused }),
  };
  installIeumOffice = () => this.request<DocumentTools>("POST", "/api/tools/ieumoffice/install");
  integrations = () => this.request<IntegrationsView>("GET", "/api/integrations");
  copyMcp = (name: string, to: "claude" | "codex") => this.request<IntegrationsView>("POST", "/api/integrations/mcp/copy", { name, to });
  copySkill = (name: string, to: "claude" | "codex") => this.request<IntegrationsView>("POST", "/api/integrations/skills/copy", { name, to });
  installIeumSkill = (to: "claude" | "codex") => this.request<IntegrationsView>("POST", "/api/integrations/ieum-skill", { to });
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
  /** Turns and revisions since a time (home "흐름"). */
  timeline = (since: number) => this.request<Timeline>("GET", `/api/views/timeline?since=${Math.floor(since)}`);
  adoptDisk = (artifactId: string) => this.request<Artifact>("POST", `/api/artifacts/${artifactId}/adopt-disk`);
  editorGrant = (artifactId: string) => this.request<EditorGrant>("POST", `/api/artifacts/${artifactId}/editor`);
  revert = (artifactId: string, toRevision: number) => this.request<Artifact>("POST", `/api/artifacts/${artifactId}/revert`, { toRevision });
  previewUrl = (artifactId: string, revision?: number) =>
    this.request<{ url: string; revision: number }>("POST", `/api/artifacts/${artifactId}/preview${revision ? `?revision=${revision}` : ""}`);
  editPdf = (artifactId: string, edit: { rotate?: { pages: number[]; degrees: number }[]; delete?: number[] }) =>
    this.request<Artifact>("POST", `/api/artifacts/${artifactId}/pdf-edit`, edit);
  proposal = (proposalId: string) =>
    this.request<{ proposal: Proposal; artifact: Artifact; base: string; proposed: string; current: string }>("GET", `/api/proposals/${proposalId}`);
  applyProposal = (proposalId: string) => this.request<{ proposal: Proposal; artifact: Artifact }>("POST", `/api/proposals/${proposalId}/apply`);
  discardProposal = (proposalId: string) => this.request<Proposal>("POST", `/api/proposals/${proposalId}/discard`);
  /** Images pasted into Markdown documents: the R2 settings (never the secret), "연결 확인", an upload. */
  imageUpload = () => this.request<ImageUploadView>("GET", "/api/image-upload");
  saveImageUpload = (input: ImageUploadInput) => this.request<ImageUploadView>("PUT", "/api/image-upload", input);
  clearImageUpload = () => this.request<ImageUploadView>("DELETE", "/api/image-upload");
  checkImageUpload = (input: ImageUploadInput) => this.request<ImageUploadCheck>("POST", "/api/image-upload/check", input);
  async uploadDocImage(artifactId: string, file: Blob, name: string): Promise<DocImageResult> {
    const response = await fetch(`/api/artifacts/${artifactId}/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(name) },
      body: file,
    });
    const json = (await response.json().catch(() => ({ code: "invalid_response", message: response.statusText }))) as DocImageResult & ApiError;
    if (!response.ok) throw new ApiRequestError(response.status, json);
    return json;
  }
  /**
   * The desktop clipboard's picture, for a paste that showed the page nothing (WebKitGTK gives pages
   * clipboard text and copied files, not picture data). Null when the clipboard holds no picture.
   */
  async clipboardPicture(): Promise<File | null> {
    const response = await fetch("/api/clipboard/picture", { headers: { authorization: `Bearer ${this.token}` } });
    if (response.status === 204) return null;
    if (!response.ok) throw new ApiRequestError(response.status, { code: "clipboard_failed", message: response.statusText });
    const type = response.headers.get("content-type") ?? "image/png";
    return new File([await response.blob()], `image.${type.split("/")[1] ?? "png"}`, { type });
  }
  /** An image a Markdown document links relatively (inside its work folder), for the preview. */
  async docImage(artifactId: string, src: string): Promise<Blob> {
    const response = await fetch(`/api/artifacts/${artifactId}/asset?src=${encodeURIComponent(src)}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new ApiRequestError(response.status, { code: "image_failed", message: response.statusText });
    return response.blob();
  }
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

const attachmentUrls = new Map<string, Promise<string>>();

/** A local URL for an attachment (fetched once with the token; its content never changes). */
export function attachmentUrl(id: string): Promise<string> {
  let url = attachmentUrls.get(id);
  if (!url) {
    url = fetch(`/api/attachments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${readToken() ?? ""}` } }).then(async (response) => {
      if (!response.ok) throw new ApiRequestError(response.status, { code: "attachment_failed", message: response.statusText });
      return URL.createObjectURL(await response.blob());
    });
    url.catch(() => attachmentUrls.delete(id));
    attachmentUrls.set(id, url);
  }
  return url;
}
