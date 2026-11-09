import type { AgentProfile, CommandReceipt, Snapshot, SubmitCommand, TaskCommand, TaskSnapshot } from "@workbench/contracts";
export { openWorkbenchClientChannel } from "./secure-channel.ts";
export type { SecureChannel, SecureChannelEvents, Transport as SecureTransport } from "./secure-channel.ts";

export type ClientOptions = { baseUrl: string; token: string; fetch?: typeof globalThis.fetch };
export class WorkbenchClient {
  private readonly url: string;
  private readonly token: string;
  private readonly transport: typeof globalThis.fetch;
  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw Error("호스트 주소를 확인해 주세요.");
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("다른 기기는 HTTPS로 연결해야 합니다.");
    if (!options.token) throw Error("Workbench 인증 토큰이 필요합니다.");
    this.url = url.origin; this.token = options.token; this.transport = options.fetch ?? globalThis.fetch;
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.transport(this.url + path, { method, redirect: "error", credentials: "omit", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json() as T & { code?: string; message?: string };
    if (!response.ok) throw Object.assign(Error(data.message ?? `Workbench HTTP ${response.status}`), { status: response.status, code: data.code });
    return data;
  }
  snapshot() { return this.request<Snapshot>("GET", "/api/snapshot"); }
  tasks(workId?: string) { return this.request<TaskSnapshot>("GET", `/api/tasks${workId ? `?workId=${encodeURIComponent(workId)}` : ""}`); }
  profiles() { return this.request<{ profiles: AgentProfile[] }>("GET", "/api/agent-profiles"); }
  submit(input: SubmitCommand) { return this.request<CommandReceipt>("POST", "/api/automation/submit", input); }
  command(input: TaskCommand) { return this.request<CommandReceipt>("POST", "/api/task-commands", input); }
  receipt(commandId: string) { return this.request<CommandReceipt>("GET", `/api/task-commands/${encodeURIComponent(commandId)}`); }
}

export { RemotePeer, RemoteRequestError, RemoteOutcomeUnknownError, parseRemoteOffer } from "./remote.ts";
export type { RemotePeerOptions, RemotePeerStatus } from "./remote.ts";

export { WorkbenchTerminalClient } from "./terminal.ts";
export type { TerminalApi, TerminalClientOptions } from "./terminal.ts";

export { safeRandomId } from "@getpaseo/client/internal/daemon-client-transport-utils";
