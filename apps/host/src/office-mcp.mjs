import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServerService } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/mcp-server.ts";
import { McpLogger } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/mcp-logger.ts";
import { createCliRunner } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/cli-runner.ts";
import { createSessionHost, createSessionTools } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/tools/session-tools.ts";
import { createDocumentTools, documentDriver } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/tools/document-tools.ts";
import { createSlidesTools, slidesDriver } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/tools/slides-tools.ts";
import { createSheetsTools, sheetsDriver } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/tools/sheets-tools.ts";
import { createPdfTools } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/tools/pdf-tools.ts";
import { createHwpTools } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/tools/hwp-tools.ts";
import { createOpenDocumentTools, resolveOpenDocumentOfFamily } from "../../../vendor/ieumoffice/apps/shell/src/main/mcp/tools/open-documents-tools.ts";
import { ieumAppEnvironment } from "./ieumoffice.ts";
import { OfficeOutputs } from "./office-output.ts";
import { HttpError } from "./errors.ts";

const kinds = { docx: "docs", pptx: "slides", xlsx: "sheets", pdf: "pdf", markdown: "markdown", html: "html", hwp: "hwp", hwpx: "hwp", xmind: "mindmap", epub: "epub" };
const defaults = { enabled: false, port: 3093, background: false, logging: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The pinned Ieum MCP server/tools; only its Electron controls are replaced. */
export class OfficeMcp {
  constructor(manager, control, dataDir, { defaultSaveDir, version, ieum } = {}) {
    this.manager = manager; this.control = control;
    this.directory = join(dataDir, "office"); this.settingsPath = join(this.directory, "mcp-settings.json");
    this.logPath = join(this.directory, "mcp.log"); this.logger = new McpLogger(this.logPath);
    this.defaultSaveDir = defaultSaveDir ?? (() => join(dataDir, "works")); this.version = version ?? "0.2.6";
    this.outputs = new OfficeOutputs(manager.documents, (...args) => manager.registerOfficeCopy(...args));
    this.cli = ieum?.install ? createCliRunner({ executable: process.execPath, entry: ieum.install.script, env: ieumAppEnvironment(dataDir, process.env.WORKBENCH_APP_BIN ?? ieum.appWrapper ?? ieum.install.app) }) : undefined;
    this.settings = { ...defaults }; this.server = null; this.ids = new Map(); this.nextId = 1; this.changing = Promise.resolve(); this.closed = false;
    try { this.settings = this.normalize(JSON.parse(readFileSync(this.settingsPath, "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") this.startError = "MCP 설정을 읽지 못했습니다. 설정에서 확인해 주세요."; }
  }
  normalize(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("MCP 설정이 올바르지 않습니다.");
    const next = { ...this.settings, ...patch };
    if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535 || ["enabled", "background", "logging"].some(key => typeof next[key] !== "boolean")) throw new Error("MCP 포트와 설정을 확인해 주세요.");
    return Object.fromEntries(Object.keys(defaults).map(key => [key, next[key]]));
  }
  async start() {
    if (this.startError || !this.settings.enabled) return;
    try { await this.launch(); } catch (error) { this.startError = `MCP 서버를 시작하지 못했습니다: ${error.message}`; }
  }
  async launch() {
    this.server = new McpServerService({ port: this.settings.port, version: this.version, toolsFactory: () => this.tools(), logger: message => { if (this.settings.logging) this.logger.append(message); } });
    await this.server.start(this.settings.port);
  }
  status() {
    const running = this.server?.isRunning() ?? false;
    return { ...this.settings, running, url: running ? this.server.getUrl() : null, capabilities: ["docs", "slides", "sheets", "pdf", "hwp"], ...(this.startError ? { error: this.startError } : {}) };
  }
  async invoke(channel, args = []) {
    if (this.closed) throw new Error("앱을 종료하고 있습니다.");
    if (channel === "home:get-mcp-status") return this.status();
    if (channel === "home:get-mcp-logs") return this.logger.recent();
    if (channel === "home:clear-mcp-logs") { this.logger.clear(); return; }
    if (channel === "home:open-mcp-log-file") { this.logger.ensureFile(); return { path: this.logPath }; }
    if (channel !== "home:set-mcp-settings") throw new HttpError(400, "mcp_channel", "지원하지 않는 MCP 설정입니다.");
    const operation = this.changing.then(async () => {
      const previous = this.settings, next = this.normalize(args[0]);
      if (this.closed) throw new Error("앱을 종료하고 있습니다.");
      const restart = next.port !== previous.port || next.background !== previous.background;
      try {
        if (!next.enabled || restart) { await this.server?.stop(); this.server = null; }
        this.settings = next;
        if (next.enabled && !this.server?.isRunning()) await this.launch();
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const temp = `${this.settingsPath}.${randomUUID()}.tmp`;
        try { writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 }); renameSync(temp, this.settingsPath); }
        finally { rmSync(temp, { force: true }); }
        this.startError = undefined; return this.status();
      } catch (error) {
        await this.server?.stop(); this.server = null; this.settings = previous;
        if (previous.enabled) await this.launch().catch(() => {});
        throw error;
      }
    });
    this.changing = operation.catch(() => {}); return operation;
  }
  id(view) {
    for (const [id, viewId] of this.ids) if (viewId === view.viewId) return id;
    const id = this.nextId++; this.ids.set(id, view.viewId); return id;
  }
  view(id) {
    const viewId = typeof id === "number" ? this.ids.get(id) : id;
    const view = this.manager.documents.registry.list().find(view => view.viewId === viewId);
    if (!view) throw new Error("문서 탭을 닫았거나 다시 열었습니다. open_documents로 현재 탭을 확인해 주세요.");
    return view;
  }
  async command(id, request) {
    // Re-read the actual owner for every request. Timeout is indeterminate, never
    // a 'not_ready' retry of a command that may already have edited the document.
    const deadline = Date.now() + 24_000;
    for (;;) {
      if (this.closed) throw new Error("앱을 종료하고 있습니다.");
      const view = this.view(id);
      if (view.mode !== "write") throw new Error("읽기 전용 탭입니다. 편집 권한이 있는 문서 탭을 사용해 주세요.");
      const reply = await this.control.send({ kind: "mcp", viewId: view.viewId, windowId: view.windowId, request }, 125_000);
      if (reply.status === "ok") return reply.result.value;
      if (reply.status === "error") throw new Error(reply.error.message);
      if (Date.now() >= deadline) throw new Error("편집기가 아직 준비되지 않았습니다.");
      await pause(100);
    }
  }
  async show(artifact) {
    const reply = await this.control.send({ kind: "open", artifact, windowId: this.control.view(artifact.id)?.windowId ?? null }, 20_000);
    if (reply.status !== "ok") throw new Error("문서 탭을 열지 못했습니다.");
    const deadline = Date.now() + 20_000;
    while (!this.closed && Date.now() < deadline) {
      const view = this.control.view(artifact.id);
      if (view?.mode === "write") return this.id(view);
      await pause(50);
    }
    throw new Error("문서 편집 권한을 받지 못했습니다.");
  }
  async blank(family) {
    const directory = join(this.defaultSaveDir(), "MCP 문서"); mkdirSync(directory, { recursive: true });
    let work = this.manager.snapshot().works.find(work => !work.archivedAt && resolve(work.cwd) === resolve(directory));
    work ??= this.manager.createWork({ title: "MCP 문서", cwd: directory });
    return this.show(await this.manager.createOfficeDocument(work.id, { format: family }));
  }
  async list() {
    const rows = [], seen = new Set();
    for (const current of this.manager.documents.registry.list()) {
      const view = this.control.view(current.artifactId);
      if (!view || seen.has(view.viewId)) continue;
      seen.add(view.viewId);
      const artifact = this.manager.documents.get(view.artifactId), kind = kinds[artifact.format];
      if (kind) rows.push({ id: view.viewId, title: artifact.name, kind, filePath: artifact.path, dirty: view.dirty, active: false });
    }
    return Promise.all(rows.map(async row => {
      if (row.kind === "pdf") return row;
      const view = this.view(row.id);
      const reply = await this.control.send({ kind: "mcp", viewId: view.viewId, windowId: view.windowId, request: { kind: "status" } }, 2000);
      const value = reply.status === "ok" ? reply.result.value : null;
      return { ...row, ...(typeof value?.dirty === "boolean" ? { dirty: value.dirty } : {}), active: value?.active === true };
    }));
  }
  async save(id, path, overwrite) {
    const view = this.view(id), artifact = this.manager.documents.get(view.artifactId);
    let plan;
    if (resolve(path) === resolve(artifact.path) && !overwrite && existsSync(path)) throw new Error(`file already exists: ${path} (pass overwrite:true to replace it)`);
    if (resolve(path) !== resolve(artifact.path)) {
      const prepared = this.outputs.prepare(artifact.id, view.revision, path, { viewId: view.viewId, writeToken: null });
      if (prepared.exists && !overwrite) { this.outputs.cancel(artifact.id, prepared.id, { viewId: view.viewId, writeToken: null }); throw new Error(`file already exists: ${path} (pass overwrite:true to replace it)`); }
      plan = { id: prepared.id, path: prepared.path, format: prepared.format, replace: overwrite };
    }
    try { return await this.command(id, { kind: "save", ...(plan ? { plan } : {}) }); }
    finally { if (plan) this.outputs.cancel(artifact.id, plan.id, { viewId: view.viewId, writeToken: null }); }
  }
  tools() {
    const host = createSessionHost();
    const run = (family, id, command, payload) => command === "save_document" || command === "save_sheet" ? this.save(id, payload.path, payload.overwrite === true) : this.command(id, { kind: "command", family, command, payload });
    const docs = { openBlankTab: () => this.blank("docx"), runCommand: (id, command, payload) => run("docx", id, command, payload) };
    const sheets = { openBlankTab: () => this.blank("xlsx"), runCommand: (id, command, payload) => run("xlsx", id, command, payload) };
    const slides = { openBlankTab: () => this.blank("pptx"), runTxn: (id, payload) => run("pptx", id, "apply_slide_ops", payload), readDeck: (id, payload) => run("pptx", id, "read_deck", payload), deckWithholds: id => run("pptx", id, "deck_withholds"), saveDeck: (id, path, overwrite) => this.save(id, path, overwrite) };
    const resolveTarget = async (target, family, options) => {
      const tab = resolveOpenDocumentOfFamily(await this.list(), target, family);
      const view = this.view(tab.id);
      if (options?.focus) await this.show(this.manager.documents.get(view.artifactId));
      return this.id(view);
    };
    const common = { defaultSaveDir: this.defaultSaveDir, background: this.settings.background, cli: this.cli, resolveTarget };
    return [
      ...createSessionTools([documentDriver(docs), slidesDriver(slides), sheetsDriver(sheets)], host),
      ...createDocumentTools({ ...common, version: this.version, docs, extraFormats: ["pptx", "xlsx"], openInTab: path => this.show(this.control.open(path)) }, host),
      ...createSlidesTools({ ...common, slides }, host), ...createSheetsTools({ ...common, sheets }, host),
      ...createPdfTools(), ...createHwpTools(),
      ...createOpenDocumentTools({ defaultSaveDir: this.defaultSaveDir, control: {
        list: () => this.list(), read: tab => this.command(tab.id, { kind: "read" }),
        save: async tab => { if (tab.kind === "hwp") throw new Error("한글 파일은 원본 MCP에서 저장을 지원하지 않습니다. 편집기에서 저장해 주세요."); await this.save(tab.id, tab.filePath, true); return { savedPath: tab.filePath }; },
        close: async (tab, options) => {
          if (tab.kind === "pdf" || tab.kind === "hwp" && tab.dirty && options.unsaved !== "discard") throw new Error("이 문서는 원본 MCP에서 저장 후 닫기를 지원하지 않습니다.");
          await this.command(tab.id, { kind: "close", discard: options.unsaved === "discard" });
          return options.unsaved === "discard" ? {} : { savedPath: tab.filePath };
        },
      } }),
    ];
  }
  async close() { this.closed = true; await this.changing; await this.server?.stop(); this.server = null; this.ids.clear(); }
}
