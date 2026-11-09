import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Work, WorkspaceService, WorkspaceServiceList, WorkspaceServiceOwner, WorkspaceServiceStart } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { Terminals } from "./terminals.ts";
import type { Workspaces } from "./workspaces.ts";
import { HttpError } from "./errors.ts";

const key = "workspace-services:v1";
const active = (status: WorkspaceService["status"]) => ["starting", "running", "stopping"].includes(status);
const fingerprint = (space: string, request: WorkspaceServiceStart) => JSON.stringify([space, request.label, request.command, request.port ?? null]);

/** Service records refer only to PTYs started here. A stored PID never authorizes process control. */
export class WorkspaceServices {
  private readonly records = new Map<string, WorkspaceService>();
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<WorkspaceService> }>();
  private readonly store: Store;
  private readonly spaces: Workspaces;
  private readonly terminals: Terminals;
  private readonly work: (id: string) => Work;
  constructor(store: Store, spaces: Workspaces, terminals: Terminals, work: (id: string) => Work) {
    this.store = store; this.spaces = spaces; this.terminals = terminals; this.work = work;
    const raw = store.getMeta(key);
    if (raw) for (const row of JSON.parse(raw) as WorkspaceService[]) this.records.set(row.id, row);
  }
  private save(row: WorkspaceService) {
    this.records.set(row.id, row);
    this.store.setMeta(key, JSON.stringify([...this.records.values()]));
    return row;
  }
  get(id: string): WorkspaceService {
    const row = this.records.get(id);
    if (!row) throw new HttpError(404, "service_missing", "이 작업공간의 서버 실행 기록이 없습니다.");
    if (!this.terminals.has(row.terminalId)) return { ...row, status: "interrupted", pid: null, error: "실행 기록을 확인할 수 없습니다. 자동으로 다시 실행하지 않았습니다." };
    const terminal = this.terminals.get(row.terminalId);
    if (terminal.workspaceId !== row.workspaceId || terminal.createdAt !== row.startedAt) throw new HttpError(409, "service_owner", "서버 실행의 소유권이 달라졌습니다.");
    return { ...row, status: terminal.status, pid: terminal.pid, exitCode: terminal.exitCode, error: terminal.error };
  }
  list(workspaceId: string): WorkspaceServiceList {
    const terminals = this.terminals.list(workspaceId);
    return { available: terminals.available, services: [...this.records.values()].filter(row => row.workspaceId === workspaceId).map(row => this.get(row.id)).sort((a, b) => b.startedAt - a.startedAt) };
  }
  start(workspaceId: string, request: WorkspaceServiceStart): Promise<WorkspaceService> {
    if (!request || typeof request.requestId !== "string" || !/^[\w-]{12,80}$/.test(request.requestId)
      || typeof request.label !== "string" || !request.label.trim() || request.label.length > 80
      || typeof request.command !== "string" || !request.command.trim() || request.command.length > 8192 || request.command.includes("\0")
      || (request.port !== undefined && (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535))) throw new HttpError(400, "service_request", "서버 이름·실행 명령·포트를 확인해 주세요.");
    const hash = fingerprint(workspaceId, request), pending = this.pending.get(request.requestId);
    if (pending) {
      if (pending.fingerprint !== hash) throw new HttpError(409, "service_request_reused", "다른 서버 실행에 사용한 요청 ID입니다.");
      return pending.promise;
    }
    const promise = this.launch(workspaceId, request).finally(() => this.pending.delete(request.requestId));
    this.pending.set(request.requestId, { fingerprint: hash, promise });
    return promise;
  }
  private async launch(workspaceId: string, request: WorkspaceServiceStart) {
    const existing = this.records.get(request.requestId);
    if (existing) {
      if (fingerprint(existing.workspaceId, { requestId: existing.id, label: existing.label, command: existing.command, ...(existing.port ? { port: existing.port } : {}) }) !== fingerprint(workspaceId, request)) throw new HttpError(409, "service_request_reused", "다른 서버 실행에 사용한 요청 ID입니다.");
      return this.get(existing.id);
    }
    const chosen = this.spaces.get(workspaceId), workspace = this.spaces.requireActive(workspaceId, chosen.workId);
    if (this.work(workspace.workId).archivedAt) throw new HttpError(409, "work_archived", "보관한 프로젝트에서는 새 서버를 실행할 수 없습니다.");
    if (this.records.size >= 2000) throw new HttpError(429, "service_history_limit", "서버 실행 기록이 가득 찼습니다. 이전 기록을 정리한 뒤 다시 실행해 주세요.");
    if (request.port) {
      await portAvailable(request.port);
      if ([...this.records.values()].some(row => row.port === request.port && active(this.get(row.id).status))) throw new HttpError(409, "service_port_busy", `포트 ${request.port}를 다른 서버가 사용 중입니다. 다른 포트를 선택해 주세요.`);
    }
    // The shell receives the exact command explicitly submitted by the user, in this fixed cwd.
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", request.command] : ["-lc", request.command];
    const terminal = this.terminals.create(workspaceId, { requestId: `service-${request.requestId}`, label: request.label, shell, args }, { environment: request.port ? { PORT: String(request.port) } : {} });
    return this.save({ id: request.requestId, workspaceId, workId: workspace.workId, hostId: workspace.hostId, cwd: terminal.cwd,
      label: request.label, command: request.command, port: request.port ?? null, url: request.port ? `http://127.0.0.1:${request.port}` : null,
      terminalId: terminal.id, ownerId: randomUUID(), startedAt: terminal.createdAt, status: terminal.status, pid: terminal.pid, exitCode: null, error: terminal.error });
  }
  async stop(id: string, owner: WorkspaceServiceOwner) {
    const service = this.get(id);
    if (!owner || owner.ownerId !== service.ownerId || owner.terminalId !== service.terminalId || owner.startedAt !== service.startedAt) throw new HttpError(409, "service_owner", "서버 실행의 소유권이 달라졌습니다. 현재 실행을 다시 불러와 주세요.");
    if (active(service.status)) await this.terminals.close(service.terminalId);
    return this.get(id);
  }
  forget(id: string) {
    if (active(this.get(id).status)) throw new HttpError(409, "service_running", "실행을 종료한 뒤 기록을 목록에서 지울 수 있습니다.");
    this.records.delete(id);
    this.store.setMeta(key, JSON.stringify([...this.records.values()]));
    return { ok: true };
  }
  forgetWork(workId: string) {
    for (const row of this.records.values()) if (row.workId === workId && !active(this.get(row.id).status)) this.records.delete(row.id);
    this.store.setMeta(key, JSON.stringify([...this.records.values()]));
  }
}

function portAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new HttpError(409, "service_port_busy", `포트 ${port}를 사용할 수 없습니다. 실행 중인 서버를 확인하거나 다른 포트를 선택해 주세요.`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}
