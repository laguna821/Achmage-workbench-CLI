import { safeRandomId } from "@getpaseo/client/internal/daemon-client-transport-utils";
import type { TerminalOutput, TerminalSession } from "@workbench/contracts";
import type { TerminalReplay, TerminalResizeOwner } from "../../contracts/src/terminal-runtime.ts";
import type { TerminalClientPort, TerminalInput, TerminalObservation, TerminalSubscriptionObserver, TerminalSubscriptionPayload } from "@workbench/paseo-terminal/ports";

export interface TerminalApi {
  terminalOutput(id: string, cursor?: number, signal?: AbortSignal): Promise<TerminalOutput>;
  terminalReplay(id: string, signal?: AbortSignal): Promise<TerminalReplay>;
  terminalInput(id: string, data: string): Promise<unknown>;
  resizeTerminal(id: string, cols: number, rows: number, owner?: TerminalResizeOwner): Promise<unknown>;
}
export interface TerminalClientOptions {
  onMetadata?(terminal: TerminalSession): void;
  onTruncated?(): void;
  onConnection?(connected: boolean, error?: string): void;
  onInputError?(error: unknown): void;
  isVisible?(): boolean;
  pollMilliseconds?: number;
}

/** The original Paseo controller's observer port over Workbench's existing secure HTTP transport. */
export class WorkbenchTerminalClient implements TerminalClientPort {
  readonly ownerId = safeRandomId();
  private readonly api: TerminalApi;
  private readonly options: TerminalClientOptions;
  private writes: Promise<unknown> = Promise.resolve();
  private writeGeneration = 0;
  private disposed = false;
  private readonly observations = new Set<() => Promise<void>>();
  constructor(api: TerminalApi, options: TerminalClientOptions = {}) { this.api = api; this.options = options; }
  sendTerminalInput(id: string, message: TerminalInput): void {
    if (this.disposed) return;
    const generation = this.writeGeneration;
    const messages = message.type === "input"
      ? Array.from(message.data).reduce<string[]>((all, point, index) => { const slot = Math.floor(index / 8192); all[slot] = (all[slot] ?? "") + point; return all; }, []).map(data => ({ type: "input" as const, data }))
      : [message];
    for (const part of messages) this.writes = this.writes.then(async () => {
      if (this.disposed || generation !== this.writeGeneration) return;
      if (part.type === "input") await this.api.terminalInput(id, part.data);
      else await this.api.resizeTerminal(id, part.cols, part.rows, { ownerId: this.ownerId, intent: part.intent ?? "update" });
    }).catch(error => {
      // A lost mutation result is never replayed. Drop already queued keystrokes too.
      this.writeGeneration++; this.options.onInputError?.(error);
    });
  }
  observeTerminal(id: string, receive: Parameters<TerminalClientPort["observeTerminal"]>[1], input?: Parameters<TerminalClientPort["observeTerminal"]>[2]): TerminalObservation {
    const abort = new AbortController(), subscriptionId = safeRandomId(), observers = new Set<TerminalSubscriptionObserver>();
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, cursor = 0, identity: TerminalSession | undefined, loaded = false, payload: TerminalSubscriptionPayload | undefined;
    let ready!: (value: TerminalSubscriptionPayload) => void;
    const pending = new Promise<TerminalSubscriptionPayload>(resolve => { ready = resolve; });
    const release = async () => {
      if (stopped) return; stopped = true; clearTimeout(timer); abort.abort();
      this.observations.delete(release); input?.signal?.removeEventListener("abort", cancel);
      if (!payload) { payload = { error: "Terminal observation closed", terminalId: id, subscriptionId }; ready(payload); }
      observers.clear();
    };
    const cancel = () => { void release(); };
    input?.signal?.addEventListener("abort", cancel, { once: true });
    const emit = (event: Parameters<typeof receive>[0]) => { if (!stopped) receive(event); };
    const replay = async () => {
      const snapshot = await this.api.terminalReplay(id, abort.signal);
      if (stopped) return;
      identity = snapshot.terminal; cursor = snapshot.cursor;
      this.options.onMetadata?.(snapshot.terminal);
      if (snapshot.truncated) this.options.onTruncated?.();
      emit({ type: "replay", terminalId: id, subscriptionId, replay: { type: "begin", rows: snapshot.rows, cols: snapshot.cols, retainedHistoryLines: snapshot.retainedHistoryLines } });
      const bytes = Uint8Array.from(atob(snapshot.data), c => c.charCodeAt(0));
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) emit({ type: "replay", terminalId: id, subscriptionId, replay: { type: "data", data: bytes.subarray(offset, offset + 64 * 1024) } });
      emit({ type: "replay", terminalId: id, subscriptionId, replay: { type: "end" } });
      loaded = true;
      if (!payload) {
        payload = { error: null, terminalId: id, subscriptionId };
        for (const observer of observers) observer.snapshot?.(payload);
        ready(payload);
      }
    };
    const poll = async () => {
      let delay = this.options.pollMilliseconds ?? 100;
      try {
        if (!loaded) await replay();
        if (stopped) return;
        const output = await this.api.terminalOutput(id, cursor, abort.signal);
        if (stopped) return;
        if (identity && (identity.createdAt !== output.terminal.createdAt || identity.workspaceId !== output.terminal.workspaceId || identity.hostId !== output.terminal.hostId)) throw Object.assign(new Error("터미널 실행 소유권이 달라졌습니다."), { status: 409 });
        this.options.onMetadata?.(output.terminal);
        if (output.truncated || output.start !== cursor || output.end < cursor) { loaded = false; this.options.onTruncated?.(); delay = 0; }
        else {
          if (output.data) emit({ type: "output", terminalId: id, subscriptionId, data: Uint8Array.from(atob(output.data), c => c.charCodeAt(0)) });
          cursor = output.end;
          if (cursor < output.terminal.outputEnd) delay = 0;
          else if (!["starting", "running", "stopping"].includes(output.terminal.status)) {
            for (const observer of observers) observer.update?.({ type: "terminal_stream_exit", payload: { error: output.terminal.error } });
            await release(); return;
          } else if (this.options.isVisible?.() === false) delay = 1500;
        }
        this.options.onConnection?.(true);
      } catch (error) {
        if (stopped) return;
        const status = (error as { status?: number }).status, message = error instanceof Error ? error.message : String(error);
        this.options.onConnection?.(false, message);
        if (status && [401, 403, 404, 409].includes(status)) {
          if (!payload) { payload = { error: message, terminalId: id, subscriptionId }; ready(payload); }
          for (const observer of observers) observer.update?.({ type: "terminal_stream_exit", payload: { error: message } });
          await release(); return;
        }
        delay = 1500;
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    };
    this.observations.add(release);
    if (this.disposed || input?.signal?.aborted) void release();
    else queueMicrotask(() => void poll());
    return { subscriptionId, ready: pending, subscribe(observer) { observers.add(observer); if (payload) observer.snapshot?.(payload); return () => observers.delete(observer); }, release };
  }
  dispose() { this.disposed = true; this.writeGeneration++; for (const release of this.observations) void release(); }
}
