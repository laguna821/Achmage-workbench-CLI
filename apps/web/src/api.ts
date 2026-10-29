import type {
  AchmageBrief,
  AgentBrowserStatus,
  ChangeLine,
  FolderNoteTemplate,
  ProjectEntryRequest,
  ProjectEvent,
  ProjectPage,
  ProjectStage,
  ProjectSummary,
  ProjectWrite,
  PropertyField,
  PropertyType,
  ApiError,
  Artifact,
  Attachment,
  EngineCommand,
  ImportCandidate,
  CreateScheduleRequest,
  WorktreeChanges,
  Schedule,
  ForkResult,
  ImportRequest,
  ArtifactRevision,
  CalendarEventsView,
  CalendarFeedInput,
  CalendarFeedView,
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
  SearchPage,
  SearchRequest,
  ProviderStatus,
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
  DeleteFolderResult,
  UpdateSessionRequest,
  UpdateWorkRequest,
  Work,
  Workspace,
  DocumentAccess,
  DocumentPresence,
  DocumentViewInput,
  DocumentRegistration,
  UpdateWorkspaceRequest,
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
  private readonly documentAccess?: () => DocumentAccess;
  constructor(token: string, access?: () => DocumentAccess) {
    this.token = token;
    this.documentAccess = access;
  }

  forDocument = (access: () => DocumentAccess) => new Api(this.token, access);
  private editorHeaders(): Record<string, string> {
    const access = this.documentAccess?.();
    return access ? { "x-workbench-view": access.viewId, "x-workbench-write": access.writeToken ?? "" } : {};
  }

  /** Any API call (feature clients such as pkm.ts build on it). */
  async request<T>(method: string, path: string, body?: unknown, options: Pick<RequestInit, "keepalive"> = {}): Promise<T> {
    const response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...this.editorHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options,
    });
    const json = (await response.json().catch(() => ({ code: "invalid_response", message: response.statusText }))) as T & ApiError;
    if (!response.ok) throw new ApiRequestError(response.status, json);
    return json;
  }

  snapshot = () => this.request<Snapshot>("GET", "/api/snapshot");
  documentViews = () => this.request<{ views: DocumentPresence[] }>("GET", "/api/document-views");
  registerDocument = (artifactId: string, input: DocumentViewInput) => this.request<DocumentRegistration>("POST", `/api/artifacts/${artifactId}/views`, input);
  closeDocument = (viewId: string, windowId: string) => this.request<{ ok: boolean }>("DELETE", `/api/document-views/${viewId}`, { windowId }, { keepalive: true });
  items = (sessionId: string) => this.request<{ seq: number; items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`);
  createFolder = (name: string, parentId: string | null) => this.request<Folder>("POST", "/api/folders", { name, parentId });
  updateFolder = (folderId: string, patch: UpdateFolderRequest) => this.request<Folder>("PATCH", `/api/folders/${folderId}`, patch);
  /** "폴더만 지우기": the folder goes, what was inside moves up to its parent. */
  deleteFolder = (folderId: string) => this.request<DeleteFolderResult>("DELETE", `/api/folders/${folderId}`);
  /** "찾는 길": grouped by work with totals per scope; `group` pages one work's hits. */
  search = (query: string, options: Omit<SearchRequest, "q"> & { legacy?: boolean } = {}) => {
    const params = new URLSearchParams({ q: query });
    if (options.provider) params.set("provider", options.provider);
    if (options.archived) params.set("archived", "1");
    if (options.folderId) params.set("folderId", options.folderId);
    if (options.scope && options.scope !== "all") params.set("scope", options.scope);
    for (const key of ["offset", "limit", "per"] as const) if (options[key] !== undefined) params.set(key, String(options[key]));
    if (options.group) params.set("group", options.group);
    if (options.legacy === false) params.set("legacy", "0");
    return this.request<SearchPage>("GET", `/api/search?${params}`);
  };
  exportMarkdown = (sessionId: string, request: ExportMarkdownRequest) => this.request<ExportMarkdownResult>("POST", `/api/sessions/${sessionId}/export`, request);
  createWork = (title: string, folderId: string | null, cwd: string | null) => this.request<Work>("POST", "/api/works", { title, folderId, cwd });
  updateWork = (workId: string, patch: UpdateWorkRequest) => this.request<Work>("PATCH", `/api/works/${workId}`, patch);
  createWorkspace = (workId: string, cwd: string, label?: string) => this.request<Workspace>("POST", `/api/works/${workId}/workspaces`, { cwd, label });
  updateWorkspace = (id: string, patch: UpdateWorkspaceRequest) => this.request<Workspace>("PATCH", `/api/workspaces/${id}`, patch);
  createSession = (workId: string, provider: Provider, options?: { workspaceId?: string; purpose?: string; model?: string | null; effort?: string | null; browser?: boolean; worktree?: boolean }) =>
    this.request<Session>("POST", `/api/works/${workId}/sessions`, { provider, ...options });
  updateSession = (sessionId: string, patch: UpdateSessionRequest) => this.request<Session>("PATCH", `/api/sessions/${sessionId}`, patch);
  /** A new Markdown page in the work folder. */
  createPage = (workId: string, name = "", workspaceId?: string) => this.request<Artifact>("POST", `/api/works/${workId}/pages`, { name, workspaceId });
  /** "가져오기": conversations an engine keeps on this computer, and continuing one here. */
  importCandidates = (provider: Provider, query: string) =>
    this.request<{ candidates: ImportCandidate[] }>("GET", `/api/import?${new URLSearchParams({ provider, q: query })}`).then((result) => result.candidates);
  importSession = (request: ImportRequest) => this.request<Session>("POST", "/api/import", request);
  /** "격리 사본": what a worktree session changed, applying it to the original, or throwing it away. */
  worktreeChanges = (sessionId: string) => this.request<WorktreeChanges>("GET", `/api/sessions/${sessionId}/worktree`);
  applyWorktree = (sessionId: string) => this.request<{ ok: boolean }>("POST", `/api/sessions/${sessionId}/worktree/apply`);
  discardWorktree = (sessionId: string) => this.request<{ ok: boolean }>("POST", `/api/sessions/${sessionId}/worktree/discard`);
  /** "예약 작업": requests a session gets at set times. */
  createSchedule = (request: CreateScheduleRequest) => this.request<Schedule>("POST", "/api/schedules", request);
  updateSchedule = (id: string, patch: { enabled: boolean }) => this.request<Schedule>("PATCH", `/api/schedules/${encodeURIComponent(id)}`, patch);
  removeSchedule = (id: string) => this.request<{ ok: boolean }>("DELETE", `/api/schedules/${encodeURIComponent(id)}`);
  /** "이 요청 전으로": a new session with the conversation up to that request. */
  forkBefore = (sessionId: string, itemId: string) => this.request<ForkResult>("POST", `/api/sessions/${sessionId}/fork`, { itemId });
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
    extra: { omitChanges?: string[]; notes?: string[] } = {},
  ) => this.request<SendResult>("POST", `/api/sessions/${sessionId}/messages`, { requestId, text, refs, create, mode, attachments, plan, ...extra });
  /** A work as a project note (project.ts): the page, writes to the note (each undoable), the stages. */
  projects = () => this.request<ProjectSummary[]>("GET", "/api/projects/");
  project = (workId: string) => this.request<ProjectPage>("GET", `/api/projects/${encodeURIComponent(workId)}`);
  projectEvents = (workId: string) => this.request<ProjectEvent[]>("GET", `/api/projects/${encodeURIComponent(workId)}/events`);
  setProjectProperty = (workId: string, key: string, values: string[] | null, type?: PropertyType) =>
    this.request<ProjectWrite>("PUT", `/api/projects/${encodeURIComponent(workId)}/property`, { key, values, ...(type ? { type } : {}) });
  propertyTemplate = () => this.request<PropertyField[]>("GET", "/api/projects/template");
  savePropertyTemplate = (fields: PropertyField[] | null) => this.request<PropertyField[]>("PUT", "/api/projects/template", fields === null ? { reset: true } : { fields });
  importPropertyTemplate = (markdown: string) => this.request<PropertyField[]>("POST", "/api/projects/template/import", { markdown });
  folderNoteTemplate = (folderId: string) => this.request<FolderNoteTemplate>("GET", `/api/projects/folder-templates/${encodeURIComponent(folderId)}`);
  exportBase = (path: string, source: string) => this.request<{ path: string }>("POST", "/api/projects/bases/export", { path, source });
  saveFolderNoteTemplate = (folderId: string, markdown: string | null) => this.request<FolderNoteTemplate>("PUT", `/api/projects/folder-templates/${encodeURIComponent(folderId)}`, { markdown });
  initializeProjectNote = (workId: string) => this.request<ProjectWrite>("POST", `/api/projects/${encodeURIComponent(workId)}/initialize-note`, {});
  setPropertyType = (key: string, type: PropertyType) => this.request<Record<string, PropertyType>>("PUT", "/api/projects/types", { key, type });
  setProjectStage = (workId: string, stage: string | null) => this.request<ProjectWrite>("PUT", `/api/projects/${encodeURIComponent(workId)}/stage`, { stage });
  addProjectEntry = (workId: string, entry: ProjectEntryRequest) => this.request<ProjectWrite>("POST", `/api/projects/${encodeURIComponent(workId)}/entries`, entry);
  setProjectQuestion = (workId: string, line: number, done: boolean) => this.request<ProjectWrite>("PUT", `/api/projects/${encodeURIComponent(workId)}/entries/${line}`, { done });
  setProjectBody = (workId: string, body: string, baseRevision: number | null) => this.request<ProjectWrite>("PUT", `/api/projects/${encodeURIComponent(workId)}/body`, { body, baseRevision });
  undoProject = (workId: string, token: string) => this.request<ProjectPage>("POST", `/api/projects/${encodeURIComponent(workId)}/undo`, { token });
  revertProjectNote = (workId: string) => this.request<ProjectWrite>("POST", `/api/projects/${encodeURIComponent(workId)}/revert`);
  projectStages = () => this.request<ProjectStage[]>("GET", "/api/projects/stages");
  vaultTags = () => this.request<{ tag: string; count: number }[]>("GET", "/api/pkm/tags");
  projectAchmage = (workId: string) => this.request<AchmageBrief | null>("GET", `/api/projects/${encodeURIComponent(workId)}/achmage`);
  setProjectStages = (stages: ProjectStage[]) => this.request<ProjectStage[]>("PUT", "/api/projects/stages", { stages });
  /** "알릴 변경": what the next request of a session will be told changed since its last one. */
  changes = (sessionId: string) => this.request<ChangeLine[]>("GET", `/api/projects/changes?${new URLSearchParams({ sessionId })}`);
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
  /** "다시 보내기": a request the other session did not answer, sent again as a new one. */
  resendHandoff = (handoffId: string, requestId: string) => this.request<Handoff>("POST", `/api/handoffs/${encodeURIComponent(handoffId)}/resend`, { requestId });
  /** "세션 잇기": start, pause, go on, cut, one more round; what was exchanged, as turns or Markdown. */
  startLink = (request: StartLinkRequest) => this.request<SessionLink>("POST", "/api/links", request);
  pauseLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/pause`);
  resumeLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/resume`);
  stopLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/stop`);
  extendLink = (linkId: string) => this.request<SessionLink>("POST", `/api/links/${linkId}/extend`);
  linkTurns = (linkId: string) => this.request<{ link: SessionLink; turns: LinkTurn[] }>("GET", `/api/links/${linkId}/turns`);
  exportLink = (linkId: string, request: ExportMarkdownRequest) => this.request<ExportMarkdownResult>("POST", `/api/links/${linkId}/export`, request);
  openFile = (workId: string, path: string, workspaceId?: string) => this.request<Artifact>("POST", `/api/works/${workId}/artifacts`, { path, workspaceId });
  createDesign = (workId: string, name: string, preset: string, workspaceId?: string) => this.request<Artifact>("POST", `/api/works/${workId}/designs`, { name, preset, workspaceId });
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
  /** Turns and revisions in `[since, until)`, or since a time (home "흐름"). */
  timeline = (since: number, until?: number) =>
    this.request<Timeline>("GET", `/api/views/timeline?since=${Math.floor(since)}${until === undefined ? "" : `&until=${Math.floor(until)}`}`);
  /** Calendar feeds on home "흐름" (never their addresses) and the events of a window. */
  calendarFeeds = () => this.request<{ feeds: CalendarFeedView[] }>("GET", "/api/calendar/feeds");
  addCalendarFeed = (input: CalendarFeedInput) => this.request<CalendarFeedView>("POST", "/api/calendar/feeds", input);
  updateCalendarFeed = (id: string, input: CalendarFeedInput) => this.request<CalendarFeedView>("PATCH", `/api/calendar/feeds/${encodeURIComponent(id)}`, input);
  removeCalendarFeed = (id: string) => this.request<{ feeds: CalendarFeedView[] }>("DELETE", `/api/calendar/feeds/${encodeURIComponent(id)}`);
  refreshCalendarFeed = (id: string) => this.request<CalendarFeedView>("POST", `/api/calendar/feeds/${encodeURIComponent(id)}/refresh`);
  calendarEvents = (since: number, until: number, zone: string, refresh = false) =>
    this.request<CalendarEventsView>("GET", `/api/calendar/events?${new URLSearchParams({ since: String(Math.floor(since)), until: String(Math.floor(until)), tz: zone, ...(refresh ? { refresh: "1" } : {}) })}`);
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
  /** The code the engine's login page showed (Claude Code), handed to its waiting login. */
  loginCode = (provider: Provider, code: string) => this.request<ProviderStatus>("POST", `/api/providers/${provider}/login/code`, { code });
  cancelLogin = (provider: Provider) => this.request<ProviderStatus>("POST", `/api/providers/${provider}/login/cancel`);
  /** "설치": the engine for this user; progress arrives as provider.status events. */
  installEngine = (provider: Provider) => this.request<ProviderStatus>("POST", `/api/providers/${provider}/install`);
  refreshProviders = () => this.request("POST", "/api/providers/refresh");

  /**
   * Subscribe to events after `since`. Reconnects with the last seen seq so nothing is applied
   * twice; if the host can no longer replay that far, `onResync` reloads the snapshot.
   */
  savePrefs(prefs: UiPrefs) {
    return this.request<{ prefs: UiPrefs }>("PUT", "/api/prefs", { prefs });
  }
  layout = (key: string) => this.request<{ record: import("@workbench/contracts").WorkspaceLayoutRecord | null }>("GET", `/api/layouts/${encodeURIComponent(key)}`);
  saveLayout = (key: string, expectedRevision: number, layout: Record<string, unknown>) => this.request<{ record: import("@workbench/contracts").WorkspaceLayoutRecord }>("PUT", `/api/layouts/${encodeURIComponent(key)}`, { expectedRevision, layout });

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
