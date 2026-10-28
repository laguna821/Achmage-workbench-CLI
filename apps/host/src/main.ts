import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { ClaudeAdapter } from "./providers/claude.ts";
import { CodexAdapter } from "./providers/codex.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { Kordoc } from "./kordoc.ts";
import { IeumOffice } from "./ieumoffice.ts";
import { createEditorsServer, EditorGrants } from "./editors.ts";
import { DocImages } from "./doc-images.ts";

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

const store = new Store(join(dataDir, "state.sqlite"));
const bus = new EventBus();
const manager = new SessionManager(store, bus, {
  hostId: env.WORKBENCH_HOST_ID ?? hostname(),
  hostLabel,
  managedWorksDir: join(dataDir, "works"),
  dataDir,
  kordoc: new Kordoc(),
  ieum: new IeumOffice(),
});
void manager.refreshTools();

const claudeIdleMs = env.WORKBENCH_CLAUDE_IDLE_MS ? Number(env.WORKBENCH_CLAUDE_IDLE_MS) : undefined;
manager.registerAdapter(
  new ClaudeAdapter(manager.sink, { idleMs: claudeIdleMs, modelCacheFile: join(dataDir, "claude-models.json") }),
);
manager.registerAdapter(
  new CodexAdapter(manager.sink, {
    // Normally each session's access decides; these fix it for every session (tests).
    approvalPolicy: env.WORKBENCH_CODEX_APPROVAL,
    sandbox: env.WORKBENCH_CODEX_SANDBOX,
    idleMs: env.WORKBENCH_CODEX_IDLE_MS ? Number(env.WORKBENCH_CODEX_IDLE_MS) : undefined,
  }),
);

const grants = new EditorGrants();
const editors = createEditorsServer(manager.documents, grants, webDir && existsSync(webDir) ? webDir : null);
let editorsOrigin: string | null = null;
// Images pasted into Markdown documents: the user's R2 bucket, or the work folder (doc-images.ts).
const docImages = new DocImages({ dataDir, documents: manager.documents, workCwd: (workId) => manager.workCwd(workId), endpoint: env.WORKBENCH_R2_ENDPOINT ?? null });
const server = createHttpServer(manager, bus, {
  token,
  webDir: webDir && existsSync(webDir) ? webDir : null,
  // UI errors stay on this machine, next to the state database.
  onClientLog: (message) => appendFileSync(join(dataDir, "client.log"), `${new Date().toISOString()} ${message}\n`),
  editors: { grants, origin: () => editorsOrigin },
  docImages,
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
listen(editors, env.WORKBENCH_EDITORS_PORT, editorsPortFile, (editorsPort) => {
  editorsOrigin = `http://127.0.0.1:${editorsPort}`;
  listen(server, env.WORKBENCH_PORT, portFile, (boundPort) => {
    process.stdout.write(
      `WORKBENCH_READY ${JSON.stringify({ url: `http://127.0.0.1:${boundPort}`, port: boundPort, token, dataDir, editorsUrl: editorsOrigin })}\n`,
    );
    void manager.initProviders();
  });
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  editors.close();
  await manager.shutdown().catch(() => undefined);
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
