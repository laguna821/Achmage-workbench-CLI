// Shared contract between the host gateway and the UI.
// Provider-specific protocols stay inside the host adapters; the UI only sees these shapes.

export const PROTOCOL_VERSION = 1;

export type Provider = "claude" | "codex";

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
};

export type Folder = {
  id: string;
  parentId: string | null;
  name: string;
  /** Order among siblings (smaller first); fractional keys let a move land between two rows. */
  sort: number;
  /** Hidden with everything inside it, restored from the archive. */
  archivedAt: number | null;
};

/** "auto": follows what the requests keep coming back to (local, no model call). "user": named by hand. */
export type TitleSource = "auto" | "user";

export type Work = {
  id: string;
  title: string;
  titleSource: TitleSource;
  folderId: string | null;
  /** Working directory handed to both engines. */
  cwd: string;
  /** True when the app created `cwd` because the user started without a folder. */
  cwdManaged: boolean;
  /** The session last looked at (any window or device); selecting one does not change `updatedAt`. */
  activeSessionId: string | null;
  /** Shown under "고정" at the top of the sidebar. */
  pinned: boolean;
  /** Order among the works of its folder (smaller first). */
  sort: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "awaitingApproval"
  | "interrupting"
  | "error";

export type Session = {
  id: string;
  workId: string;
  provider: Provider;
  /** Execution host label shown in the status line, e.g. "노트북". */
  hostId: string;
  /** Provider-native id: Codex thread id or Claude session id. Null until the engine reports it. */
  nativeSessionId: string | null;
  /** Purpose label shown on the tab, e.g. "강의 작성". */
  purpose: string;
  purposeSource: TitleSource;
  /** Null means the engine default. Applies from the next turn. */
  model: string | null;
  /** Reasoning effort id as the engine names it (e.g. "medium", "xhigh"); null = engine default. */
  effort: string | null;
  /** Model the engine reported for the latest turn (what actually answered). */
  engineModel: string | null;
  /** Effort the engine reported for the latest turn, when it reports one (Codex). */
  engineEffort: string | null;
  /** Start of the latest finished reply, plain text, for overviews. */
  preview: string | null;
  previewAt: number | null;
  status: SessionStatus;
  /** Short human-readable activity, e.g. "명령 실행 중". */
  activity: string | null;
  lastError: string | null;
  pinned: boolean;
  /** Order among the sessions of its work (smaller first). */
  sort: number;
  archivedAt: number | null;
  /** When the user last looked at its replies; a reply after this is "새 답". */
  seenAt: number | null;
  /** Marked "읽지 않음" by hand. */
  unread: boolean;
  /** Requests waiting to be sent when the current turn ends ("끝나면 보내기"), oldest first. */
  queued: QueuedMessage[];
  /** How freely the engine acts here; null follows the default (see `accessFor`). */
  access: AccessMode | null;
  /** How full the conversation's context window is, as the engine last reported it. */
  context: ContextUsage | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * How freely an engine acts in a session (the picker under the input):
 * ask — before running commands or changing files;
 * auto — on its own inside the work folder (Codex: sandbox) or for file edits (Claude), asking for the rest;
 * full — never asks, no sandbox (the whole computer and the network).
 */
export type AccessMode = "ask" | "auto" | "full";

export const ACCESS_MODES: AccessMode[] = ["ask", "auto", "full"];

export const ACCESS_LABEL: Record<AccessMode, string> = { ask: "묻기", auto: "자동", full: "전체 접근" };

export const isAccessMode = (value: unknown): value is AccessMode => value === "ask" || value === "auto" || value === "full";

/**
 * The access a session runs with: its own choice, else the one last picked for that engine (kept
 * in the UI prefs as `access`), else what the engine's own settings say, else "auto".
 */
export function accessFor(provider: Provider, chosen: AccessMode | null | undefined, prefs: UiPrefs | null | undefined, configured: AccessMode | null | undefined): AccessMode {
  if (chosen) return chosen;
  const remembered = (prefs?.access as Partial<Record<Provider, unknown>> | undefined)?.[provider];
  return isAccessMode(remembered) ? remembered : (configured ?? "auto");
}

/** Context window use: tokens the conversation takes now, the window, and where it compacts itself. */
export type ContextUsage = { used: number; window: number | null; compactAt: number | null; at: number };

/**
 * A request written while the engine was working, sent as the next turn when this one ends.
 * `held`: kept after a stop, a failure, a restart or a steer the stop dropped — sent only by hand.
 */
export type QueuedMessage = { id: string; text: string; refs: DocRef[]; create: CreateTarget | null; at: number; held?: boolean; attachments?: Attachment[]; plan?: boolean };

/**
 * A file pasted or dropped into the input (a picture, a PDF, any file), kept by the gateway by its
 * content and handed to the engine with the request. `id` is `<sha256><ext>`.
 */
export type Attachment = { id: string; name: string; mime: string; size: number };

/** A reply the user has not looked at yet (or a session marked unread). */
export const isUnseen = (session: Session) => session.unread || Boolean(session.previewAt && session.previewAt > (session.seenAt ?? 0));

export type ToolKind = "command" | "fileChange" | "search" | "web" | "mcp" | "agent" | "other";

export type ItemStatus = "running" | "completed" | "failed" | "declined";

export type PlanStep = { text: string; status: "pending" | "inProgress" | "completed" };

export type ApprovalDecision = "accept" | "decline";

/** Documents the app tracks with exact revisions (PRD 3.3). */
export type DocFormat = "markdown" | "html" | "pdf" | "hwpx" | "hwp" | "text" | "design" | "docx" | "pptx" | "xlsx";

/** Word, PowerPoint and Excel: previewed and edited through the IeumOffice command line tool. */
export const OFFICE_FORMATS = ["docx", "pptx", "xlsx"] as const;
export type OfficeFormat = (typeof OFFICE_FORMATS)[number];
export const isOfficeFormat = (format: DocFormat): format is OfficeFormat => (OFFICE_FORMATS as readonly string[]).includes(format);

export type Artifact = {
  id: string;
  workId: string;
  /** Absolute path of the real file in the work folder. */
  path: string;
  name: string;
  format: DocFormat;
  /** Latest recorded revision (1-based). Each revision is an immutable copy kept by the gateway. */
  revision: number;
  sha256: string;
  size: number;
  /** Disk compared with the latest revision, as of the last check. */
  diskState: "same" | "changed" | "missing";
  /** Revision each session last received with a request: what that AI actually read. */
  readBy: Record<string, number>;
  createdAt: number;
  updatedAt: number;
};

export type ArtifactRevision = {
  artifactId: string;
  revision: number;
  sha256: string;
  size: number;
  author: "user" | "engine" | "external";
  sessionId: string | null;
  baseRevision: number | null;
  note: string | null;
  /** The documents (and their revisions) this one was made from, for a document created by a request. */
  derivedFrom?: { artifactId: string; revision: number }[] | null;
  at: number;
};

/** Formats a request can ask a new document in ("새 문서로 만들기"). */
export type CreatableFormat = "markdown" | "hwpx" | "docx" | "pptx" | "xlsx" | "design" | "html";

export const CREATE_EXTENSION: Record<CreatableFormat, string> = {
  markdown: ".md",
  hwpx: ".hwpx",
  docx: ".docx",
  pptx: ".pptx",
  xlsx: ".xlsx",
  design: ".design.json",
  html: ".html",
};

export const CREATE_LABEL: Record<CreatableFormat, string> = {
  markdown: "마크다운",
  hwpx: "한글(HWPX)",
  docx: "워드",
  pptx: "PPT",
  xlsx: "엑셀",
  design: "디자인",
  html: "HTML",
};

/**
 * A new document a request asks for. The gateway reserves a free file name in the work folder,
 * the engine writes the document there, and it is tracked with the documents it came from.
 */
export type CreateTarget = { format: CreatableFormat; name: string };

/** What a request carries about a document: a pinned revision and, optionally, a selection. */
export type DocRef = {
  artifactId: string;
  revision: number;
  /** edit: the session may change it (through a working copy). review: read only. */
  mode: "edit" | "review";
  /**
   * Part of the document the request is about. Text formats use the character range; designs use the
   * page and object ids (`text` then describes the selected objects).
   */
  selection?: { from: number; to: number; text: string; label: string; pageId?: string; objectIds?: string[] } | null;
};

/**
 * A change an engine made in a working copy of a pinned revision. Never written to the real file
 * until applied, and never applied automatically when the document moved on.
 */
export type Proposal = {
  id: string;
  artifactId: string;
  sessionId: string;
  requestId: string;
  baseRevision: number;
  workingPath: string;
  status: "running" | "pending" | "applied" | "discarded" | "empty";
  added: number;
  removed: number;
  appliedRevision: number | null;
  /** Why the working copy cannot be applied as it is (a design that is no longer valid JSON…). */
  problem?: string | null;
  createdAt: number;
  updatedAt: number;
};

/** A request sent from one session to another, answered back into the source conversation. */
export type Handoff = {
  /** The requestId; repeating it never sends twice. */
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  text: string;
  refs: DocRef[];
  status: "sent" | "answered" | "failed";
  reply: string | null;
  error: string | null;
  createdAt: number;
  answeredAt: number | null;
};

export type RefSummary = { artifactId: string; name: string; revision: number; mode: DocRef["mode"]; selection: string | null };

export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      text: string;
      at: number;
      /** Sent with "계획 먼저": the engine plans and waits for the go-ahead. */
      plan?: boolean;
      /** Documents pinned to this request. */
      refs?: RefSummary[];
      /** Sent from another session ("다른 세션에"). */
      from?: { sessionId: string; label: string } | null;
      /** The new document this request asked for, at the path the gateway reserved. */
      create?: { format: CreatableFormat; name: string; path: string } | null;
      /** Sent into a turn that was still running ("끼어들기"): the engine takes it at its next step. */
      steered?: boolean;
      /** Steered in, then the turn was stopped before the engine took it: it waits again above the input. */
      undelivered?: boolean;
      /** Files that went with the request (pictures are shown). */
      attachments?: Attachment[];
    }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; at: number }
  | { kind: "reasoning"; id: string; text: string; at: number }
  | {
      kind: "tool";
      id: string;
      tool: ToolKind;
      title: string;
      detail: string | null;
      output: string | null;
      status: ItemStatus;
      at: number;
      /** Files this tool wrote (file changes). */
      paths?: string[];
      /** Pictures the step produced or looked at (screenshots, images read), shown in the conversation. */
      images?: Attachment[];
    }
  | { kind: "plan"; id: string; steps: PlanStep[]; at: number }
  | {
      kind: "approval";
      id: string;
      title: string;
      /** Command, file list or tool input preview. */
      detail: string | null;
      reason: string | null;
      decision: ApprovalDecision | "expired" | null;
      at: number;
      /**
       * A plan waiting for the go-ahead ("계획 먼저"): accept runs it, decline keeps planning.
       * `detail` holds the plan when it is not the reply above (Claude's plan mode).
       */
      plan?: boolean;
    }
  | { kind: "notice"; id: string; level: "info" | "error"; text: string; at: number }
  /** A document this turn created or changed, opened in the central area. */
  | { kind: "artifact"; id: string; artifactId: string; revision: number; change: "created" | "modified"; at: number }
  | { kind: "proposal"; id: string; proposalId: string; at: number }
  | { kind: "handoff"; id: string; handoffId: string; at: number }
  | {
      kind: "turnEnd";
      id: string;
      status: "completed" | "interrupted" | "failed";
      durationMs: number | null;
      at: number;
    };

export type UsageWindow = {
  /** e.g. "5시간", "주간" */
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
};

export type ModelOption = {
  id: string;
  label: string;
  description: string | null;
  /** Effort ids this model accepts, in the engine's order. Empty when the model has no effort control. */
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
};

export const EFFORT_LABEL: Record<string, string> = {
  none: "없음",
  minimal: "최소",
  low: "낮음",
  medium: "중간",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
  ultra: "울트라",
};

/** How an engine is signed in: the user's subscription, or a route billed per use (API key, cloud). */
export type LoginMethod = "subscription" | "metered" | "unknown";

export type ProviderStatus = {
  provider: Provider;
  installed: boolean;
  binary: string | null;
  /** installed: the user's own engine; bundled: the copy shipped with the SDK; override: set by env. */
  binarySource: "installed" | "bundled" | "override" | null;
  version: string | null;
  loggedIn: boolean | null;
  loginMethod: LoginMethod | null;
  /** Billing variables found in the gateway's environment; engines are started without them. */
  billingVars: string[];
  account: string | null;
  plan: string | null;
  usage: UsageWindow[];
  usageObservedAt: number | null;
  models: ModelOption[];
  /** The access the engine's own settings give (Claude permissions.defaultMode, Codex approval/sandbox). */
  configuredAccess: AccessMode | null;
  error: string | null;
};

export type WorkbenchEvent =
  | { type: "folder.upserted"; folder: Folder }
  | { type: "work.upserted"; work: Work }
  | { type: "session.upserted"; session: Session }
  | { type: "item.upserted"; sessionId: string; item: TranscriptItem }
  | { type: "item.delta"; sessionId: string; itemId: string; textDelta: string }
  | { type: "provider.status"; status: ProviderStatus }
  | { type: "artifact.upserted"; artifact: Artifact }
  | { type: "proposal.upserted"; proposal: Proposal }
  | { type: "handoff.upserted"; handoff: Handoff }
  | { type: "prefs.updated"; prefs: UiPrefs }
  | { type: "tools.status"; tools: DocumentTools };

/**
 * Screen preferences (theme, sidebar, per-engine look). Owned by the UI; the gateway only stores
 * them so they survive restarts and stay the same however the window is opened.
 */
export type UiPrefs = Record<string, unknown>;

export type SequencedEvent = WorkbenchEvent & { seq: number; at: number };

/** A document engine the gateway can use: kordoc (Hangul), IeumOffice (Office formats), HOP (Hangul editor). */
export type ToolStatus = {
  available: boolean;
  version: string | null;
  path: string | null;
  /** Install or update running (IeumOffice). */
  busy: boolean;
  message: string | null;
};

export type DocumentTools = { kordoc: ToolStatus; ieumoffice: ToolStatus; hop: ToolStatus };

/** An MCP server definition as one engine has it (env values shown only as names on screen). */
export type McpDefinition = { type: "stdio" | "http" | "sse"; command: string | null; args: string[]; env: Record<string, string>; url: string | null; enabled: boolean };

/** One skill and where each engine has it (the folder path), or null. */
export type SkillEntry = { name: string; description: string | null; claude: string | null; codex: string | null };

/** MCP servers and skills side by side, as the two engines see them. */
export type IntegrationsView = {
  mcp: { name: string; claude: McpDefinition | null; codex: McpDefinition | null }[];
  skills: SkillEntry[];
  paths: { claudeConfig: string; codexConfig: string; claudeSkills: string; codexSkills: string };
  /** The agent skill IeumOffice ships for its command line tool, and whether each engine has it. */
  ieumSkill: { source: string; claude: boolean; codex: boolean } | null;
};

export type Snapshot = {
  protocolVersion: number;
  seq: number;
  hostId: string;
  hostLabel: string;
  folders: Folder[];
  works: Work[];
  sessions: Session[];
  providers: ProviderStatus[];
  prefs: UiPrefs;
  artifacts: Artifact[];
  proposals: Proposal[];
  handoffs: Handoff[];
  tools: DocumentTools;
};

export type ApiError = { code: string; message: string; requestId?: string };

export type CreateWorkRequest = {
  title: string;
  titleSource?: TitleSource;
  folderId?: string | null;
  cwd?: string | null;
};

export type CreateSessionRequest = {
  provider: Provider;
  purpose?: string;
  model?: string | null;
  effort?: string | null;
  access?: AccessMode | null;
};

export type UpdateSessionRequest = {
  purpose?: string;
  model?: string | null;
  effort?: string | null;
  pinned?: boolean;
  sort?: number;
  archived?: boolean;
  /** true: looked at now; false: mark unread. */
  seen?: boolean;
  /** Applies at once: to the running turn where the engine allows it, else from the next one. */
  access?: AccessMode | null;
};

export type UpdateWorkRequest = {
  title?: string;
  folderId?: string | null;
  activeSessionId?: string | null;
  pinned?: boolean;
  sort?: number;
  archived?: boolean;
};

export type UpdateFolderRequest = {
  name?: string;
  parentId?: string | null;
  sort?: number;
  archived?: boolean;
};

/** One place a search term was found in a conversation. */
export type SearchHit = {
  sessionId: string;
  itemId: string;
  kind: "user" | "assistant";
  at: number;
  /** A short stretch of the message around the first match. */
  snippet: string;
  /** Matched character ranges within `snippet`. */
  ranges: [number, number][];
};

export type SearchResult = {
  query: string;
  /** Conversations with matches, most recent match first. */
  sessions: { sessionId: string; workId: string; total: number; hits: SearchHit[] }[];
  /** Documents whose latest text matches. */
  documents: { artifactId: string; workId: string; snippet: string; ranges: [number, number][] }[];
  tookMs: number;
};

/**
 * "마크다운으로 내보내기": the conversation as a clean Markdown file, made by fixed rules (no model).
 * work: saved in the work folder ("세션 기록/") and tracked as a document; path: written where the
 * user chose; text: only returned (copy).
 */
export type ExportMarkdownRequest = { target: "work" | "path" | "text"; path?: string; tools?: boolean };
export type ExportMarkdownResult = { markdown: string; path: string | null; artifactId: string | null };

export type SendMessageRequest = {
  /** Client-generated id; repeating it never sends the message twice. */
  requestId: string;
  text: string;
  refs?: DocRef[];
  create?: CreateTarget | null;
  /**
   * While the engine is working: "steer" puts the request into the running turn (the engine takes
   * it at its next step), "queue" sends it as the next turn when this one ends, "auto" steers when
   * the engine can and queues otherwise. An idle session just starts a turn.
   */
  mode?: "auto" | "steer" | "queue";
  /** Files pasted or dropped into the input (uploaded first to /api/attachments). */
  attachments?: Attachment[];
  /** "계획 먼저": the engine only plans this turn and waits for the go-ahead. */
  plan?: boolean;
};

export type SendResult = { duplicate: boolean; delivery: "turn" | "steered" | "queued" };

export type HandoffRequest = {
  requestId: string;
  sourceSessionId: string;
  targetSessionId: string;
  text: string;
  refs?: DocRef[];
  attachments?: Attachment[];
};

export type SaveArtifactRequest = { requestId: string; expectedRevision: number; text: string };

export const FORMAT_LABEL: Record<DocFormat, string> = {
  markdown: "Markdown",
  html: "HTML",
  pdf: "PDF",
  hwpx: "한글(HWPX)",
  hwp: "한글(HWP)",
  text: "텍스트",
  design: "디자인",
  docx: "워드(DOCX)",
  pptx: "PPT(PPTX)",
  xlsx: "엑셀(XLSX)",
};

/** Formats the app opens as documents, by file extension. */
export function formatOf(path: string): DocFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".design.json")) return "design";
  const extension = lower.split(".").pop() ?? "";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "pdf") return "pdf";
  if (extension === "hwpx") return "hwpx";
  if (extension === "hwp") return "hwp";
  if (extension === "txt") return "text";
  if (extension === "docx") return "docx";
  if (extension === "pptx") return "pptx";
  if (extension === "xlsx" || extension === "xlsm") return "xlsx";
  return null;
}

/** Extension of design documents: a doory document (schema v1) as JSON. */
export const DESIGN_EXTENSION = ".design.json";

/** What the user selected in the design editor; becomes the selection of a request about the design. */
export type DesignSelection = { pageId: string; pageIndex: number; objectIds: string[]; label: string; text: string };

export type DesignSaveState = "idle" | "dirty" | "saving" | "saved" | "conflict" | "error";

/** Workbench window → design page (iframe at /design/). */
export type DesignHostMessage =
  | { type: "design:init"; token: string; artifactId: string; revision: number | null; readOnly: boolean; theme: "light" | "dark" }
  | { type: "design:theme"; theme: "light" | "dark" }
  | { type: "design:flush" }
  | { type: "render:init"; token: string }
  | { type: "render:request"; id: string; artifactId: string; document: string; page: number; width: number };

/** Design page → Workbench window. */
export type DesignPageMessage =
  | { type: "design:ready" }
  | { type: "design:opened"; revision: number; pages: number }
  | { type: "design:saved"; revision: number }
  | { type: "design:state"; state: DesignSaveState; message?: string }
  | { type: "design:selection"; selection: DesignSelection | null }
  | { type: "design:reload" }
  | { type: "design:copied"; artifactId: string }
  | { type: "design:exported"; name: string; path: string; artifactId: string | null }
  | { type: "design:error"; message: string }
  | { type: "render:ready" }
  | { type: "render:result"; id: string; dataUrl: string | null; pages: number; error?: string };

/** Office editors built from IeumOffice (apps/office), one page per editor kind. */
export type OfficeEditorKind = "docs" | "slides" | "sheets";

/**
 * Where to open a document's editor page: the editors' own origin (not the Workbench UI's), and a
 * token that reads and saves this one document only.
 */
export type EditorGrant = { url: string; origin: string; token: string };

/** Workbench window → office editor page (iframe at /office/<kind>.html). */
export type OfficeHostMessage =
  | {
      type: "office:init";
      token: string;
      artifact: { id: string; name: string; path: string; revision: number; sha256: string };
      readOnly: boolean;
      theme: "light" | "dark";
      /** Reopen unsaved edits kept from an earlier visit (false when the user chose the latest revision). */
      recover: boolean;
    }
  | { type: "office:theme"; theme: "light" | "dark" }
  /** Save unsaved edits now (before a request is sent, the tab changes or the view switches). */
  | { type: "office:flush" }
  /** Keep my edits after a conflict: save them as the revision after this one. */
  | { type: "office:rebase"; revision: number }
  /** Leaving with edits that cannot be saved now (a conflict): keep them for the next visit. */
  | { type: "office:keep" };

/** Office editor page → Workbench window. */
export type OfficePageMessage =
  | { type: "office:ready" }
  /** The editor shows this revision; `recovered` when it reopened unsaved edits made on it. */
  | { type: "office:opened"; revision: number; recovered: boolean }
  | { type: "office:saved"; revision: number }
  | { type: "office:dirty"; dirty: boolean }
  /** After flush, rebase or keep: the saved revision, or null when the edits were not saved (then they are kept). */
  | { type: "office:flushed"; revision: number | null }
  /** A save was refused: the document moved on (`revision_conflict`) or changed on disk (`disk_changed`). */
  | { type: "office:conflict"; code: string; message: string }
  | { type: "office:error"; message: string };

export type ApprovalAnswerRequest = { decision: ApprovalDecision };

/** Apply one event to an item list (shared by host replay and UI). */
export function applyItemEvent(items: TranscriptItem[], event: WorkbenchEvent): TranscriptItem[] {
  if (event.type === "item.upserted") {
    const index = items.findIndex((item) => item.id === event.item.id);
    if (index === -1) {
      return [...items, event.item];
    }
    const next = items.slice();
    next[index] = event.item;
    return next;
  }
  if (event.type === "item.delta") {
    const index = items.findIndex((item) => item.id === event.itemId);
    if (index === -1) {
      return items;
    }
    const item = items[index];
    if (item.kind !== "assistant" && item.kind !== "reasoning") {
      return items;
    }
    const next = items.slice();
    next[index] = { ...item, text: item.text + event.textDelta };
    return next;
  }
  return items;
}
export * from "./commands.ts";
