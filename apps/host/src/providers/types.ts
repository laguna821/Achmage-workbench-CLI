import type {
  AccessMode,
  ApprovalDecision,
  Provider,
  ProviderStatus,
  Session,
  TranscriptItem,
  Work,
} from "@workbench/contracts";

/** Callbacks an adapter uses to report what its engine is doing. */
export type AdapterSink = {
  upsertItem(sessionId: string, item: TranscriptItem): void;
  delta(sessionId: string, itemId: string, text: string): void;
  updateSession(sessionId: string, patch: Partial<Session>): void;
  providerStatus(status: ProviderStatus): void;
  /** Requests steered into a turn (by their turn keys) that the engine dropped when the turn stopped. */
  steerDropped(sessionId: string, turnKeys: string[]): void;
};

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
