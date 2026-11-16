import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { scopedRoute } from "../devices/scope.ts";
import { createHttpServer } from "../http.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { UpdatePolicy } from "../update-policy.ts";
import type { Fetch } from "./download.ts";
import { AppUpdates } from "./service.ts";

// Who may ask (app-update brief, decision 5): only the PC's own window (its token); a paired phone or remote
// device cannot reach the route at all, and a request carries an action only — never an address or a file.
const TOKEN = "local-token-for-tests-0123456789abcdef";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function gateway() {
  const dir = mkdtempSync(join(tmpdir(), "wb-upd-route-")), dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const updatePolicy = new UpdatePolicy(manager, store);
  const asked: string[] = [];
  const fetchSpy: Fetch = async (input) => { asked.push(String(input)); throw new TypeError("offline"); };
  const appUpdates = new AppUpdates({ dataDir, installed: "0.5.2", policy: updatePolicy, stopForInstall: () => undefined, fetch: fetchSpy,
    install: { kind: "user-folder", root: dir, target: dir, appBin: "", relaunch: [], installable: true, reason: null } });
  const server: Server = createHttpServer(manager, bus, { token: TOKEN, webDir: null, updatePolicy, appUpdates });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await manager.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const api = async (method: string, body?: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`${origin}/api/host/app-update`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  return { manager, api, asked };
}

describe("the update route", () => {
  it("needs the window's token", async () => {
    const g = await gateway();
    expect((await g.api("GET", undefined, null)).status).toBe(401);
    expect((await g.api("POST", { action: "check" }, "wrong")).status).toBe(401);
    expect((await g.api("GET")).json).toMatchObject({ state: "idle", installed: "0.5.2", kind: "user-folder", autoCheck: true });
  });
  it("is out of reach of a paired remote device, for every method", async () => {
    const g = await gateway();
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      let refused: unknown = null;
      try { scopedRoute(g.manager, method, "/api/host/app-update", { action: "install" }); } catch (error) { refused = error; }
      expect(refused, method).toMatchObject({ status: 403, code: "CAPABILITY_DENIED" });
    }
  });
  it("takes an action only: an address, a file or a version in the request changes nothing", async () => {
    const g = await gateway();
    expect((await g.api("POST", { action: "download", url: "https://evil.example/x.exe" })).status).toBe(400);
    const answer = await g.api("POST", { action: "check", url: "https://evil.example/", version: "9.9.9", file: "/tmp/x" });
    expect(answer.json).toMatchObject({ state: "failed", available: null, message: "인터넷에 연결되지 않았습니다. 연결을 확인한 뒤 다시 눌러 주세요." });
    expect(g.asked.every(url => url.startsWith("https://github.com/laguna821/Achmage-workbench-CLI/releases/latest/download/update.json"))).toBe(true);
    expect(g.asked.length).toBeGreaterThan(0);
    // Without a verified manifest there is nothing to install.
    expect((await g.api("POST", { action: "install" })).json).toMatchObject({ state: "failed", message: "먼저 ‘업데이트 확인’을 눌러 주세요." });
  });
});
