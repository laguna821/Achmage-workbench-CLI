import type {
  AccessMode,
  ApprovalDecision,
  EngineCommand,
  Provider,
  ProviderStatus,
  Session,
  TranscriptItem,
  Work,
} from "@workbench/contracts";

/** An attachment as the engine gets it: the stored file and what it is. */
export type AttachedFile = { path: string; name: string; mime: string };

/**
 * A picture an engine drew (Codex's image tool): where the engine saved it and/or the image data
 * (base64), the prompt as the image model rewrote it, and why it failed when it did.
 */
export type EngineImage = {
  id: string;
  status: string;
  result: string | null;
  savedPath: string | null;
  revisedPrompt: string | null;
  failure: { type: string; resetsAt?: number | null } | null;
};

/** Callbacks an adapter uses to report what its engine is doing. */
export type AdapterSink = {
  upsertItem(sessionId: string, item: TranscriptItem): void;
  delta(sessionId: string, itemId: string, text: string): void;
  updateSession(sessionId: string, patch: Partial<Session>): void;
  providerStatus(status: ProviderStatus): void;
  /** Requests steered into a turn (by their turn keys) that the engine dropped when the turn stopped. */
  steerDropped(sessionId: string, turnKeys: string[]): void;
  /** Pictures a step produced or looked at (a file, or image data the engine returned), shown under it. */
  toolImages(sessionId: string, itemId: string, images: ToolImage[]): void;

  /** The engine finished drawing a picture (or failed to). */
  image?(sessionId: string, image: EngineImage): void;
};

/** A conversation an engine keeps on this computer (its id, title, folder and last change). */
export type NativeConversation = { nativeSessionId: string; title: string; cwd: string | null; updatedAt: number };

/** A picture from a step: a file the engine names, or base64 data a tool returned. */
export type ToolImage = { path: string } | { data: string; name?: string };

export type LoginStart = { url: string | null; message: string };

/**
 * What a new engine process is told and kept from (pkm.ts): the context card, and for Claude the
 * hooks that deny writes into the vault; for Codex whether its sandbox must be read-only (its work
 * folder overlaps the vault) and leave out the temporary folders (the vault is in one).
 */
export type ClaudeLaunch = (session: Session & { access: AccessMode }, work: Work) => { append: string | null; hooks: import("@anthropic-ai/claude-agent-sdk").Options["hooks"] | null };
export type CodexLaunch = (session: Session & { access: AccessMode }, work: Work) => { instructions: string | null; readOnly: boolean; excludeTmp: boolean };

/**
 * One adapter per engine. Sessions are started lazily on the first message so that
 * archived or idle sessions do not keep engine processes alive.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  init(): Promise<void>;
  status(): ProviderStatus;
  refreshStatus(): Promise<ProviderStatus>;
  login(): Promise<LoginStart>;
  /**
   * `session.access` is resolved: the access this turn runs with. `session.plan`: "계획 먼저", the
   * engine only plans (reads, no changes) and the plan waits for the go-ahead. `files`: attachments.
   */
  send(session: Session & { access: AccessMode; plan?: boolean }, work: Work, text: string, turnKey: string, files?: AttachedFile[]): Promise<void>;
  /**
   * Put a request into the turn that is running (the engine reads it at its next step). False when
   * no turn is running any more, so the caller can start one instead.
   */
  steer?(session: Session, work: Work, text: string, turnKey: string, files?: AttachedFile[]): Promise<boolean>;
  interrupt(session: Session): Promise<void>;
  /**
   * The session's access changed (`session.access` is the new one): apply it to a running engine
   * and settle the approvals the new access no longer asks for.
   */
  setAccess?(session: Session & { access: AccessMode }): Promise<void>;
  /** Ask the engine to compact the conversation now (it also does so on its own when full). */
  compact?(session: Session, work: Work): Promise<boolean>;
  /**
   * "이 요청 전으로": a new engine conversation holding this one's first `keep.turns` turns, that is
   * its first `keep.requests` requests (Codex counts turns, Claude Code requests). Its id.
   */
  forkNative?(session: Session & { access: AccessMode }, work: Work, keep: { turns: number; requests: number }): Promise<string>;
  /** "가져오기": conversations the engine keeps on this computer (a terminal's, another app's), newest first. */
  listNative?(query: string): Promise<NativeConversation[]>;
  /** One such conversation: where it ran, its title, and its record as transcript items. */
  nativeHistory?(nativeSessionId: string): Promise<NativeConversation & { items: TranscriptItem[] }>;
  /** What a request can start with ("/"): the engine's commands and the skills it finds for the work. */
  commands?(session: Session & { access: AccessMode }, work: Work): Promise<EngineCommand[]>;
  answerApproval(session: Session, itemId: string, decision: ApprovalDecision): Promise<boolean>;
  shutdown(): Promise<void>;
}

export function emptyStatus(provider: Provider): ProviderStatus {
  return {
    provider,
    installed: false,
    binary: null,
    binarySource: null,
    version: null,
    loggedIn: null,
    loginMethod: null,
    billingVars: [],
    account: null,
    plan: null,
    usage: [],
    usageObservedAt: null,
    models: [],
    configuredAccess: null,
    error: null,
  };
}
