import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { formatOf } from "@workbench/contracts";
import { startControlServer } from "../../../vendor/ieumoffice/apps/shell/src/main/control-server.ts";
import { controlHandler } from "../../../vendor/ieumoffice/apps/shell/src/main/control-handlers.ts";
import { controlEndpoint } from "../../../vendor/ieumoffice/packages/cli/src/control.ts";
import { HttpError } from "./errors.ts";

const kinds = { docx: "docs", pptx: "slides", xlsx: "sheets", pdf: "pdf", markdown: "markdown", html: "html", hwpx: "hwp", hwp: "hwp", xmind: "mindmap", epub: "epub" };
const failure = (reason, message) => ({ ok: false, error: { reason, message } });
const identity = path => { try { const value = realpathSync(path); return process.platform === "win32" ? value.toLowerCase() : value; } catch { return null; } };
const validId = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id);

/** Original local socket and handler, adapted to the existing document/window registry. */
export class OfficeControl {
  constructor(manager, bus, dataDir) {
    this.manager = manager; this.bus = bus; this.directory = join(dataDir, "office");
    this.pending = new Map(); this.server = null; this.closed = false;
  }
  async start() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // The upstream server unlinks stale sockets. Do not let it replace a live owner's endpoint.
    if (controlEndpoint({ GENOFFICE_USER_DATA: this.directory })) throw new Error("이 프로필의 Office 제어 서버가 이미 실행 중입니다.");
    this.server = await startControlServer(this.directory, request => this.handle(request));
  }
  view(artifactId) {
    const views = this.manager.documents.registry.forArtifact(artifactId);
    return views.find(view => view.mode === "write") ?? views[0];
  }
  locate(path) {
    const file = identity(path);
    return file ? this.manager.documents.list().find(artifact => identity(artifact.path) === file) : undefined;
  }
  open(path) {
    const existing = this.locate(path);
    if (existing) return existing;
    if (!kinds[formatOf(path)]) throw new Error("이 형식은 내장 Office에서 열 수 없습니다.");
    const snapshot = this.manager.snapshot(), file = identity(path);
    const workspace = snapshot.workspaces.filter(space => !space.archivedAt && !space.removedAt && snapshot.works.some(work => work.id === space.workId && !work.archivedAt))
      .map(space => ({ space, root: identity(space.cwd) })).filter(({ root }) => {
        if (!root) return false;
        const rel = relative(root, file); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      }).sort((a, b) => b.root.length - a.root.length)[0]?.space;
    const work = workspace ? null : this.manager.createWork({ title: basename(dirname(path)), cwd: dirname(path) });
    return this.manager.openFile(workspace?.workId ?? work.id, path, workspace?.id);
  }
  async handle(request) {
    if (this.closed) return failure("app_unavailable", "앱을 종료하고 있습니다.");
    if (!request || !["open", "selection"].includes(request.cmd) || typeof request.path !== "string" || !isAbsolute(request.path)) return failure("invalid_argument", "절대 문서 경로가 필요합니다.");
    if (!identity(request.path)) return failure("file_not_found", `file not found: ${request.path}`);
    if (!statSync(request.path).isFile()) return failure("unsupported", "문서 파일만 열 수 있습니다.");
    let artifact = this.locate(request.path);
    if (artifact) {
      const view = this.view(artifact.id);
      if (view) artifact = this.manager.documents.get(view.artifactId);
    }
    try {
      if (request.cmd === "open") {
        artifact ??= this.open(request.path);
        const shown = await this.send({ kind: "open", artifact, windowId: this.view(artifact.id)?.windowId ?? null }, 20_000);
        if (shown.status !== "ok") return failure("app_unavailable", shown.error?.message ?? "문서 창을 열지 못했습니다.");
      }
      if (!artifact || (request.cmd === "selection" && !this.view(artifact.id))) return failure("file_not_open_in_gui", "이 문서를 보여 주는 창이 없습니다.");
      const target = artifact;
      const rendererRequest = request.cmd === "open" ? { cmd: "goto", target: request.target } : { cmd: "selection" };
      // Upstream validates the tab kind and retries not_ready. Its generated JS is not
      // evaluated: this per-request facade forwards only the fixed renderer request.
      const tab = { id: target.id, kind: kinds[target.format], webContents: {
        isDestroyed: () => this.closed,
        isLoading: () => !this.view(target.id),
        executeJavaScript: async () => {
          const view = this.view(target.id);
          if (!view) return { status: "not_ready" };
          return this.send({ kind: "renderer", viewId: view.viewId, windowId: view.windowId, request: rendererRequest }, 2_000);
        },
      } };
      return await controlHandler({ reveal() {}, activateTab() {}, openDocument: () => false,
        findTab: path => identity(path) === identity(target.path) ? tab : undefined })(request);
    } catch (error) { return failure("app_unavailable", error instanceof Error ? error.message : String(error)); }
  }
  send(command, timeout) {
    if (this.pending.size >= 64) return Promise.resolve({ status: "error", error: { reason: "app_unavailable", message: "문서 제어 요청이 너무 많습니다." } });
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ status: "not_ready" }); }, timeout);
      this.pending.set(id, { command: { ...command, id }, resolve, timer });
      this.bus.publish({ type: "office.control" });
    });
  }
  list(windowId, main) {
    if (!validId(windowId)) throw new HttpError(400, "office_control_window", "창 ID가 필요합니다.");
    const commands = [];
    for (const pending of this.pending.values()) {
      const command = pending.command;
      if (command.windowId === null && main) command.windowId = windowId;
      if (command.windowId === windowId) commands.push(command);
    }
    return { commands };
  }
  reply(id, windowId, reply) {
    const entry = this.pending.get(id);
    if (!entry || entry.command.windowId !== windowId) return { accepted: false };
    if (!reply || !["ok", "not_ready", "error"].includes(reply.status) ||
      (reply.status === "ok" && (!reply.result || typeof reply.result !== "object" || Array.isArray(reply.result))) ||
      (reply.status === "error" && (!reply.error || typeof reply.error.reason !== "string" || typeof reply.error.message !== "string")) ||
      Buffer.byteLength(JSON.stringify(reply)) > 60_000) throw new HttpError(400, "office_control_reply", "문서 제어 응답이 올바르지 않습니다.");
    this.pending.delete(id); clearTimeout(entry.timer); entry.resolve(reply); return { accepted: true };
  }
  close() {
    this.closed = true; this.server?.close(); this.server = null;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.resolve({ status: "not_ready" }); }
    this.pending.clear();
  }
}
