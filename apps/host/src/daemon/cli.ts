import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachHost, startHost, stopOwnedHost } from "./lifecycle.ts";

const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const action = process.argv[2] ?? "status";
try {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const entry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../main.ts" : "./host.mjs", import.meta.url));
  const connection = action === "start" ? await startHost({ dataDir, entry }) : await attachHost(dataDir);
  if (action === "stop") {
    const receipt = connection ? await stopOwnedHost(connection) : { state: "stopped" };
    console.log(JSON.stringify(receipt));
    if (receipt.state !== "stopped") process.exitCode = 1;
  } else if (action === "start" || action === "attach" || action === "status") {
    if (process.argv.includes("--desktop")) {
      if (!connection) throw Error("연결할 호스트가 없습니다.");
      // This protocol is read from a private pipe by the shell, never from service.log.
      console.log(`WORKBENCH_READY ${JSON.stringify(connection)}`);
    } else console.log(JSON.stringify({ state: connection ? "running" : "stopped", instance: connection?.instance ?? null, url: connection?.url ?? null }));
  } else throw Error("사용법: workbench-service start | status | attach | stop");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
