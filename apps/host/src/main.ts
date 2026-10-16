import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
const hostLabel = env.WORKBENCH_HOST_LABEL ?? "이 PC";

const store = new Store(join(dataDir, "state.sqlite"));
const bus = new EventBus();
const manager = new SessionManager(store, bus, {
  hostId: env.WORKBENCH_HOST_ID ?? hostname(),
  hostLabel,
  managedWorksDir: join(dataDir, "works"),
});

const claudeIdleMs = env.WORKBENCH_CLAUDE_IDLE_MS ? Number(env.WORKBENCH_CLAUDE_IDLE_MS) : undefined;
manager.registerAdapter(new ClaudeAdapter(manager.sink, { idleMs: claudeIdleMs }));
manager.registerAdapter(
  new CodexAdapter(manager.sink, {
    approvalPolicy: env.WORKBENCH_CODEX_APPROVAL ?? "on-request",
    sandbox: env.WORKBENCH_CODEX_SANDBOX ?? "workspace-write",
  }),
);

const server = createHttpServer(manager, bus, {
  token,
  webDir: webDir && existsSync(webDir) ? webDir : null,
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
