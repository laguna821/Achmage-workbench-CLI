import { WORKBENCH_PROTOCOL, PROTOCOL_HEADER, protocolHeader, requireProtocolWrite } from "@workbench/contracts";
import { safeRandomId } from "@getpaseo/client/internal/daemon-client-transport-utils";
import { fromByteArray, toByteArray } from "base64-js";
import { parseServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type {
  DeviceGrant, EventCursor, RemoteAuthentication, RemoteFrame, RemoteOffer, SequencedEvent,
} from "@workbench/contracts";
import { DEVICE_PERMISSIONS, REMOTE_BODY_LIMIT, REMOTE_CHUNK_BYTES } from "@workbench/contracts";
import {
  buildRelayWebSocketUrl, decodeMessageData, decodeOfferFragmentPayload, describeEndpointSecurityClose,
  describeTransportClose, describeTransportError, openProtectedTransport,
  parseConnectionOfferFromUrl, paseoReconnectDelay,
  type DaemonTransport, type ProtectedTransportOptions,
} from "./remote-transport.ts";

const DEADLINE_MS = 15_000;
const RESPONSE_WITHOUT_BODY = new Set([204, 205, 304]);
const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADERS = new Set(["accept", "accept-language", "range", "if-none-match", "if-modified-since", "content-type", "x-file-name", "x-workbench-view", "x-workbench-write", "x-workbench-work", PROTOCOL_HEADER]);

export class RemoteRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  constructor(message: string, options: { status?: number; code?: string; requestId?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RemoteRequestError";
    this.status = options.status ?? 503;
    this.code = options.code ?? "remote_disconnected";
    this.requestId = options.requestId;
  }
}

/** The peer may have accepted a mutation. The caller must reconcile its durable
 * request/receipt before deciding whether to issue any new request. */
export class RemoteOutcomeUnknownError extends RemoteRequestError {
  readonly outcome = "unknown" as const;
  constructor(requestId: string, cause: unknown) {
    super("연결이 끊겨 요청 결과를 확인하지 못했습니다. 다시 보내기 전에 처리 상태를 확인해 주세요.", {
      code: "outcome_unknown", requestId, cause,
    });
    this.name = "RemoteOutcomeUnknownError";
  }
}

export type RemotePeerStatus = {
  status: "idle" | "connecting" | "connected" | "disconnected" | "closed";
  authenticated: boolean;
  reason?: string;
  nextRetryAt?: number;
};

export interface RemotePeerOptions extends ProtectedTransportOptions {
  url: string;
  /** Pin the advertised identity as well as its public key when an offer supplies it. */
  serverId?: string;
}

type PendingRpc = {
  mutation: boolean;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingResponse = {
  mutation: boolean;
  sent: boolean;
  headersReceived: boolean;
  receivedBytes: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  resolve(value: Response): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
  releaseAbort(): void;
};
type EventSubscription = {
  cursor: EventCursor;
  generation: number;
  closed: boolean;
  onEvent(event: SequencedEvent): void;
  onResync(): void;
  onStatus(connected: boolean): void;
};
type Opening = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Workbench RPC/HTTP adapter over the original Paseo WebSocket + protected E2EE
 * transport. No command is replayed; only authentication and event membership
 * are restored after reconnect using the original reconnect delay calculation. */
export class RemotePeer {
  private readonly options: RemotePeerOptions;
  private readonly statusListeners = new Set<(status: RemotePeerStatus) => void>();
  private readonly rpcs = new Map<string, PendingRpc>();
  private readonly responses = new Map<string, PendingResponse>();
  private readonly preparing = new Set<AbortController>();
  private transport: DaemonTransport | null = null;
  private opening: Opening | null = null;
  private serverId: string | null = null;
  private expectedServerId: string | null;
  private credential: string | null = null;
  private authentication: RemoteAuthentication | null = null;
  private authenticating: { credential: string; promise: Promise<RemoteAuthentication> } | null = null;
  private subscription: EventSubscription | null = null;
  private generation = 0;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private status: RemotePeerStatus = { status: "idle", authenticated: false };

  constructor(options: RemotePeerOptions) {
    validateEndpoint(options.url);
    validatePublicKey(options.daemonPublicKeyB64);
    this.options = options;
    this.expectedServerId = options.serverId ?? null;
  }

  onStatus(listener: (status: RemotePeerStatus) => void): () => void {
    this.statusListeners.add(listener);
    safely(() => listener({ ...this.status }));
    return () => { this.statusListeners.delete(listener); };
  }

  connect(credential: string): Promise<RemoteAuthentication>;
  connect(credential?: string): Promise<RemoteAuthentication | null>;
  async connect(credential?: string): Promise<RemoteAuthentication | null> {
    const deadline = Date.now() + DEADLINE_MS;
    const requested = credential ?? this.credential;
    if (requested !== null && !requested.trim()) throw new RemoteRequestError("기기 인증 정보가 없습니다.", { status: 401, code: "invalid_credential" });
    await this.ensureTransport();
    if (!requested) return null;
    if (this.authentication && this.credential === requested) {
      if (this.authentication.grant.expiresAt !== null && this.authentication.grant.expiresAt <= Date.now()) {
        const error = new RemoteRequestError("이 기기 연결의 사용 기간이 끝났습니다.", { status: 401, code: "device_expired" });
        this.connectionLost(error, true);
        throw error;
      }
      return this.authentication;
    }
    if (this.authenticating) {
      if (this.authenticating.credential !== requested) throw new RemoteRequestError("기기 인증을 완료한 뒤 다시 시도해 주세요.", { status: 409, code: "authentication_pending" });
      return this.authenticating.promise;
    }
    const generation = this.generation;
    const attempt: { credential: string; promise: Promise<RemoteAuthentication> } = { credential: requested, promise: Promise.resolve().then(async () => {
      try {
        const value = await this.callRpc("authenticate", { credential: requested, protocol: WORKBENCH_PROTOCOL }, remaining(deadline));
        if (generation !== this.generation) throw disconnected();
        return this.acceptAuthentication(value, requested);
      } catch (error) {
        if (generation === this.generation) this.connectionLost(error, error instanceof RemoteRequestError && error.status >= 400 && error.status < 500);
        throw error;
      } finally {
        if (this.authenticating === attempt) this.authenticating = null;
      }
    }) };
    this.authenticating = attempt;
    return attempt.promise;
  }

  async rpc<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    const deadline = Date.now() + DEADLINE_MS;
    await this.ensureTransport();
    const value = await this.callRpc(op, fields, remaining(deadline));
    if (op === "authenticate") {
      if (typeof fields.credential !== "string") throw new RemoteRequestError("기기 인증 정보가 없습니다.", { status: 401, code: "invalid_credential" });
      return this.acceptAuthentication(value, fields.credential) as T;
    }
    if (op === "rotate" && isRecord(value) && typeof value.credential === "string") this.credential = value.credential;
    return value as T;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    validateRequestPath(path);
    const signal = init.signal ?? undefined;
    throwIfAborted(signal);
    const authenticated = await abortable(this.connect(), signal);
    if (!authenticated) throw new RemoteRequestError("이 기기 연결을 먼저 승인해 주세요.", { status: 401, code: "authentication_required" });
    const method = (init.method ?? "GET").toUpperCase();
    if (!REQUEST_METHODS.has(method)) throw new RemoteRequestError("지원하지 않는 원격 요청 방식입니다.", { status: 405, code: "remote_method" });
    const preparation = new AbortController();
    const abortPreparation = () => preparation.abort(abortReason(signal));
    signal?.addEventListener("abort", abortPreparation, { once: true });
    this.preparing.add(preparation);
    let request: Request;
    let bytes: Uint8Array;
    try {
      throwIfAborted(signal);
      if (this.closed) throw new RemoteRequestError("원격 연결을 닫았습니다.", { code: "remote_closed" });
      const requestInit: RequestInit & { duplex?: "half" } = { method, headers: init.headers, body: init.body, signal: preparation.signal };
      if (typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream) requestInit.duplex = "half";
      request = new Request("http://workbench.invalid" + path, requestInit);
      bytes = await readBody(request, preparation.signal);
    } finally {
      this.preparing.delete(preparation);
      signal?.removeEventListener("abort", abortPreparation);
    }
    throwIfAborted(signal);
    // Reading a caller-owned stream can outlive a connection; no request has
    // been dispatched yet, so establishing its initial connection is safe.
    if (!await abortable(this.connect(), signal)) throw new RemoteRequestError("기기 인증이 필요합니다.", { status: 401, code: "authentication_required" });
    if (this.responses.size >= 8) throw new RemoteRequestError("처리 중인 원격 요청을 기다려 주세요.", { status: 429, code: "remote_capacity" });
    if (method !== "GET" && this.authentication?.compatibility) requireProtocolWrite(this.authentication.compatibility);
    const headers: Record<string, string> = { [PROTOCOL_HEADER]: protocolHeader() };
    request.headers.forEach((value, name) => { if (REQUEST_HEADERS.has(name)) headers[name] = value; });
    const id = safeRandomId();
    let resolve!: (response: Response) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<Response>((accept, fail) => { resolve = accept; reject = fail; });
    const pending: PendingResponse = {
      mutation: method !== "GET", sent: false, headersReceived: false, receivedBytes: 0,
      controller: null, resolve, reject, timer: null, releaseAbort: () => {},
    };
    this.responses.set(id, pending);
    const cancel = () => {
      this.failResponse(id, abortReason(signal), true);
      this.cancelRequest(id);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    pending.releaseAbort = () => signal?.removeEventListener("abort", cancel);
    if (signal?.aborted) cancel();
    else {
      this.touchResponse(id, pending);
      void (async () => {
        try {
          if (this.responses.get(id) !== pending) return;
          pending.sent = true;
          await this.send({ op: "request", id, request: { id, method, path, headers, bytes: bytes.byteLength } });
          for (let offset = 0; offset < bytes.byteLength; offset += REMOTE_CHUNK_BYTES) {
            if (this.responses.get(id) !== pending) return;
            this.touchResponse(id, pending);
            await this.send({ op: "upload", id, data: fromByteArray(bytes.subarray(offset, offset + REMOTE_CHUNK_BYTES)) });
          }
          if (this.responses.get(id) === pending) this.touchResponse(id, pending);
        } catch (error) {
          this.failResponse(id, error, true);
          this.cancelRequest(id);
        }
      })();
    }
    return result;
  }

  events(
    cursor: EventCursor,
    onEvent: (event: SequencedEvent) => void,
    onResync: () => void,
    onStatus: (connected: boolean) => void,
  ): () => void {
    if (!validCursor(cursor)) throw new RemoteRequestError("이벤트 위치를 확인할 수 없습니다.", { status: 400, code: "invalid_cursor" });
    if (this.subscription) this.releaseSubscription(this.subscription);
    const subscription: EventSubscription = { cursor: { ...cursor }, generation: -1, closed: false, onEvent, onResync, onStatus };
    this.subscription = subscription;
    safely(() => onStatus(false));
    void this.connect().then((authentication) => {
      if (authentication) this.restoreSubscription(subscription);
    }).catch(() => { if (!subscription.closed) safely(() => onStatus(false)); });
    return () => this.releaseSubscription(subscription);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionLost(new RemoteRequestError("원격 연결을 닫았습니다.", { code: "remote_closed" }), true);
    if (this.subscription) this.releaseSubscription(this.subscription);
    this.updateStatus({ status: "closed", authenticated: false });
  }

  private updateStatus(status: RemotePeerStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) safely(() => listener({ ...status }));
  }

  private ensureTransport(): Promise<void> {
    if (this.closed) return Promise.reject(new RemoteRequestError("원격 연결을 닫았습니다.", { code: "remote_closed" }));
    if (this.transport && this.serverId) return Promise.resolve();
    if (this.opening) return this.opening.promise;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const generation = ++this.generation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    // A listener may close the peer synchronously during status publication.
    this.opening = { promise, resolve, reject, timer: setTimeout(() => {
      if (generation === this.generation) this.connectionLost(timeoutError());
    }, DEADLINE_MS) };
    this.updateStatus({ status: "connecting", authenticated: false });
    if (generation !== this.generation) return promise;
    try {
      const transport = openProtectedTransport({
        ...this.options,
        onSecurityMode: (mode) => {
          if (generation !== this.generation) return;
          if (mode !== "protected") this.connectionLost(new RemoteRequestError("보호된 연결을 확인하지 못했습니다.", { code: "endpoint_security" }), true);
          else safely(() => this.options.onSecurityMode?.(mode));
        },
        onMessage: (data, isBinary) => {
          if (generation === this.generation) this.receive(data, isBinary);
        },
        onClose: (event) => {
          if (generation !== this.generation) return;
          const securityFailure = describeEndpointSecurityClose(event);
          const grantFailure = isRecord(event) && event.code === 4001;
          this.connectionLost(new RemoteRequestError(securityFailure ?? describeTransportClose(event), {
            code: securityFailure ? "endpoint_security" : grantFailure ? "device_revoked" : "remote_disconnected",
          }), Boolean(securityFailure) || grantFailure);
        },
        onError: (event) => {
          if (generation === this.generation) this.connectionLost(new RemoteRequestError(describeTransportError(event)));
        },
      });
      if (generation !== this.generation) transport.close(1000, "connection ended");
      else this.transport = transport;
    } catch (error) { if (generation === this.generation) this.connectionLost(error); }
    return promise;
  }

  private acceptAuthentication(value: unknown, credential: string): RemoteAuthentication {
    if (!isRecord(value) || value.hostId !== this.serverId || !validCursor(value.cursor) || !validGrant(value.grant, this.serverId)) {
      const error = new RemoteRequestError("호스트의 기기 승인을 확인하지 못했습니다.", { status: 401, code: "invalid_grant" });
      this.connectionLost(error, true);
      throw error;
    }
    const authentication = value as unknown as RemoteAuthentication;
    this.authentication = authentication;
    this.credential = credential;
    this.retryAttempt = 0;
    this.updateStatus({ status: "connected", authenticated: true });
    if (this.subscription) this.restoreSubscription(this.subscription);
    return authentication;
  }

  private callRpc(op: string, fields: Record<string, unknown>, timeout = DEADLINE_MS): Promise<unknown> {
    const id = safeRandomId();
    if (!this.transport || !this.serverId) return Promise.reject(disconnected());
    // Serialize before registering a request: invalid local fields never went on wire.
    let text: string;
    try { text = JSON.stringify({ ...fields, type: "workbench", id, op }); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const pending: PendingRpc = {
        mutation: !["authenticate", "subscribe"].includes(op), sent: false, resolve, reject,
        timer: setTimeout(() => this.failRpc(id, timeoutError(), true), timeout),
      };
      this.rpcs.set(id, pending);
      try {
        pending.sent = true;
        Promise.resolve(this.transport!.send(text)).catch((error) => this.failRpc(id, error, true));
      } catch (error) { this.failRpc(id, error, true); }
    });
  }

  private send(frame: Omit<RemoteFrame, "type">): Promise<void> {
    if (!this.transport || !this.serverId) return Promise.reject(disconnected());
    try { return Promise.resolve(this.transport.send(JSON.stringify({ ...frame, type: "workbench" }))); }
    catch (error) { return Promise.reject(error); }
  }

  private receive(data: unknown, isBinary: boolean): void {
    let message: unknown;
    try {
      if (isBinary) throw new Error("Unexpected binary frame");
      const text = decodeMessageData(data);
      if (!text || text.length > REMOTE_CHUNK_BYTES * 1.5) throw new Error("Invalid message size");
      message = JSON.parse(text);
      if (!isRecord(message)) throw new Error("Invalid message");
      if (!this.serverId) {
        const sessionMessage = message.type === "session" && isRecord(message.message) ? message.message : null;
        const info = sessionMessage?.type === "status" ? parseServerInfoStatusPayload(sessionMessage.payload) : null;
        if (!info || info.features?.relayProtectedSecurity !== true || (this.expectedServerId && info.serverId !== this.expectedServerId)) {
          throw new Error("Host identity or protected server_info does not match");
        }
        this.serverId = info.serverId;
        this.expectedServerId ??= info.serverId;
        const opening = this.opening;
        this.opening = null;
        if (opening) { clearTimeout(opening.timer); opening.resolve(); }
        this.updateStatus({ status: "connected", authenticated: false });
        return;
      }
      if (message.type !== "workbench" || typeof message.op !== "string") throw new Error("Unexpected protocol frame");
      this.receiveFrame(message as RemoteFrame);
    } catch (error) {
      this.connectionLost(new RemoteRequestError("호스트 연결 메시지를 확인하지 못했습니다.", { code: "remote_protocol", cause: error }), true);
    }
  }

  private receiveFrame(message: RemoteFrame): void {
    if (message.op === "event" || message.op === "cursor" || message.op === "resync") {
      this.receiveEvent(message);
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    if (message.op === "result") {
      const pending = this.rpcs.get(id);
      if (!pending) return;
      this.rpcs.delete(id); clearTimeout(pending.timer); pending.resolve(message.value);
      return;
    }
    if (message.op === "error") {
      const error = remoteError(message, id);
      if (this.rpcs.has(id)) this.failRpc(id, error, false);
      const pending = this.responses.get(id);
      if (pending) {
        if (!pending.headersReceived) {
          pending.resolve(Response.json({ code: error.code, message: error.message }, { status: error.status }));
          this.finishResponse(id);
        } else this.failResponse(id, error, true);
      }
      return;
    }
    const pending = this.responses.get(id);
    if (!pending) return; // Late response to a canceled/timed-out request is not replayed.
    this.touchResponse(id, pending);
    if (message.op === "response") {
      if (pending.headersReceived || !Number.isInteger(message.status) || (message.status as number) < 200 || (message.status as number) > 599 || !isRecord(message.headers)) throw new Error("Invalid response headers");
      const headers = new Headers();
      for (const [name, value] of Object.entries(message.headers)) {
        if (typeof value !== "string") throw new Error("Invalid response header");
        headers.set(name, value);
      }
      const body = RESPONSE_WITHOUT_BODY.has(message.status as number) ? null : new ReadableStream<Uint8Array>({
        start: (controller) => { pending.controller = controller; },
        cancel: (reason) => { this.failResponse(id, reason ?? new DOMException("Response canceled", "AbortError"), true); this.cancelRequest(id); },
      });
      const response = new Response(body, { status: message.status as number, headers });
      pending.headersReceived = true;
      pending.resolve(response);
    } else if (message.op === "data") {
      if (!pending.headersReceived || !pending.controller || typeof message.data !== "string" || message.data.length > REMOTE_CHUNK_BYTES * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) throw new Error("Invalid response chunk");
      const chunk = toByteArray(message.data);
      pending.receivedBytes += chunk.byteLength;
      if (pending.receivedBytes > REMOTE_BODY_LIMIT) {
        this.failResponse(id, new RemoteRequestError("원격 응답 크기가 제한을 초과했습니다.", { status: 413, code: "remote_body_limit" }), true);
        this.cancelRequest(id);
      } else pending.controller.enqueue(chunk);
    } else if (message.op === "end") {
      if (!pending.headersReceived) throw new Error("Response ended before headers");
      pending.controller?.close();
      this.finishResponse(id);
    } else throw new Error("Unexpected response frame");
  }

  private receiveEvent(message: RemoteFrame): void {
    const subscription = this.subscription;
    if (!subscription || subscription.closed) return;
    if (message.op === "resync") { this.resync(subscription); return; }
    if (message.op === "cursor") {
      if (!validCursor(message.cursor) || message.cursor.epoch !== subscription.cursor.epoch || message.cursor.seq < subscription.cursor.seq) { this.resync(subscription); return; }
      subscription.cursor = { ...message.cursor };
      return;
    }
    const event = message.event;
    if (!isRecord(event) || typeof event.type !== "string" || !Number.isSafeInteger(event.seq) || (event.seq as number) < 1 || (event.epoch !== undefined && event.epoch !== subscription.cursor.epoch)) { this.resync(subscription); return; }
    if ((event.seq as number) <= subscription.cursor.seq) return;
    if (event.seq !== subscription.cursor.seq + 1) { this.resync(subscription); return; }
    subscription.cursor.seq = event.seq as number;
    try { subscription.onEvent(event as SequencedEvent); }
    catch { this.resync(subscription); }
  }

  private restoreSubscription(subscription: EventSubscription): void {
    if (subscription !== this.subscription || subscription.closed || !this.authentication || subscription.generation === this.generation) return;
    subscription.generation = this.generation;
    const generation = this.generation;
    void this.callRpc("subscribe", { cursor: subscription.cursor }).then((value) => {
      if (subscription !== this.subscription || subscription.closed || generation !== this.generation) return;
      if (!isRecord(value) || value.subscribed !== true) this.resync(subscription);
      else safely(() => subscription.onStatus(true));
    }).catch(() => {
      if (subscription !== this.subscription || subscription.closed || generation !== this.generation) return;
      this.resync(subscription);
    });
  }

  private resync(subscription: EventSubscription): void {
    if (subscription.closed) return;
    this.releaseSubscription(subscription);
    safely(subscription.onResync);
  }

  private releaseSubscription(subscription: EventSubscription): void {
    if (subscription.closed) return;
    subscription.closed = true;
    if (this.subscription === subscription) {
      this.subscription = null;
      if (this.transport && this.serverId) void this.send({ op: "unsubscribe" }).catch(() => {});
    }
    safely(() => subscription.onStatus(false));
  }

  private failRpc(id: string, error: unknown, uncertain: boolean): void {
    const pending = this.rpcs.get(id);
    if (!pending) return;
    this.rpcs.delete(id); clearTimeout(pending.timer);
    pending.reject(uncertain && pending.mutation && pending.sent ? new RemoteOutcomeUnknownError(id, error) : error);
  }

  private touchResponse(id: string, pending: PendingResponse): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.failResponse(id, timeoutError(), true);
      this.cancelRequest(id);
    }, DEADLINE_MS);
  }

  private finishResponse(id: string): void {
    const pending = this.responses.get(id);
    if (!pending) return;
    this.responses.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.releaseAbort();
  }

  private failResponse(id: string, error: unknown, uncertain: boolean): void {
    const pending = this.responses.get(id);
    if (!pending) return;
    this.finishResponse(id);
    const failure = uncertain && pending.mutation && pending.sent ? new RemoteOutcomeUnknownError(id, error) : error;
    pending.reject(failure);
    safely(() => pending.controller?.error(failure));
  }

  private cancelRequest(id: string): void {
    if (this.transport && this.serverId) void this.send({ op: "cancel", id }).catch(() => {});
  }

  private connectionLost(error: unknown, fatal = false): void {
    this.generation++;
    const transport = this.transport;
    this.transport = null;
    this.serverId = null;
    this.authentication = null;
    this.authenticating = null;
    if (fatal) this.credential = null;
    if (this.opening) {
      const opening = this.opening; this.opening = null;
      clearTimeout(opening.timer); opening.reject(error);
    }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const preparation of this.preparing) preparation.abort(error);
    this.preparing.clear();
    for (const id of this.rpcs.keys()) this.failRpc(id, error, true);
    for (const id of this.responses.keys()) this.failResponse(id, error, true);
    if (this.subscription) {
      this.subscription.generation = -1;
      safely(() => this.subscription?.onStatus(false));
    }
    try { transport?.close(1000, this.closed ? "connection closed" : "connection reset"); } catch { /* Already closed. */ }
    const retry = !this.closed && Boolean(this.credential) && !fatal;
    const delay = retry ? paseoReconnectDelay(this.retryAttempt++) : undefined;
    this.updateStatus({
      status: this.closed ? "closed" : "disconnected", authenticated: false,
      reason: error instanceof Error ? error.message : String(error),
      ...(delay === undefined ? {} : { nextRetryAt: Date.now() + delay }),
    });
    if (delay !== undefined && !this.closed && this.credential) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.connect().catch(() => {}); // Only auth and events are restored.
      }, delay);
    }
  }
}

/** Decode the original fragment first: the upstream schema deliberately strips
 * unknown fields, while Workbench's single-use pairing extension must survive. */
export function parseRemoteOffer(text: string): RemoteOffer {
  const input = text.trim();
  if (!input || input.length > 16_000) throw new RemoteRequestError("연결 링크를 확인해 주세요.", { status: 400, code: "invalid_offer" });
  try {
    const original = parseConnectionOfferFromUrl(input);
    const index = input.indexOf("#offer=");
    if (!original || index < 0) throw new Error("Missing offer fragment");
    const decoded = decodeOfferFragmentPayload(input.slice(index + "#offer=".length).trim());
    if (!isRecord(decoded) || !isRecord(decoded.workbench)) throw new Error("Missing Workbench extension");
    const extension = decoded.workbench;
    if (original.minimumSecurityMode !== "protected" || extension.version !== 1 || typeof extension.endpoint !== "string" ||
      typeof extension.offerId !== "string" || !extension.offerId || extension.offerId.length > 200 ||
      typeof extension.token !== "string" || extension.token.length < 16 || extension.token.length > 2048 ||
      typeof extension.label !== "string" || !extension.label.trim() || extension.label.length > 300 ||
      !Number.isSafeInteger(extension.expiresAt) || (extension.expiresAt as number) <= Date.now()) throw new Error("Invalid or expired offer");
    validatePublicKey(original.daemonPublicKeyB64);
    const endpoint = validateEndpoint(extension.endpoint);
    if (endpoint.searchParams.has("serverId") && endpoint.searchParams.get("serverId") !== original.serverId) throw new Error("Relay identity does not match");
    // Reuse original host/port and routing validation without opening a socket.
    if (/[\s/?#@]/.test(original.relay.endpoint)) throw new Error("Invalid relay endpoint");
    buildRelayWebSocketUrl({ endpoint: original.relay.endpoint, useTls: original.relay.useTls ?? false, serverId: original.serverId, role: "client" });
    return {
      ...original, minimumSecurityMode: "protected",
      workbench: { version: 1, endpoint: endpoint.href, offerId: extension.offerId, token: extension.token, expiresAt: extension.expiresAt as number, label: extension.label },
    };
  } catch (error) {
    throw new RemoteRequestError("연결 링크가 잘못되었거나 사용 기간이 끝났습니다. 호스트에서 새 링크를 만들어 주세요.", { status: 400, code: "invalid_offer", cause: error });
  }
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash ||
    [...url.searchParams.keys()].some(key => !["serverId", "role", "v"].includes(key) || url.searchParams.getAll(key).length !== 1) ||
    (url.searchParams.has("role") && url.searchParams.get("role") !== "client")) throw new RemoteRequestError("암호화 연결 주소를 확인해 주세요.", { status: 400, code: "invalid_endpoint" });
  return url;
}

function validatePublicKey(value: string): void {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length > 48) throw new Error("Invalid daemon public key");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (toByteArray(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")).byteLength !== 32) throw new Error("Invalid daemon public key");
}

function validGrant(value: unknown, hostId: string | null): value is DeviceGrant {
  return isRecord(value) && typeof value.deviceId === "string" && value.deviceId.length > 0 && value.hostId === hostId &&
    value.revokedAt === null && (value.expiresAt === null || typeof value.expiresAt === "number" && value.expiresAt > Date.now()) &&
    Array.isArray(value.permissions) && value.permissions.every(permission => DEVICE_PERMISSIONS.includes(permission)) &&
    Array.isArray(value.workIds) && value.workIds.every(id => typeof id === "string" && Boolean(id)) &&
    Number.isSafeInteger(value.credentialVersion) && (value.credentialVersion as number) >= 1;
}

function validCursor(value: unknown): value is EventCursor {
  return isRecord(value) && typeof value.epoch === "string" && Boolean(value.epoch) && Number.isSafeInteger(value.seq) && (value.seq as number) >= 0;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safely(callback: () => void): void { try { callback(); } catch { /* Consumer callbacks cannot break transport cleanup. */ } }
function disconnected(): RemoteRequestError { return new RemoteRequestError("호스트 연결이 끊어졌습니다."); }
function timeoutError(): RemoteRequestError { return new RemoteRequestError("호스트 응답을 기다리는 시간이 초과되었습니다.", { status: 504, code: "remote_timeout" }); }
function remaining(deadline: number): number { const value = deadline - Date.now(); if (value <= 0) throw timeoutError(); return value; }
function remoteError(frame: RemoteFrame, id: string): RemoteRequestError {
  return new RemoteRequestError(typeof frame.message === "string" ? frame.message : "호스트가 요청을 처리하지 못했습니다.", {
    status: typeof frame.status === "number" && Number.isInteger(frame.status) && frame.status >= 400 && frame.status <= 599 ? frame.status : 400,
    code: typeof frame.code === "string" ? frame.code : "remote_request", requestId: id,
  });
}
function validateRequestPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#") || path.length > 16_000) throw new RemoteRequestError("호스트 요청 경로를 확인해 주세요.", { status: 400, code: "invalid_path" });
}
function abortReason(signal?: AbortSignal): unknown { return signal?.reason ?? new DOMException("The request was aborted", "AbortError"); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortReason(signal); }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(abortReason(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
async function readBody(request: Request, signal?: AbortSignal): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel(abortReason(signal)).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(signal);
    while (true) {
      const next = await reader.read();
      throwIfAborted(signal);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > REMOTE_BODY_LIMIT) throw new RemoteRequestError("원격 요청 본문은 32MB까지 보낼 수 있습니다.", { status: 413, code: "remote_body_limit" });
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
