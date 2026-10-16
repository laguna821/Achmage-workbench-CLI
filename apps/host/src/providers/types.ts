import type {
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
  send(session: Session, work: Work, text: string, turnKey: string): Promise<void>;
  interrupt(session: Session): Promise<void>;
  answerApproval(session: Session, itemId: string, decision: ApprovalDecision): Promise<boolean>;
  shutdown(): Promise<void>;
}

export function emptyStatus(provider: Provider): ProviderStatus {
  return {
    provider,
    installed: false,
    binary: null,
    version: null,
    loggedIn: null,
    account: null,
    plan: null,
    usage: [],
    usageObservedAt: null,
    models: [],
    error: null,
  };
}
