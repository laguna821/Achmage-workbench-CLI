import { PROTOCOL_HEADER, protocolHeader, WORKBENCH_PROTOCOL, negotiateProtocol, requireProtocolWrite } from "@workbench/contracts";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { HostInstance, HostStatus, StopReceipt } from "@workbench/contracts";
import { readConnection, runtimeBuildId, sameInstance, type HostConnection } from "./instance.ts";

export async function attachHost(dataDir: string): Promise<HostConnection | null> {
  const connection = readConnection(dataDir);
  if (!connection) return null;
  try {
    const response = await fetch(`${connection.url}/api/host`, { headers: { [PROTOCOL_HEADER]: protocolHeader(), authorization: `Bearer ${connection.token}` }, redirect: "error", signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const status = await response.json() as HostStatus;
    return status.state === "running" && sameInstance(connection.instance, status.instance) ? connection : null;
  } catch { return null; }
}

/**
 * The app's binary that launches the gateway: the AppImage runner, else the binary the app or the login
 * unit names, else (a login unit that names none — older than wave 21's shape; check F3) the binary
 * installed beside `entry` (host/host.mjs): <install>/achmage-workbench[.exe], the .app's
 * Contents/MacOS, or /usr/bin for a /usr/lib/<product> package. None from a source checkout.
 */
export function launcherOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, entry?: string): string | undefined {
  const image = platform === "linux" ? env.WORKBENCH_HOST_RUNNER : undefined;
  const named = image || env.WORKBENCH_SECRET_BIN || env.WORKBENCH_APP_BIN;
  if (named || !entry) return named || undefined;
  const install = dirname(dirname(entry)), name = platform === "win32" ? "achmage-workbench.exe" : "achmage-workbench";
  const beside = [join(install, name), ...(platform === "darwin" ? [join(install, "..", "MacOS", name)] : []), ...(platform === "linux" ? [join(install, "..", "..", "bin", name)] : [])];
  return beside.find((file) => existsSync(file));
}

/** A tiny launcher exits; the detached host retains its own descriptors and process group. */
export async function startHost(options: { dataDir: string; entry: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<HostConnection> {
  const existing = await attachHost(options.dataDir);
  if (existing) {
    if (existing.instance.mode !== "service") throw Error("기존 앱이 이 데이터 폴더를 사용 중입니다. 이전 앱을 종료한 뒤 다시 열어 주세요.");
    if (existing.instance.buildId !== runtimeBuildId(options.entry)) throw Error("다른 버전의 백그라운드 호스트가 실행 중입니다. 기존 앱 트레이의 ‘작업까지 모두 종료’ 후 새 앱을 열어 주세요. 대화 기록은 유지됩니다.");
    return existing;
  }
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(options.dataDir, "service.log"), "a", 0o600);
  let launchError: Error | null = null;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, WORKBENCH_DATA_DIR: options.dataDir, WORKBENCH_HOST_MODE: "service", WORKBENCH_EXIT_ON_STDIN_CLOSE: "0" };
    // The in-app update replaces the AppImage the person opened, not the gateway's persistent copy of it
    // (whose own $APPIMAGE is that copy): the original's place is handed on (app-update/kind.ts).
    const image = env.APPIMAGE;
    if (image && !env.WORKBENCH_APPIMAGE_SOURCE && !image.replace(/\\/g, "/").includes("/runtimes/appimage/")) env.WORKBENCH_APPIMAGE_SOURCE = image;
    // The gateway is always started by the app's own binary (`--host-runtime`, host_runtime.rs): it
    // registers the gateway with the vault and hands it its per-run ticket (sec-vault round 2). A
    // durable AppImage is that binary (it also keeps its own mount). Without the binary (a source
    // checkout) the gateway runs directly and the vault refuses it — and says so.
    const runner = launcherOf(env, process.platform, options.entry);
    const child = spawn(runner ?? process.execPath, runner ? ["--host-runtime"] : [options.entry], { env, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
    child.on("error", error => { launchError = error; });
    child.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const ready = await attachHost(options.dataDir);
    if (ready) return ready;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("호스트를 시작하지 못했습니다. 데이터 폴더의 service.log를 확인해 주세요.");
}

export async function stopOwnedHost(connection: HostConnection, expected: HostInstance = connection.instance, mode: "drain" | "interrupt" = "interrupt"): Promise<StopReceipt> {
  if (!sameInstance(connection.instance, expected)) throw Object.assign(Error("호스트 소유권이 일치하지 않습니다."), { code: "OWNER_MISMATCH" });
  const response = await fetch(`${connection.url}/api/host/stop`, { method: "POST", redirect: "error", headers: { [PROTOCOL_HEADER]: protocolHeader(), authorization: `Bearer ${connection.token}`, "content-type": "application/json" }, body: JSON.stringify({ instance: expected, mode }), signal: AbortSignal.timeout(5000) });
  const receipt = await response.json() as StopReceipt & { message?: string; code?: string };
  if (!response.ok) throw Object.assign(Error(receipt.message ?? "호스트를 종료하지 못했습니다."), { code: receipt.code });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readConnection(connection.dataDir);
    if (!current || !sameInstance(current.instance, expected)) return { ...receipt, state: "stopped" };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return receipt;
}

/** Installer preparation never upgrades ownership or guesses whether an old host is idle. */
export async function prepareHostUpdate(connection: HostConnection, action: "prepare" | "cancel" = "prepare") {
  if (connection.instance.protocol) requireProtocolWrite(negotiateProtocol(WORKBENCH_PROTOCOL, connection.instance.protocol));
  const response = await fetch(`${connection.url}/api/host/update`, { method: "POST", redirect: "error", headers: { [PROTOCOL_HEADER]: protocolHeader(), authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify({ instance: connection.instance, action }), signal: AbortSignal.timeout(5000) });
  const result = await response.json() as import("@workbench/contracts").HostUpdateStatus & { message?: string; code?: string };
  if (!response.ok) throw Object.assign(Error(result.message ?? "기존 호스트에서 작업을 마친 뒤 앱의 ‘작업까지 모두 종료’를 사용해 주세요."), { code: result.code ?? "update_unavailable" });
  return result;
}

/** The way back (INSTALL-NOTE): the running gateway writes the vault's key where builds before sec-vault round 2 look. */
export async function prepareRollback(connection: HostConnection) {
  const response = await fetch(`${connection.url}/api/host/vault/legacy`, { method: "POST", redirect: "error", headers: { [PROTOCOL_HEADER]: protocolHeader(), authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify({ instance: connection.instance }), signal: AbortSignal.timeout(20_000) });
  const result = await response.json() as { ok?: boolean; message?: string };
  if (!response.ok || result.ok !== true) throw Error(result.message ?? "보관함의 열쇠를 이전 판이 읽는 자리에 쓰지 못했습니다.");
}
