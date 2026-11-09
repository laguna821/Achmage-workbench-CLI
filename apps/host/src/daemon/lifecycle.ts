import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { HostInstance, HostStatus, StopReceipt } from "@workbench/contracts";
import { readConnection, runtimeBuildId, sameInstance, type HostConnection } from "./instance.ts";

export async function attachHost(dataDir: string): Promise<HostConnection | null> {
  const connection = readConnection(dataDir);
  if (!connection) return null;
  try {
    const response = await fetch(`${connection.url}/api/host`, { headers: { authorization: `Bearer ${connection.token}` }, redirect: "error", signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const status = await response.json() as HostStatus;
    return status.state === "running" && sameInstance(connection.instance, status.instance) ? connection : null;
  } catch { return null; }
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
    const child = spawn(process.execPath, [options.entry], { env: { ...process.env, ...options.env, WORKBENCH_DATA_DIR: options.dataDir, WORKBENCH_HOST_MODE: "service", WORKBENCH_EXIT_ON_STDIN_CLOSE: "0" }, detached: true, windowsHide: true, stdio: ["ignore", log, log] });
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

export async function stopOwnedHost(connection: HostConnection, expected: HostInstance = connection.instance): Promise<StopReceipt> {
  if (!sameInstance(connection.instance, expected)) throw Object.assign(Error("호스트 소유권이 일치하지 않습니다."), { code: "OWNER_MISMATCH" });
  const response = await fetch(`${connection.url}/api/host/stop`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" }, body: JSON.stringify({ instance: expected }), signal: AbortSignal.timeout(5000) });
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
