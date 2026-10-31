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
import { installToolWrappers } from "./tool-bin.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { createOfficeSettingsServer } from "./office-settings-server.ts";
import { OfficeAi } from "./office-ai.ts";
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
import { FindTool, withFindTool } from "./find-tool.ts";
import { findToolInstructions } from "./search.ts";
import { adoptLoginShellPath } from "./shell-env.ts";

// Local gateway: owns engine processes and state, serves the UI and an HTTP + SSE API on
// 127.0.0.1 only. Prints one `WORKBENCH_READY {json}` line once it accepts connections.

const env = process.env;
const dataDir = env.WORKBENCH_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const token = env.WORKBENCH_TOKEN ?? randomBytes(24).toString("base64url");
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
/** Short place name for the status line: from Achmage's device id when available. */
function defaultHostLabel() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".local/state/achmage/config.json"), "utf8")) as { deviceId?: string };
    const device = config.deviceId ?? "";
    if (/laptop|notebook/i.test(device)) return "노트북";
    if (/lab/i.test(device)) return "연구실";
  } catch {
    // No Achmage config on this machine.
  }
  return "이 PC";
}
const hostLabel = env.WORKBENCH_HOST_LABEL ?? defaultHostLabel();

// Apps opened from the desktop get a short PATH: the login shell's folders are added before the
// engines are looked for (macOS, Linux).
const shellPath = adoptLoginShellPath();
const store = new Store(join(dataDir, "state.sqlite"));
// The document tools shipped with the app (or the user's own), and the names engines run them by.
const kordoc = new Kordoc();
const ieum = new IeumOffice(findIeum(), { dataDir });
const wrapped = installToolWrappers(dataDir, { kordoc: kordoc.runner, ieum: ieum.install, ieumAppWrapper: ieum.appWrapper });
if (wrapped.includes("kordoc")) kordoc.engineCommand = "kordoc";
if (wrapped.includes("ieumoffice")) ieum.engineCommand = "ieumoffice";
const bus = new EventBus();
// "새 프로젝트 폴더 위치": works started without a folder get theirs under the folder the user chose.
const worksDir: WorksDir = new WorksDir(store, join(dataDir, "works"), (): string | null => pkm.vault.root);
// Lightpanda background sessions by default; Chromium remains an explicit compatibility mode.
const browse = new AgentBrowser({
  dataDir,
  headless: env.WORKBENCH_BROWSER_HEADLESS === "1",
  cli: env.WORKBENCH_BROWSER_CLI ? resolve(env.WORKBENCH_BROWSER_CLI) : null,
  chrome: env.WORKBENCH_BROWSER_CHROME ? resolve(env.WORKBENCH_BROWSER_CHROME) : null,
});
const manager = new SessionManager(store, bus, {
  browse,
  hostId: env.WORKBENCH_HOST_ID ?? hostname(),
  hostLabel,
  managedWorksDir: join(dataDir, "works"),
  worksDir: (): string => worksDir.root(),
  dataDir,
  kordoc,
  ieum,
});
void manager.refreshTools();
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
const engineHooks = withFindTool(browse.engineHooks(), find.engineHooks());
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
const officeAi = new OfficeAi(dataDir, undefined, manager.office, {
  install: (provider) => manager.installEngineAndWait(provider === "claude-code" ? "claude" : "codex"),
}, officeSkills);
const editors = createEditorsServer(manager.documents, grants, webDir && existsSync(webDir) ? webDir : null, officeAi);
let editorsOrigin: string | null = null;
let officeSettingsOrigin: string | null = null, applicationOrigin: string | null = null;
const officeSettingsServer = createOfficeSettingsServer(webDir && existsSync(webDir) ? webDir : null, () => applicationOrigin);
// Images pasted into Markdown documents: the user's R2 bucket, or the work folder (doc-images.ts).
const docImages = new DocImages({ dataDir, documents: manager.documents, workCwd: (workId) => manager.workCwd(workId), endpoint: env.WORKBENCH_R2_ENDPOINT ?? null });
const officeControl = env.WORKBENCH_CLI_INPUT ? undefined : new OfficeControl(manager, bus, dataDir);
const server = createHttpServer(manager, bus, {
  officeControl,
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
listen(editors, env.WORKBENCH_EDITORS_PORT, editorsPortFile, (editorsPort) => {
  editorsOrigin = `http://127.0.0.1:${editorsPort}`;
  officeSettingsServer.listen(0, "127.0.0.1", () => {
    const address = officeSettingsServer.address();
    if (!address || typeof address === "string") throw new Error("Office settings server has no address");
    officeSettingsOrigin = `http://127.0.0.1:${address.port}`;
    listen(server, env.WORKBENCH_PORT, portFile, (boundPort) => {
      applicationOrigin = `http://127.0.0.1:${boundPort}`;
      process.stdout.write(
        `WORKBENCH_READY ${JSON.stringify({ url: applicationOrigin, port: boundPort, token, dataDir, editorsUrl: editorsOrigin })}\n`,
      );
      void shellPath.then(() => manager.initProviders());
      // "예약 작업": sends what is due every half minute (checks use a shorter tick).
      manager.schedules.start(Number(env.WORKBENCH_SCHEDULE_TICK_MS) || 30_000);
    });
  });
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  officeControl?.close();
  server.close();
  officeAi.close();
  editors.close();
  officeSettingsServer.close();
  find.close();
  pkm.close();
  await manager.shutdown().catch(() => undefined);
  await officeAi.shutdownProviders();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// When the desktop shell dies, stdin closes; do not outlive it.
if (env.WORKBENCH_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.on("end", stop);
  process.stdin.resume();
}
