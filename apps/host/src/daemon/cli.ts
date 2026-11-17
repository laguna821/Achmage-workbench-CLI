import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_HEADER, protocolHeader } from "@workbench/contracts";
import { recordWindow } from "../app-memory.ts";
import { attachHost, startHost, stopOwnedHost, prepareHostUpdate, prepareRollback } from "./lifecycle.ts";

const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const action = process.argv[2] ?? "status";
try {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const entry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../main.ts" : "./host.mjs", import.meta.url));
  const connection = action === "start" ? await startHost({ dataDir, entry }) : await attachHost(dataDir);
  if (action === "prepare-rollback") {
    // The way back to a build from before sec-vault round 2: the key is written where it looks, then
    // the service stops as for an update. Without a running gateway nothing can be written.
    if (!connection) throw Object.assign(Error("실행 중인 Workbench가 없습니다. 앱을 연 뒤 다시 실행해 주세요(보관함의 열쇠는 실행 중인 Workbench만 옮길 수 있습니다)."), { exitCode: 21 });
    await prepareRollback(connection);
    const receipt = await stopOwnedHost(connection, connection.instance, "drain");
    console.log(JSON.stringify({ ...receipt, rollback: "ready" }));
    if (receipt.state !== "stopped") process.exitCode = 21;
  } else if (action === "prepare-update") {
    if (!connection) {
      if (existsSync(join(dataDir, "host.lock"))) throw Object.assign(Error("기존 호스트의 소유권/종료 상태를 확인하지 못했습니다. 앱에서 작업까지 종료한 뒤 설치를 다시 시작해 주세요."), { exitCode: 21 });
      console.log(JSON.stringify({ state: "stopped", update: "ready" }));
    } else {
      const status = await prepareHostUpdate(connection);
      if (status.blockers.length) {
        await prepareHostUpdate(connection, "cancel");
        console.error(`진행 중인 작업 또는 실행기 ${status.blockers.length}개가 있습니다. 작업을 마치거나 앱에서 명시적으로 중단한 뒤 설치를 다시 시작해 주세요.`);
        process.exitCode = 20;
      } else {
        const receipt = await stopOwnedHost(connection, connection.instance, "drain");
        console.log(JSON.stringify(receipt));
        if (receipt.state !== "stopped") process.exitCode = 21;
      }
    }
  } else if (action === "stop") {
    const receipt = connection ? await stopOwnedHost(connection) : { state: "stopped" };
    console.log(JSON.stringify(receipt));
    if (receipt.state !== "stopped") process.exitCode = 1;
  } else if (action === "start" || action === "attach" || action === "status") {
    if (process.argv.includes("--desktop")) {
      if (!connection) throw Error("연결할 호스트가 없습니다.");
      // The shell runs this command: its parent is the window, which the memory readout looks for (app-memory.ts).
      recordWindow(dataDir, process.ppid);
      // This protocol is read from a private pipe by the shell, never from service.log.
      console.log(`WORKBENCH_READY ${JSON.stringify(connection)}`);
    } else {
      // One line on the vault (sec-vault round 2, I3): the reason and what to do, never a secret.
      const vault = connection ? await vaultLine(connection) : null;
      console.log(JSON.stringify({ state: connection ? "running" : "stopped", instance: connection?.instance ?? null, url: connection?.url ?? null, ...(vault ? { vault } : {}) }));
    }
  } else throw Error("사용법: workbench-service start | status | attach | stop | prepare-update | prepare-rollback");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = action === "prepare-update" ? 21 : 1; }

async function vaultLine(connection: { url: string; token: string }): Promise<string | null> {
  try {
    const response = await fetch(`${connection.url}/api/host`, { headers: { [PROTOCOL_HEADER]: protocolHeader(), authorization: `Bearer ${connection.token}` }, redirect: "error", signal: AbortSignal.timeout(1500) });
    const status = await response.json() as { vault?: { state: string; message: string | null } };
    if (!status.vault) return null;
    return status.vault.state === "refused" ? `비밀 보관함을 열지 못했습니다. ${status.vault.message ?? ""}`.trim() : status.vault.state === "open" ? "비밀 보관함: 열림" : "비밀 보관함: 아직 확인 전";
  } catch { return null; }
}
