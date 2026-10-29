import type { SendResult } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

/** Serialize preparation, not the engine turn: steering remains available after dispatch. */
export class SendGate {
  private readonly requests = new Map<string, { identity: string; promise: Promise<SendResult> }>();
  private readonly sessions = new Map<string, Promise<void>>();
  run(sessionId: string, requestId: string, identity: string, send: (release: () => void) => Promise<SendResult>): Promise<SendResult> {
    const pending = this.requests.get(requestId);
    if (pending) {
      if (pending.identity !== identity) return Promise.reject(new HttpError(409, "request_id_conflict", "같은 requestId로 다른 요청을 보냈습니다."));
      return pending.promise.then((result) => ({ ...result, duplicate: true }));
    }
    const before = this.sessions.get(sessionId) ?? Promise.resolve();
    let released = false, unlock!: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    this.sessions.set(sessionId, lock);
    const release = () => {
      if (released) return;
      released = true; unlock();
      if (this.sessions.get(sessionId) === lock) this.sessions.delete(sessionId);
    };
    const promise = before.then(() => send(release)).finally(() => { release(); this.requests.delete(requestId); });
    this.requests.set(requestId, { identity, promise });
    return promise;
  }
}
