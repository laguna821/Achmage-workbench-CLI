import type {
  AccessMode,
  ApprovalDecision,
  Provider,
  ProviderStatus,
  Session,
  TranscriptItem,
  Work,
} from "@workbench/contracts";

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
  /** The engine finished drawing a picture (or failed to). */
  image?(sessionId: string, image: EngineImage): void;
};

export type LoginStart = { url: string | null; message: string };

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
  /** `session.access` is resolved: the access this turn runs with. */
  send(session: Session & { access: AccessMode }, work: Work, text: string, turnKey: string): Promise<void>;
  /**
   * Put a request into the turn that is running (the engine reads it at its next step). False when
   * no turn is running any more, so the caller can start one instead.
   */
  steer?(session: Session, work: Work, text: string, turnKey: string): Promise<boolean>;
  interrupt(session: Session): Promise<void>;
  /**
   * The session's access changed (`session.access` is the new one): apply it to a running engine
   * and settle the approvals the new access no longer asks for.
   */
  setAccess?(session: Session & { access: AccessMode }): Promise<void>;
  /** Ask the engine to compact the conversation now (it also does so on its own when full). */
  compact?(session: Session, work: Work): Promise<boolean>;
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
