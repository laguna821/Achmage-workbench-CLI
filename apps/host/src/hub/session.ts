import { randomUUID } from "node:crypto";
import { ChunkedTransport } from "@getpaseo/protocol/chunked-transport";
import { WSInboundMessageSchema, ServerInfoStatusPayloadSchema, wrapSessionMessage,
  type DaemonPermission, type SessionInboundMessage, type SessionOutboundMessage, type WSHelloMessage } from "@getpaseo/protocol/messages";
import { SessionAuthorization } from "@workbench/paseo-server-transport/authorization";
import { HubExecutionController } from "@workbench/paseo-server-transport/hub/execution-controller";
import type { WebSocketLike } from "@workbench/paseo-server-transport/hub/socket-port";
import { sendBoundedPhysicalFrameAndWait } from "@workbench/paseo-server-transport/physical-socket";
import type { WorkbenchHubExecutions } from "./executions.ts";

/** A narrow host port for the original Paseo wire schemas/controller/framing.
 * It intentionally does not advertise the full Paseo daemon or expose Workbench HTTP. */
export class HubSession {
  private readonly authorization: SessionAuthorization;
  private readonly controller: HubExecutionController;
  private readonly transport: ChunkedTransport;
  private readonly socket: WebSocketLike;
  private readonly options: { serverId: string; hostname: string; principalId: string; daemonId: string;
    permissions: readonly DaemonPermission[]; sessionProtocol: "legacy" | "session-v1"; agents: WorkbenchHubExecutions };
  private hello = false;
  private closed = false;
  private ceiling: readonly DaemonPermission[] | undefined;
  private subscriptions = new Set<string>();
  private readonly subscriptionId = "hub-events-" + randomUUID();
  private readonly helloTimeout: ReturnType<typeof setTimeout>;
  constructor(socket: WebSocketLike, options: HubSession["options"]) {
    this.socket = socket; this.options = options;
    this.authorization = new SessionAuthorization(options.permissions.filter(permission => permission === "hub.execute"));
    this.controller = new HubExecutionController({ agents: options.agents, validateAgentConfiguration: input => options.agents.validate(input), send: message => this.send(message) });
    this.transport = new ChunkedTransport({ frameBytes: 512 * 1024,
      send: async frame => { if (!await sendBoundedPhysicalFrameAndWait({ socket, frame, onHighWater: () => this.close(1013, "Slow Hub receiver") })) throw new Error("Hub socket closed"); },
      deliver: frame => { void this.receive(typeof frame === "string" ? frame : Buffer.from(frame).toString("utf8")).catch(() => this.close(1008, "Invalid Hub request")); },
      onFailure: () => this.close(1008, "Invalid Hub frame") });
    this.helloTimeout = setTimeout(() => this.close(4408, "Hello timeout"), 10_000); this.helloTimeout.unref();
    socket.on("message", (...args) => {
      if (this.closed) return;
      try {
        const data = args[0], binary = args[1] === true;
        if (typeof data === "string") this.transport.receive(data);
        else if (Buffer.isBuffer(data) || data instanceof Uint8Array) this.transport.receive(binary ? data : Buffer.from(data).toString("utf8"));
        else this.close(1008, "Unsupported Hub frame");
      } catch { this.close(1008, "Invalid Hub frame"); }
    });
    socket.on("close", () => this.dispose()); socket.on("error", () => this.dispose());
    if (options.sessionProtocol === "legacy") this.admitHello({ type: "hello", clientId: "hub:" + options.daemonId, clientType: "hub", protocolVersion: 1 });
  }
  private wire(value: unknown) {
    if (this.closed || this.socket.readyState !== 1) return;
    try { void this.transport.send(JSON.stringify(value)).catch(() => this.close(1011, "Hub send failed")); }
    catch { this.close(1011, "Hub send failed"); }
  }
  private send(message: SessionOutboundMessage) {
    if (!this.authorization.allowsOutbound(message)) return;
    if ((message.type === "hub.execution.agent.update" || message.type === "hub.execution.agent.stream") && !this.subscriptions.has(message.type)) return;
    this.wire(wrapSessionMessage(message));
  }
  private admitHello(message: WSHelloMessage) {
    if (this.hello || message.clientType !== "hub" || message.protocolVersion < 1 || message.routed === true) { this.close(4400, "Unsupported Hub hello"); return; }
    this.hello = true; clearTimeout(this.helloTimeout); this.ceiling = message.sessionPermissions;
    this.updatePermissions(this.options.permissions);
    this.send({ type: "status", payload: ServerInfoStatusPayloadSchema.parse({ status: "server_info", protocolVersion: 1,
      serverId: this.options.serverId, hostname: this.options.hostname, version: "workbench-0.4.0", sourceId: this.options.principalId,
      permissions: this.authorization.listPermissions(), features: { hubAgentRpc: true, binaryChunkingV1: true, explicitEventSubscriptions: true, ownedSubscriptions: true } }) });
    this.transport.enabled = message.capabilities?.binaryChunkingV1 === true;
    if (!message.capabilities?.explicitEventSubscriptions) {
      this.subscriptions = new Set(["hub.execution.agent.update", "hub.execution.agent.stream"]);
      this.controller.setObserving(this.authorization.allowsPermission("hub.execute"));
    }
  }
  updatePermissions(permissions: readonly DaemonPermission[]) {
    this.authorization.replacePermissions(permissions.filter(permission => permission === "hub.execute" && (!this.ceiling || this.ceiling.includes(permission))));
    this.controller.setObserving(this.hello && this.subscriptions.size > 0 && this.authorization.allowsPermission("hub.execute"));
  }
  private reject(message: SessionInboundMessage, code: string, error: string) {
    if ("requestId" in message && typeof message.requestId === "string") this.send({ type: "rpc_error", payload: { requestId: message.requestId, requestType: message.type, code, error } });
  }
  private async receive(text: string) {
    if (Buffer.byteLength(text) > 512 * 1024) { this.close(1009, "Hub request too large"); return; }
    const parsed = WSInboundMessageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) { this.close(1008, "Invalid Paseo Hub message"); return; }
    const message = parsed.data;
    if (message.type === "ping") { this.wire({ type: "pong" }); return; }
    if (message.type === "hello") { this.admitHello(message); return; }
    if (!this.hello) { this.close(4400, "Hello required"); return; }
    if (message.type !== "session") return;
    const request = message.message;
    if (!this.authorization.allowsInbound(request)) { this.reject(request, "permission_denied", "This Hub relationship does not have that permission."); return; }
    if (request.type === "hub.execution.agent.create.request") await this.controller.createAgent(request);
    else if (request.type === "hub.execution.agent.validate.request") await this.controller.validateAgent(request);
    else if (request.type === "hub.execution.control.request") await this.controller.controlExecution(request);
    else if (request.type === "session.events.set_subscription.request") {
      this.subscriptions = new Set(request.events.filter(event => event === "hub.execution.agent.update" || event === "hub.execution.agent.stream"));
      this.send({ type: "session.events.set_subscription.response", payload: { requestId: request.requestId, subscriptionId: this.subscriptionId } });
      this.controller.setObserving(this.subscriptions.size > 0 && this.authorization.allowsPermission("hub.execute"));
    } else if (request.type === "subscription.release.request") {
      if (request.subscriptionId === this.subscriptionId) { this.subscriptions.clear(); this.controller.setObserving(false); }
      this.send({ type: "subscription.release.response", payload: { requestId: request.requestId, subscriptionId: request.subscriptionId } });
    } else if (request.type === "ping") this.send({ type: "pong", payload: { requestId: request.requestId, clientSentAt: request.clientSentAt, serverReceivedAt: Date.now(), serverSentAt: Date.now() } });
    else this.reject(request, "unsupported_operation", "Workbench exposes only the approved Hub execution operations on this connection.");
  }
  close(code = 1000, reason = "Hub connection closed") { if (!this.closed) { this.socket.close(code, reason); this.dispose(); } }
  private dispose() { if (this.closed) return; this.closed = true; clearTimeout(this.helloTimeout); this.transport.close(); void this.controller.cleanup(); }
}
