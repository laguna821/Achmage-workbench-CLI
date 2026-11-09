import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Session, TranscriptItem, Work } from "@workbench/contracts";
import { WorkbenchClient } from "../../packages/client/src/index.ts";
import { attachHost, stopOwnedHost } from "../../apps/host/src/daemon/lifecycle.ts";

const run = promisify(execFile), dir = mkdtempSync(join(tmpdir(), "wb-daemon-probe-"));
const env = { ...process.env, WORKBENCH_DATA_DIR: dir, WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_IEUM_BOOTSTRAP: "0",
  WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "", WORKBENCH_HOST_ID: "daemon-fixture" };
const launcher = resolve("apps/host/dist/workbench-service.mjs");
try {
  // This launcher process ends before the first request. No visible UI owns the run.
  await run(process.execPath, [launcher, "start"], { env, timeout: 35_000 });
  const first = await attachHost(dir); assert(first);
  let client = new WorkbenchClient({ baseUrl: first.url, token: first.token });
  const work = await client.request<Work>("POST", "/api/works", { title: "UI가 없어도 실행" });
  const session = await client.request<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", access: "full" });
  await client.submit({ commandId: "daemon-request", hostId: session.hostId, workspaceId: session.workspaceId!, sessionId: session.id, text: "길게 답해 줘" });
  // Replace the UI/client during the response and attach via a second exited launcher.
  await run(process.execPath, [launcher, "start"], { env, timeout: 5000 });
  const attached = await attachHost(dir); assert.equal(attached?.instance.instanceId, first.instance.instanceId);
  client = new WorkbenchClient({ baseUrl: first.url, token: first.token });
  const deadline = Date.now() + 20_000;
  let done = false;
  while (Date.now() < deadline) {
    const result = await client.request<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`);
    if (result.items.some(item => item.kind === "turnEnd" && item.status === "completed")) { done = true; break; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert(done, "the same fake-provider run must finish without a UI process");
  await assert.rejects(client.request("POST", "/api/host/stop", { instance: { ...first.instance, ownerStartedAt: "wrong" } }), { code: "OWNER_MISMATCH" });
  const before = await client.snapshot();
  await stopOwnedHost(first);
  for (let i = 0; i < 100 && await attachHost(dir); i++) await new Promise(resolve => setTimeout(resolve, 100));
  await run(process.execPath, [launcher, "start"], { env, timeout: 35_000 });
  const second = await attachHost(dir); assert(second); assert.notEqual(second.instance.instanceId, first.instance.instanceId);
  const reconnected = new WorkbenchClient({ baseUrl: second.url, token: second.token });
  const after = await reconnected.snapshot();
  assert.equal(after.sessions.filter(entry => entry.id === session.id).length, 1);
  assert.notEqual(after.epoch, before.epoch);
  assert.equal(second.token, first.token);
  assert(!(readFileSync(join(dir, "service.log"), "utf8").includes(first.token)), "service logs must not contain the connection token");
  console.log(JSON.stringify({ status: "passed", launcherExitedBeforeRun: true, sameRunCompleted: done, duplicateHost: false, wrongOwnerStopRejected: true, restartRestoresSameSession: true, newEpoch: true }));
} finally {
  const owned = await attachHost(dir);
  if (owned) await stopOwnedHost(owned);
  // Stop acknowledgement precedes shutdown. Wait for this owned lock to disappear, never kill a saved PID.
  for (let i = 0; i < 100; i++) {
    try { readFileSync(join(dir, "host.lock/owner.json")); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  rmSync(dir, { recursive: true, force: true });
}
