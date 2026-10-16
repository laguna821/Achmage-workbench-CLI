import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { ClaudeAdapter } from "./providers/claude.ts";
import { CodexAdapter } from "./providers/codex.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// Local gateway: owns engine processes and state, serves the UI and an HTTP + SSE API on
// 127.0.0.1 only. Prints one `WORKBENCH_READY {json}` line once it accepts connections.

const env = process.env;
const dataDir = env.WORKBENCH_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const token = env.WORKBENCH_TOKEN ?? randomBytes(24).toString("base64url");
const port = Number(env.WORKBENCH_PORT ?? 0);
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
});

const claudeIdleMs = env.WORKBENCH_CLAUDE_IDLE_MS ? Number(env.WORKBENCH_CLAUDE_IDLE_MS) : undefined;
manager.registerAdapter(
  new ClaudeAdapter(manager.sink, { idleMs: claudeIdleMs, modelCacheFile: join(dataDir, "claude-models.json") }),
);
manager.registerAdapter(
  new CodexAdapter(manager.sink, {
    approvalPolicy: env.WORKBENCH_CODEX_APPROVAL ?? "on-request",
    sandbox: env.WORKBENCH_CODEX_SANDBOX ?? "workspace-write",
    idleMs: env.WORKBENCH_CODEX_IDLE_MS ? Number(env.WORKBENCH_CODEX_IDLE_MS) : undefined,
  }),
);

const server = createHttpServer(manager, bus, {
  token,
  webDir: webDir && existsSync(webDir) ? webDir : null,
  // UI errors stay on this machine, next to the state database.
  onClientLog: (message) => appendFileSync(join(dataDir, "client.log"), `${new Date().toISOString()} ${message}\n`),
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(
    `WORKBENCH_READY ${JSON.stringify({ url: `http://127.0.0.1:${boundPort}`, port: boundPort, token, dataDir })}\n`,
  );
  void manager.initProviders();
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
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
