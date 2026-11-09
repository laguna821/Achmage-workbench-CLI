import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostInstance } from "@workbench/contracts";
import { PROTOCOL_VERSION } from "@workbench/contracts";

export type HostConnection = { url: string; port: number; token: string; dataDir: string; editorsUrl: string | null; instance: HostInstance };
export function runtimeBuildId(entry: string) { return createHash("sha256").update(readFileSync(entry)).digest("hex"); }
export function sameInstance(a: HostInstance, b: HostInstance): boolean {
  return a.hostId === b.hostId && a.instanceId === b.instanceId && a.ownerPid === b.ownerPid && a.ownerStartedAt === b.ownerStartedAt && a.protocolVersion === b.protocolVersion;
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function ownerAt(root: string): HostInstance | null {
  try { return JSON.parse(readFileSync(join(root, "owner.json"), "utf8")) as HostInstance; } catch { return null; }
}
export function readConnection(dataDir: string): HostConnection | null {
  try {
    const root = join(dataDir, "host.lock"), owner = ownerAt(root);
    const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8")) as HostConnection;
    if (!owner || !sameInstance(owner, ready.instance)) return null;
    const url = new URL(ready.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !ready.token) return null;
    return ready;
  } catch { return null; }
}

/** Only the lock owner opens SQLite. Recovery never sends a signal to a saved PID. */
export function claimInstance(dataDir: string, hostId: string, mode: HostInstance["mode"]) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const root = join(dataDir, "host.lock");
  const instance: HostInstance = { hostId, mode, instanceId: randomUUID(), ownerPid: process.pid, ownerStartedAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, version: "0.4.0", buildId: runtimeBuildId(process.argv[1]!) };
  function claim() {
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A reclaimer belongs to this directory generation. It rereads the owner after acquiring
      // its slot, so another launcher cannot remove a newly created host's lock.
      const age = Date.now() - statSync(root).mtimeMs;
      try { mkdirSync(join(root, "reclaim")); } catch { throw Error("호스트가 시작 또는 복구 중입니다. 잠시 뒤 다시 연결해 주세요."); }
      let reclaimed = false;
      try {
        const prior = ownerAt(root);
        if (prior ? alive(prior.ownerPid) : age < 30_000) throw Error("이 데이터 폴더의 Workbench 호스트가 이미 실행 중입니다. 기존 호스트에 연결해 주세요.");
        const old = `${root}.expired-${instance.instanceId}`;
        renameSync(root, old); reclaimed = true;
        rmSync(old, { recursive: true, force: true });
      } finally { if (!reclaimed) rmSync(join(root, "reclaim"), { recursive: true, force: true }); }
      return claim();
    }
    writeFileSync(join(root, "owner.json"), JSON.stringify(instance), { mode: 0o600 });
  }
  claim();
  return {
    instance,
    ready(connection: Omit<HostConnection, "instance">) {
      if (!sameInstance(ownerAt(root) ?? {} as HostInstance, instance)) throw Error("호스트 소유권이 변경되었습니다.");
      const temporary = join(root, "ready.tmp");
      writeFileSync(temporary, JSON.stringify({ ...connection, instance }), { mode: 0o600 });
      renameSync(temporary, join(root, "ready.json"));
    },
    release() { const owner = ownerAt(root); if (owner && sameInstance(owner, instance)) rmSync(root, { recursive: true, force: true }); },
  };
}
