/** Structural extraction of the original observer surface; Workbench adapts its byte journal. */
export type TerminalReplayEvent =
  | { type: "begin"; rows?: number; cols?: number; retainedHistoryLines?: number }
  | { type: "data"; data: Uint8Array }
  | { type: "end" };
export type TerminalStreamEvent = { terminalId: string; subscriptionId: string } & (
  | { type: "output"; data: Uint8Array }
  | { type: "replay"; replay: TerminalReplayEvent }
);
export interface SubscribeTerminalRequest { restore?: { mode: "full-snapshot"; size?: { rows: number; cols: number } } }
export type TerminalSubscriptionPayload = { error: string | null; terminalId: string; subscriptionId: string };
export interface TerminalSubscriptionObserver {
  snapshot?(value: TerminalSubscriptionPayload): void;
  update?(value: { type: "terminal_stream_exit"; payload: { error: string | null } }): void;
}
export interface TerminalObservation {
  readonly subscriptionId: string;
  ready: Promise<TerminalSubscriptionPayload>;
  subscribe(observer: TerminalSubscriptionObserver): () => void;
  release(): Promise<void>;
}
export type TerminalInput = { type: "input"; data: string } | { type: "resize"; rows: number; cols: number; intent?: "claim" | "update" };
export interface TerminalClientPort {
  observeTerminal(id: string, receive: (event: TerminalStreamEvent) => void, options?: { restore?: SubscribeTerminalRequest["restore"]; signal?: AbortSignal }): TerminalObservation;
  sendTerminalInput(id: string, message: TerminalInput): void;
}
export interface TerminalReplayOptions { scrollbackLines?: number }
export interface TerminalSizePort {
  getSize(): { rows: number; cols: number };
  send(message: { type: "resize"; rows: number; cols: number }): void;
}
export const i18n = { t: (_key: string) => "터미널 출력에 연결하지 못했습니다." };
