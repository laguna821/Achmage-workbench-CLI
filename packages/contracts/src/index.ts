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
  sort: number;
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
  activeSessionId: string | null;
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
  createdAt: number;
  updatedAt: number;
};

export type ToolKind = "command" | "fileChange" | "search" | "web" | "mcp" | "agent" | "other";

export type ItemStatus = "running" | "completed" | "failed" | "declined";

export type PlanStep = { text: string; status: "pending" | "inProgress" | "completed" };

export type ApprovalDecision = "accept" | "decline";

/** Documents the app tracks with exact revisions (PRD 3.3). */
export type DocFormat = "markdown" | "html" | "pdf" | "hwpx" | "hwp" | "text" | "design";

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
  at: number;
};

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
      /** Documents pinned to this request. */
      refs?: RefSummary[];
      /** Sent from another session ("다른 세션에"). */
      from?: { sessionId: string; label: string } | null;
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
  | { type: "prefs.updated"; prefs: UiPrefs };

/**
 * Screen preferences (theme, sidebar, per-engine look). Owned by the UI; the gateway only stores
 * them so they survive restarts and stay the same however the window is opened.
 */
export type UiPrefs = Record<string, unknown>;

export type SequencedEvent = WorkbenchEvent & { seq: number; at: number };

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
};

export type UpdateSessionRequest = {
  purpose?: string;
  model?: string | null;
  effort?: string | null;
};

export type SendMessageRequest = {
  /** Client-generated id; repeating it never sends the message twice. */
  requestId: string;
  text: string;
  refs?: DocRef[];
};

export type HandoffRequest = {
  requestId: string;
  sourceSessionId: string;
  targetSessionId: string;
  text: string;
  refs?: DocRef[];
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
