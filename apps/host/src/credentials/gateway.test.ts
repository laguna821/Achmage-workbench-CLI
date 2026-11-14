import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus.ts";
import { ChannelService } from "../channels/service.ts";
import { FakeTelegram } from "../channels/fake-telegram.ts";
import { StandInEngine } from "../channels/test-kit.ts";
import { scopedRoute } from "../devices/scope.ts";
import { createHttpServer } from "../http.ts";
import { OfficeVault } from "../office-vault.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { UpdatePolicy } from "../update-policy.ts";
import { installScrubber } from "./install.ts";
import { CredentialService } from "./service.ts";

// The 비밀 보관함 routes as the gateway serves them: behind the local token, never to a paired
// remote device, refused while an update is prepared (except deleting), and no answer with a value.
const TOKEN = "local-token-for-tests-0123456789abcdef";
const VALUE = "zz-secret-pass-0008";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

async function gateway() {
  const dir = mkdtempSync(join(tmpdir(), "wb-cred-gateway-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const fake = new FakeTelegram();
  await fake.start();
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  manager.registerAdapter(new StandInEngine(() => manager.sink));
  const vault = new OfficeVault(dataDir, async () => ({ id: "d".repeat(32), key: Buffer.alloc(32, 5) }));
  const credentials = new CredentialService({ dataDir, vault, manager });
  installScrubber(store, manager, credentials.scrubber);
  const channels = new ChannelService({ dataDir, store, manager, bus, vault, credentials, telegramUrl: fake.url, telegram: { pollSeconds: 1, minSendGapMs: 0 } });
  const updatePolicy = new UpdatePolicy(manager, store);
  const server: Server = createHttpServer(manager, bus, { token: TOKEN, webDir: null, channels, updatePolicy });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    await channels.close();
    credentials.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await manager.shutdown();
    store.close();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text };
  };
  return { manager, updatePolicy, api };
}

describe("the 비밀 보관함 routes on the gateway", () => {
  it("need the local token, and no answer carries a value", async () => {
    const g = await gateway();
    expect((await g.api("GET", "/api/channels/credentials", undefined, null)).status).toBe(401);
    const added = await g.api("POST", "/api/channels/credentials", { name: "네이버", kind: "login", site: "nid.naver.com", values: { 비밀번호: VALUE } });
    expect(added.status).toBe(200);
    expect(added.text).not.toContain(VALUE);
    expect(added.text).toContain("네이버");
    const listed = await g.api("GET", "/api/channels/credentials");
    expect(listed.text).not.toContain(VALUE);
    expect(JSON.parse(listed.text).entries[0]).not.toHaveProperty("values");
  });

  it("are out of reach of a paired remote device, whatever it may do", async () => {
    const g = await gateway();
    {
      for (const [method, path] of [["GET", "/api/channels/credentials"], ["POST", "/api/channels/credentials"], ["PATCH", "/api/channels/credentials/c1"], ["DELETE", "/api/channels/credentials/c1"], ["POST", "/api/channels/credentials/handoffs/h1"]] as const) {
        let refused: unknown = null;
        try { scopedRoute(g.manager, method, path, {}); } catch (error) { refused = error; }
        expect(refused, `${method} ${path}`).toMatchObject({ status: 403, code: "CAPABILITY_DENIED" });
      }
    }
  });

  it("take no new value while an update is being prepared", async () => {
    const g = await gateway();
    await g.updatePolicy.stop("drain");
    expect((await g.api("POST", "/api/channels/credentials", { name: "네이버", kind: "login", site: "", values: { 비밀번호: VALUE } })).status).toBe(409);
    expect((await g.api("GET", "/api/channels/credentials")).status).toBe(200);
  });
});
