import { UpdatePolicy } from "./update-policy.ts";
import { ServicePreviews } from "./service-previews.ts";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { ClaudeAdapter } from "./providers/claude.ts";
import { CodexAdapter } from "./providers/codex.ts";
import { SessionManager } from "./sessions.ts";
import { attachmentsDir } from "./attachments.ts";
import { Store } from "./store.ts";
import { Kordoc } from "./kordoc.ts";
import { IeumOffice, findIeum } from "./ieumoffice.ts";
import { OfficeCliInput } from "./office-cli-input.ts";
import { OfficeControl } from "./office-control.mjs";
import { OfficeMcp } from "./office-mcp.mjs";
import { OfficeDrive } from "./office-drive.mjs";
import { OfficeImport } from "./office-import.mjs";
import { installToolWrappers } from "./tool-bin.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { OfficeRendererExecutors } from "./office-executors/renderer.ts";
import { OfficeExecutorOutputs } from "./office-executors/output.ts";
import { OfficeOutputs } from "./office-output.ts";
import { createOfficeSettingsServer } from "./office-settings-server.ts";
import { OfficeAi } from "./office-ai.ts";
import { OfficeKnowledge } from "./office-knowledge.mjs";
import { OfficeSkills } from "./office-skills.ts";
import { AgentBrowser } from "./browse.ts";
import { buildTimeline } from "./timeline.ts";
import { DocImages } from "./doc-images.ts";
import { CalendarFeeds } from "./calendar-feeds.ts";
import { Pkm } from "./pkm.ts";
import { handlePkm } from "./pkm-http.ts";
import { Projects } from "./project.ts";
import { handleProject } from "./project-http.ts";
import { handleEntry, WorksDir } from "./entry.ts";
import { DropboxFolders } from "./dropbox.ts";
import { pdfLoader } from "./pdf-loader.ts";
import { FindTool, withFindTool } from "./find-tool.ts";
import { findToolInstructions } from "./search.ts";
import { adoptLoginShellPath } from "./shell-env.ts";
import { claimInstance } from "./daemon/instance.ts";
import { DeviceService } from "./devices/service.ts";
import { HostAutostart } from "./daemon/autostart.ts";
import { VoiceService } from "./voice.ts";
import { ExtensionService } from "./extensions/service.ts";
import { EventHub } from "./event-hub.ts";
import { gatewayChannels } from "./channels/gateway.ts";
import { OfficeVault } from "./office-vault.ts";
import { CredentialService } from "./credentials/service.ts";
import { CredentialTool } from "./credentials/tool.ts";
import { LoginFiller } from "./credentials/fill.ts";
import { installScrubber } from "./credentials/install.ts";
import { DesktopService } from "./desktop-adapter.ts";
import { DesktopTool } from "./desktop-tool.ts";
import { BrowserOutputs } from "./browser-outputs.ts";
import { guardDecision } from "./pkm-guard.ts";
import { HttpError } from "./errors.ts";
import { systemNotifier } from "./system-notifications.ts";
import { PushDevices } from "./push/devices.ts";

// Local gateway: owns engine processes and state, serves the UI and an HTTP + SSE API on
// 127.0.0.1 only. Prints one `WORKBENCH_READY {json}` line once it accepts connections.

const env = process.env;
const dataDir = env.WORKBENCH_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const lease = claimInstance(dataDir, env.WORKBENCH_HOST_ID ?? hostname(), env.WORKBENCH_HOST_MODE === "service" ? "service" : "shell");
process.on("exit", () => lease.release());
function localToken() {
  const file = join(dataDir, "host-auth");
  try { const saved = readFileSync(file, "utf8").trim(); if (/^[a-zA-Z0-9_-]{32,}$/.test(saved)) return saved; } catch { /* First service start. */ }
  const value = randomBytes(32).toString("base64url");
  writeFileSync(file, value, { mode: 0o600 }); return value;
}
const token = env.WORKBENCH_TOKEN ?? (lease.instance.mode === "service" ? localToken() : randomBytes(24).toString("base64url"));
// The window's storage (drafts, screen choices) belongs to the page origin, so the gateway keeps
// the same port across launches: reuse the last one, and only fall back to a new one if it is taken.
const portFile = join(dataDir, "port");
// The office editors run on a second port (editors.ts), kept the same way: their unsaved-edit copies live in its storage.
const editorsPortFile = join(dataDir, "editors-port");
function preferredPort(fixed: string | undefined, file: string) {
  if (fixed) return Number(fixed);
  try {
    const saved = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(saved) && saved > 1024 && saved < 65536 ? saved : 0;
  } catch {
    return 0;
  }
}
const webDir = env.WORKBENCH_WEB_DIR ? resolve(env.WORKBENCH_WEB_DIR) : null;
const hostLabel = env.WORKBENCH_HOST_LABEL ?? "이 PC";

// Apps opened from the desktop get a short PATH: the login shell's folders are added before the
// engines are looked for (macOS, Linux).
const shellPath = adoptLoginShellPath();
const store = new Store(join(dataDir, "state.sqlite"));
// One vault for the services that can take it, so the master key is opened (or made) once.
// (Office AI's engine, the Hub relationship and push devices still make their own.)
const vault = new OfficeVault(dataDir);
// The document tools shipped with the app (or the user's own), and the names engines run them by.
const kordoc = new Kordoc();
const ieum = new IeumOffice(findIeum(), { dataDir });
const wrapped = installToolWrappers(dataDir, { kordoc: kordoc.runner, ieum: ieum.install, ieumAppWrapper: ieum.appWrapper });
if (wrapped.includes("kordoc")) kordoc.engineCommand = "kordoc";
if (wrapped.includes("ieumoffice")) ieum.engineCommand = "ieumoffice";
const bus = new EventBus(5000, lease.instance.instanceId);
// "새 프로젝트 폴더 위치": works started without a folder get theirs under the folder the user chose.
const worksDir: WorksDir = new WorksDir(store, join(dataDir, "works"), (): string | null => pkm.vault.root);
// Lightpanda background sessions by default; Chromium remains an explicit compatibility mode.
const browse = new AgentBrowser({
  dataDir,
  headless: env.WORKBENCH_BROWSER_HEADLESS === "1",
  cli: env.WORKBENCH_BROWSER_CLI ? resolve(env.WORKBENCH_BROWSER_CLI) : null,
  chrome: env.WORKBENCH_BROWSER_CHROME ? resolve(env.WORKBENCH_BROWSER_CHROME) : null,
});
const desktopNotifications = env.WORKBENCH_CLI_INPUT ? null : systemNotifier(env.WORKBENCH_APP_BIN ?? env.WORKBENCH_PTY_BIN ?? null);
const manager = new SessionManager(store, bus, {
  browse,
  hostId: env.WORKBENCH_HOST_ID ?? hostname(),
  hostLabel,
  managedWorksDir: join(dataDir, "works"),
  worksDir: (): string => worksDir.root(),
  dataDir,
  kordoc,
  ieum,
  // Headless export owns a disposable gateway and must not create desktop alerts.
  ...(desktopNotifications ? { deliverNotification: desktopNotifications } : {}),
});
void manager.refreshTools();
// "비밀 보관함": what only the person has, used without the AI seeing it; the scrubber keeps stored values out of every transcript.
const credentials = new CredentialService({ dataDir, vault, manager, log: (code) => console.error(`Credential store: ${code}`) });
installScrubber(store, manager, credentials.scrubber);
// Unit 9: a page shows a typed password in its snapshot; nothing the browser answers an engine carries a stored value.
browse.scrubOutput = (text) => credentials.scrubber.text(text);
browse.storedExact = (text) => credentials.scrubber.exact(text);
browse.storedNeedles = () => credentials.scrubber.needles();
// Unit 9: `workbench-credential fill / step`: the gateway types a stored login into the agent browser itself.
const logins = new LoginFiller({ service: credentials, dataDir, page: (sessionId) => browse.hostPage(sessionId) });
const loginInstructions = logins.install();
// The scrubber learns what is stored before any engine starts (R5); the gateway listens meanwhile, so
// the window does not wait on the keyring. A locked keyring is tried again only when something needs it.
manager.engineGate = credentials.warmUp();
const pkm = new Pkm(store, bus, manager, { dataDir });
// A work as a project note (project.ts): its note file, what its sessions did, what they were told.
const projects = new Projects(store, bus, manager, pkm);
bus.subscribe((event) => {
  if (event.type !== "work.upserted") return;
  const before = archived.get(event.work.id);
  const now = Boolean(event.work.archivedAt);
  archived.set(event.work.id, now);
  if (before !== undefined && before !== now) projects.workArchived(event.work, now);
});
const archived = new Map(manager.snapshot().works.map((work) => [work.id, Boolean(work.archivedAt)] as const));

// "찾는 길": vault notes join the search index (and follow the mirror); engines search it with workbench-find.
void manager.finder.useVault(pkm.vault, bus);
const find = new FindTool({ dataDir, finder: manager.finder, sessions: () => manager.view.sessions, bus });
const desktop = new DesktopService(dataDir, store, { session: id => manager.view.sessions.get(id), item: (id, item) => manager.sink.upsertItem(id, item), image: (data, name, mime) => { const attachment = manager.attachments.save(data, name, mime); return { attachment, path: manager.attachments.path(attachment.id) }; } });
const desktopTool = new DesktopTool(dataDir, desktop, manager.view.sessions, bus);
const credentialTool = new CredentialTool({ dataDir, sessions: manager.view.sessions, bus, run: (sessionId, args) => credentials.run(sessionId, args), instructions: loginInstructions });
const engineHooks = credentialTool.hooks(desktopTool.hooks(withFindTool(browse.engineHooks(), find.engineHooks())));
pkm.findInstructions = findToolInstructions;

const claudeIdleMs = env.WORKBENCH_CLAUDE_IDLE_MS ? Number(env.WORKBENCH_CLAUDE_IDLE_MS) : undefined;
manager.registerAdapter(
  new ClaudeAdapter(manager.sink, { idleMs: claudeIdleMs, modelCacheFile: join(dataDir, "claude-models.json"), attachmentsDir: attachmentsDir(dataDir), browser: engineHooks, launch: pkm.claudeLaunch }),
);
manager.registerAdapter(
  new CodexAdapter(manager.sink, {
    // Normally each session's access decides; these fix it for every session (tests).
    approvalPolicy: env.WORKBENCH_CODEX_APPROVAL,
    sandbox: env.WORKBENCH_CODEX_SANDBOX,
    idleMs: env.WORKBENCH_CODEX_IDLE_MS ? Number(env.WORKBENCH_CODEX_IDLE_MS) : undefined,
    browser: engineHooks,
    launch: pkm.codexLaunch,
  }),
);

const grants = new EditorGrants();
const officeSkills = new OfficeSkills(manager, store);
const officeKnowledge = new OfficeKnowledge(dataDir, manager);
const officeAi = new OfficeAi(dataDir, undefined, manager.office, {
  install: (provider) => manager.installEngineAndWait(provider === "claude-code" ? "claude" : "codex"),
}, officeSkills, officeKnowledge);
const editors = createEditorsServer(manager.documents, grants, webDir && existsSync(webDir) ? webDir : null, officeAi);
const officeExecutors = new OfficeRendererExecutors(manager.documents, manager.office, grants, { binary: env.WORKBENCH_APP_BIN, webDir });
officeAi.executors = officeExecutors;
let editorsOrigin: string | null = null;
let officeSettingsOrigin: string | null = null, applicationOrigin: string | null = null;
const officeSettingsServer = createOfficeSettingsServer(webDir && existsSync(webDir) ? webDir : null, () => applicationOrigin);
// Images pasted into Markdown documents: the user's R2 bucket, or the work folder (doc-images.ts).
const docImages = new DocImages({ dataDir, documents: manager.documents, workCwd: (workId) => manager.workCwd(workId), endpoint: env.WORKBENCH_R2_ENDPOINT ?? null });
const officeControl = env.WORKBENCH_CLI_INPUT ? undefined : new OfficeControl(manager, bus, dataDir);
const officeMcp = officeControl ? new OfficeMcp(manager, officeControl, dataDir, { defaultSaveDir: () => worksDir.root(), ieum }) : undefined;
officeAi.executorOutputs = new OfficeExecutorOutputs(manager.documents, manager.office, officeMcp?.outputs ?? new OfficeOutputs(manager.documents, (...args) => manager.registerOfficeCopy(...args)));
const officeDrive = officeControl ? new OfficeDrive(manager, officeControl, dataDir, { vault }) : undefined;
const officeImport = officeControl ? new OfficeImport(manager.documents, manager.ieumDesktop, dataDir, { vault }) : undefined;
const dropbox = new DropboxFolders(store, manager, dataDir);
officeAi.drive = officeDrive;
const voice = new VoiceService({ dataDir, sessionExists: id => { const s = manager.view.sessions.get(id); return !!s && !s.archivedAt; } });
const extensions = new ExtensionService({ dataDir, manager, authorizeWrite: (workspace, path) => {
  const reason = guardDecision("Write", { file_path: path }, workspace.cwd, pkm.protectedRoots());
  if (reason) throw new HttpError(403, "extension_protected_file", reason);
} });
const hub: EventHub = new EventHub({ dataDir, store, manager, bus, ingress: () => devices?.hubIngressState() ?? { enabled: false, url: null } });
// "휴대폰 메신저": in the window's gateway and in the background service alike (channels/gateway.ts).
const channels = gatewayChannels(env, { dataDir, store, manager, bus, vault, projects, credentials, logins });
const servicePreviews = new ServicePreviews({ store, services: manager.services, localOrigin: () => applicationOrigin, remote: () => devices?.previewEndpointState() ?? { enabled: false, appOrigin: null } });
const devices: DeviceService | undefined = env.WORKBENCH_CLI_INPUT ? undefined : new DeviceService({ dataDir, manager, bus, localOrigin: () => applicationOrigin, localToken: token, webDir,
  voice, servicePreviews, push: () => push, eventIngress: (req, res) => hub.handleIngress(req, res) });
const push: PushDevices | undefined = devices ? new PushDevices({ dataDir, registry: devices.registry, notifications: manager.notifications, hostId: manager.snapshot().hostId }) : undefined;
const browserOutputs = new BrowserOutputs({ store, browser: manager.sharedBrowser, workspaces: manager.workspaces, documents: manager.documents, attachments: manager.attachments, hostId: env.WORKBENCH_HOST_ID ?? hostname(), session: id => manager.view.sessions.get(id) });
const autostart = new HostAutostart(dataDir);
const updatePolicy = new UpdatePolicy(manager, store, () => manager.schedules.start(Number(env.WORKBENCH_SCHEDULE_TICK_MS) || 30_000));
// "Stop all work" (SIGTERM, /api/host/stop): the channel closes before turns are interrupted.
updatePolicy.beforeInterrupt = async () => { await channels?.close(); };
const server = createHttpServer(manager, bus, {
  updatePolicy,
  devices, voice, extensions, hub, channels, desktop, browserOutputs, push, servicePreviews,
  autostart,
  host: { instance: lease.instance, stopping: () => stopping, stop: () => { void stop(); } },
  officeImport,
  dropbox,
  officeDrive,
  officeKnowledge,
  officeControl,
  officeMcp,
  ...(env.WORKBENCH_CLI_INPUT ? { officeCliInput: new OfficeCliInput(env.WORKBENCH_CLI_INPUT, dataDir, ieum).prepare } : {}),
  token,
  officeAi,
  officeSkills,
  officeSettingsOrigin: () => officeSettingsOrigin,
  webDir: webDir && existsSync(webDir) ? webDir : null,
  // UI errors stay on this machine, next to the state database.
  onClientLog: (message) => appendFileSync(join(dataDir, "client.log"), `${new Date().toISOString()} ${message}\n`),
  editors: { grants, origin: () => editorsOrigin },
  browse,
  timeline: (since, until) => buildTimeline(store.turnMarks(since, until), store.revisionMarks(since, until), since, until),
  docImages,
  // Calendars subscribed by their iCal address; the address stays in the data folder (0600).
  calendar: new CalendarFeeds({ dataDir }),
  pkm: (req, res, url) => handlePkm(pkm, req, res, url),
  projects: (req, res, url) => handleProject(projects, req, res, url),
  entry: (req, res, url) => handleEntry({ view: () => manager.view, worksDir }, req, res, url),
});

/** Listen on the port used last time, or on any free one when it is taken; remember the one bound. */
function listen(target: typeof server, fixed: string | undefined, file: string, onBound: (port: number) => void) {
  const port = preferredPort(fixed, file);
  target.once("listening", () => {
    const address = target.address();
    const bound = typeof address === "object" && address ? address.port : 0;
    if (!fixed) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, String(bound));
    }
    onBound(bound);
  });
  target.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || fixed || port === 0) throw error;
    target.listen(0, "127.0.0.1");
  });
  target.listen(port, "127.0.0.1");
}

// The editors first, so a document opened right away finds them.
await officeControl?.start();
await officeMcp?.start();
await officeDrive?.start();
dropbox.start();
await devices?.start();
await extensions.start();
hub.start();
listen(editors, env.WORKBENCH_EDITORS_PORT, editorsPortFile, (editorsPort) => {
  editorsOrigin = `http://127.0.0.1:${editorsPort}`;
  officeExecutors.bind(editorsOrigin);
  officeSettingsServer.listen(0, "127.0.0.1", () => {
    const address = officeSettingsServer.address();
    if (!address || typeof address === "string") throw new Error("Office settings server has no address");
    officeSettingsOrigin = `http://127.0.0.1:${address.port}`;
    listen(server, env.WORKBENCH_PORT, portFile, (boundPort) => {
      applicationOrigin = `http://127.0.0.1:${boundPort}`;
      const connection = { url: applicationOrigin, port: boundPort, token, dataDir, editorsUrl: editorsOrigin };
      lease.ready(connection);
      if (lease.instance.mode === "service") void autostart.refreshEnabled().catch(() => {});
      if (lease.instance.mode === "shell") process.stdout.write(`WORKBENCH_READY ${JSON.stringify({ ...connection, instance: lease.instance })}\n`);
      const providers = shellPath.then(() => manager.engineGate).then(() => manager.initProviders());
      // After the engines are known, so the first conversation a phone makes gets the installed one.
      void providers.catch(() => undefined).then(() => stopping ? undefined : channels?.start())
        .catch((error: unknown) => { console.error("Messenger channel could not start:", error instanceof Error ? error.message : String(error)); })
        // After the channel: a hand-over that became ready before a stop goes on through its chat.
        .then(() => stopping ? undefined : credentials.start()).catch(() => undefined);
      // Desktop installation includes a standalone IeumOffice app and its OS registration.
      // Keep the UI responsive while the official installer runs; failures stay visible there.
      if (env.WORKBENCH_IEUM_BOOTSTRAP === "1") void manager.ieumDesktop.bootstrap().catch(() => {});
      // "예약 작업": sends what is due every half minute (checks use a shorter tick).
      manager.schedules.start(Number(env.WORKBENCH_SCHEDULE_TICK_MS) || 30_000);
    });
  });
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (updatePolicy.status().state !== "stopping") await updatePolicy.stop("interrupt");
  dropbox.close();
  servicePreviews.close();
  push?.close();
  devices?.close();
  await hub.close();
  // Not waiting for the channel's start (engines, answers owed from before): close cancels it.
  await channels?.close();
  voice.close();
  await extensions.close();
  await pdfLoader(dataDir).close();
  officeImport?.close();
  officeDrive?.close();
  officeControl?.close();
  await officeMcp?.close();
  server.close();
  officeExecutors.close();
  officeAi.close();
  officeKnowledge.close();
  editors.close();
  officeSettingsServer.close();
  desktopTool.close();
  credentialTool.close();
  credentials.close();
  desktop.close();
  find.close();
  pkm.close();
  await manager.shutdown().catch(() => undefined);
  desktopNotifications?.close();
  await officeAi.shutdownProviders();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// When the desktop shell dies, stdin closes; do not outlive it.
if (lease.instance.mode === "shell" && env.WORKBENCH_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.on("end", stop);
  process.stdin.resume();
}
