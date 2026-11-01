import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DriveConnection, FOLDER_MIME, openPlan, isGoogleNative } from "../../../vendor/ieumoffice/packages/google-drive/src/index.ts";
import { DriveFiles } from "../../../vendor/ieumoffice/apps/shell/src/main/drive/drive-files.ts";
import { DriveAi, entryType } from "../../../vendor/ieumoffice/apps/shell/src/main/drive/drive-ai.ts";
import { downloadPicks } from "../../../vendor/ieumoffice/apps/shell/src/main/drive/drive-attach.ts";
import { copyFileName, driveText } from "../../../vendor/ieumoffice/apps/shell/src/main/drive/drive-strings.ts";
import { atomicWriteFile } from "../../../vendor/ieumoffice/apps/shell/src/main/atomic-write.ts";
import { OfficeVault } from "./office-vault.ts";
import { watchDriveCopies } from "./office-drive-watch.ts";
import { openUrl } from "./open-url.ts";
import { parseFileToText } from "./office-file-parse.mjs";
import { keepOfficeFile, officeFileBytes } from "./office-files.ts";
import { HttpError } from "./errors.ts";
import { OFFICE_DRIVE_SETTINGS_CHANNELS } from "../../../packages/contracts/src/office-drive.ts";

export function buildDriveClient() {
  const clientId = typeof __WORKBENCH_GOOGLE_CLIENT_ID__ === "string" ? __WORKBENCH_GOOGLE_CLIENT_ID__ : "";
  const clientSecret = typeof __WORKBENCH_GOOGLE_CLIENT_SECRET__ === "string" ? __WORKBENCH_GOOGLE_CLIENT_SECRET__ : "";
  return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) && clientSecret ? { clientId, clientSecret } : null;
}
const idOf = value => typeof value === "string" && /^[\w-]{1,200}$/.test(value);
const invalid = () => { throw new HttpError(400, "office_drive_request", "Drive 요청을 확인해 주세요."); };
const t = (key, params) => driveText("ko", key, params);
export function driveTokenVault(path, vault) {
  return {
    async load() { try { const raw = JSON.parse(await readFile(path, "utf8")); return raw.version === 1 && typeof raw.token === "string" ? await vault.open(raw.token) : null; } catch { return null; } },
    async save(token) { try { await atomicWriteFile(path, Buffer.from(JSON.stringify({ version: 1, token: await vault.seal(token) }))); return true; } catch { return false; } },
    async clear() { await unlink(path).catch(() => {}); },
  };
}

/** Original Drive engines; only OS storage, dialogs and document routing are adapted. */
export class OfficeDrive {
  constructor(manager, control, dataDir, injected = {}) {
    this.manager = manager; this.control = control; this.dataDir = dataDir;
    this.directory = join(dataDir, "office", "drive"); this.cacheDir = join(this.directory, "files");
    this.settingsPath = join(this.directory, "settings.json");
    this.closed = false; this.connecting = false; this.initializing = true; this.ready = null;
    this.prompts = new Map(); this.notices = new Map(); this.queue = Promise.resolve(); this.openResult = null;
    this.abort = new AbortController(); this.openBrowser = injected.openBrowser ?? openUrl;
    this.vault = injected.vault ?? new OfficeVault(dataDir);
    this.connection = new DriveConnection({ client: injected.client === undefined ? buildDriveClient() : injected.client,
      vault: driveTokenVault(join(this.directory, "google-drive.json"), this.vault),
      fetch: (url, init) => (injected.fetch ?? fetch)(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, this.abort.signal]) : this.abort.signal }),
    });
    this.files = new DriveFiles({ api: () => this.connection.api, connected: () => !this.closed && this.connection.connected(), cacheDir: this.cacheDir,
      // The source engine expects a synchronous callback. Serialize opens and await
      // its actual GUI reply before returning success to the person.
      openPath: path => {
        if (this.closed) return false;
        this.ensureWorkspace();
        this.openResult = this.control.handle({ cmd: "open", path }); return true;
      },
      isOpen: path => { const doc = this.control.locate(path); return Boolean(doc && (this.initializing || this.control.view(doc.id))); },
      ask: question => this.ask(question), notify: notice => this.notify(notice), copyName: name => copyFileName(name, t("copySuffix")),
      watch: watchDriveCopies,
      ...(injected.files ?? {}),
    });
    this.ai = new DriveAi({ api: () => this.connection.api, parse: injected.parse ?? parseFileToText });
    let connected = false;
    this.off = this.connection.onChange(() => {
      const next = this.connection.connected();
      if (next && !connected && !this.initializing && !this.closed) this.files.reconnected();
      if (!next) this.ai.clear();
      connected = next;
    });
  }
  start() {
    return this.ready ??= (async () => {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      await this.connection.load();
      if (this.connection.state().state !== "unavailable") await this.files.start();
      this.initializing = false;
    })();
  }
  aiAccess() { try { return JSON.parse(readFileSync(this.settingsPath, "utf8")).driveAiAccess !== false; } catch { return true; } }
  state() {
    const state = this.connection.state(), aiAccess = this.aiAccess();
    if (state.state === "unavailable") return state;
    if (this.connecting) return { state: "connecting", aiAccess };
    return state.state === "connected" ? { state: "connected", name: state.account?.displayName ?? "", email: state.account?.emailAddress ?? "", persisted: state.persisted, aiAccess }
      : { state: "disconnected", expired: state.expired === true, aiAccess };
  }
  enabled() { return !this.closed && this.connection.connected() && this.aiAccess(); }
  ensureWorkspace() {
    if (!this.manager) return;
    const snapshot = this.manager.snapshot();
    if (!snapshot.workspaces.some(space => space.cwd === this.cacheDir && !space.removedAt)) this.manager.createWork({ title: "Google Drive", cwd: this.cacheDir });
  }
  async list(listing, pageToken) {
    pageToken ??= undefined; // An optional IPC array argument crosses JSON as null.
    if (!listing || !["folder", "shared", "recent", "search"].includes(listing.kind)) return invalid();
    if (listing.kind === "folder" && !idOf(listing.folderId) || listing.kind === "search" && (typeof listing.text !== "string" || !listing.text.trim() || listing.text.length > 200) || pageToken !== undefined && (typeof pageToken !== "string" || pageToken.length > 2000)) return invalid();
    const result = await this.connection.api.list(listing, { pageToken });
    if (!result.ok) return result;
    return { ...result, files: result.files.map(file => {
      const target = file.shortcutTarget ? { name: file.name, mimeType: file.shortcutTarget.mimeType } : file;
      return { id: file.id, name: file.name, type: entryType(target), modifiedTime: file.modifiedTime, ...(file.size === undefined ? {} : { size: file.size }),
        openable: target.mimeType !== FOLDER_MIME && openPlan(target).kind !== "none", canEdit: file.canEdit, google: isGoogleNative(target.mimeType) && target.mimeType !== FOLDER_MIME };
    }) };
  }
  open(id) {
    if (!idOf(id)) return invalid();
    const next = this.queue.then(async () => {
      await this.start(); if (this.closed) throw new Error("Drive 연결을 닫았습니다.");
      this.openResult = null;
      // Workbench keeps a user's registered documents longer than the source
      // cache. A remote rename must not remove the old document from its history.
      const old = this.files.snapshot().find(entry => entry.sourceId === id);
      const previous = old && this.control.locate(old.localPath) && existsSync(old.localPath) ? readFileSync(old.localPath) : null;
      const result = await this.files.open(id, this.abort.signal);
      if (previous && !existsSync(old.localPath)) writeFileSync(old.localPath, previous, { flag: "wx" });
      const shown = this.openResult ? await this.openResult : null;
      return result.ok && !shown?.ok ? { ok: false, kind: "disk" } : result;
    });
    this.queue = next.catch(() => {}); return next;
  }
  async reopen(artifactId) {
    await this.start();
    const artifact = this.manager?.documents.get(artifactId);
    const entry = artifact && this.files.entryFor(artifact.path);
    if (!entry || !this.connection.connected()) return { handled: false };
    return { handled: true, ...await this.open(entry.sourceId) };
  }
  async attach(picks, register = (bytes, name) => keepOfficeFile(this.dataDir, bytes, name).meta.path) {
    if (!this.connection.connected()) return { ok: false, reason: "not-connected" };
    if (!Array.isArray(picks) || picks.length > 20 || !picks.every(pick => pick && idOf(pick.id) && typeof pick.folder === "boolean")) return invalid();
    const got = await downloadPicks(this.connection.api, picks, join(this.directory, "downloads"));
    const paths = [];
    for (const path of got.paths) {
      try { const { bytes, meta } = officeFileBytes(path); paths.push(register(bytes, meta.name)); }
      catch { got.failed++; }
    }
    return { ok: true, paths, skipped: got.skipped, failed: got.failed };
  }
  async tool(name, args) {
    if (!this.enabled()) return { ok: false, error: "Google Drive is not available now." };
    if (name === "drive-search" && typeof args[0] === "string" && args[0].trim() && args[0].length <= 200) return this.ai.search(args[0], Math.min(20, Math.max(1, Number(args[1]) || 8)));
    if (name === "drive-read" && idOf(args[0]) && (args[1] === undefined || Number.isSafeInteger(args[1]) && args[1] >= 0)) return this.ai.read(args[0], args[1] ?? 0);
    return invalid();
  }
  ask(question) {
    if (this.closed) return Promise.reject(new Error("Drive 연결을 닫았습니다."));
    return new Promise((resolve, reject) => {
      const id = randomUUID(), values = question.kind === "changed" ? ["overwrite", "copy", "local"] : ["copy", "local"];
      this.prompts.set(id, { resolve, reject, prompt: { id, message: t(question.kind === "changed" ? "askChanged" : question.kind === "read-only" ? "askReadOnly" : "askGone", { name: question.name }),
        detail: t("askDetail"), choices: values.map(value => ({ value, label: t(value === "overwrite" ? "btnOverwrite" : value === "copy" ? "btnCopy" : "btnLocal") })) } });
    });
  }
  notify(notice) {
    const id = randomUUID();
    this.notices.set(id, { id, message: notice.kind === "saved-office-copy" ? t("noticeOfficeCopy", notice) : notice.kind === "saved-copy" ? t("noticeCopy", notice) : t("noticeUploadFailed", notice) });
  }
  activity() { return { prompts: [...this.prompts.values()].map(item => item.prompt), notices: [...this.notices.values()] }; }
  answer(id, value) {
    const pending = this.prompts.get(id);
    if (pending) { if (!pending.prompt.choices.some(choice => choice.value === value)) return invalid(); this.prompts.delete(id); pending.resolve(value); }
    else this.notices.delete(id);
    return { ok: true };
  }
  async invoke(channel, args = [], signal) {
    if (!OFFICE_DRIVE_SETTINGS_CHANNELS.has(channel) || !Array.isArray(args) || args.length > 2 || this.closed) return invalid();
    await this.start();
    switch (channel) {
      case "drive:state": return this.state();
      case "drive:list": return this.list(args[0], args[1]);
      case "drive:open": return this.open(args[0]);
      case "drive:set-ai-access":
        if (typeof args[0] !== "boolean") return invalid();
        await atomicWriteFile(this.settingsPath, Buffer.from(JSON.stringify({ driveAiAccess: args[0] }))); return this.state();
      case "drive:cancel-connect": this.connection.cancelConnect(); return { ok: true };
      case "drive:disconnect": this.connection.cancelConnect(); await this.connection.disconnect(); return { ok: true };
      case "drive:connect": {
        if (this.connecting) return { ok: false, reason: "cancelled" };
        this.connecting = true;
        const abort = () => this.connection.cancelConnect(); signal?.addEventListener("abort", abort, { once: true });
        try {
          signal?.throwIfAborted();
          const result = await this.connection.connect({ openBrowser: url => {
            const parsed = new URL(url); return parsed.origin === "https://accounts.google.com" ? this.openBrowser(url) : Promise.resolve(false);
          }, pages: { done: { lang: "ko", title: t("pageDoneTitle"), body: t("pageDoneBody") }, failed: { lang: "ko", title: t("pageFailedTitle"), body: t("pageFailedBody") } } });
          return result.ok ? result : { ...result, reason: result.reason === "unavailable" ? "network" : result.reason };
        } finally { signal?.removeEventListener("abort", abort); this.connecting = false; }
      }
    }
  }
  close() {
    this.closed = true; this.connection.cancelConnect(); this.abort.abort(); this.files.stop(); this.off(); this.ai.clear(); this.vault.close?.();
    for (const pending of this.prompts.values()) pending.reject(new Error("앱을 닫았습니다. PC 사본은 보존했습니다."));
    this.prompts.clear();
  }
}
