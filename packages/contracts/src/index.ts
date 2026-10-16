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

export type Work = {
  id: string;
  title: string;
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
  /** Null means the engine default. Applies from the next turn. */
  model: string | null;
  /** Reasoning effort id as the engine names it (e.g. "medium", "xhigh"); null = engine default. */
  effort: string | null;
  /** Model the engine reported for the latest turn (what actually answered). */
  engineModel: string | null;
  /** Effort the engine reported for the latest turn, when it reports one (Codex). */
  engineEffort: string | null;
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

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; at: number }
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

export type ProviderStatus = {
  provider: Provider;
  installed: boolean;
  binary: string | null;
  version: string | null;
  loggedIn: boolean | null;
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
  | { type: "provider.status"; status: ProviderStatus };

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
};

export type ApiError = { code: string; message: string; requestId?: string };

export type CreateWorkRequest = {
  title: string;
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
};

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
