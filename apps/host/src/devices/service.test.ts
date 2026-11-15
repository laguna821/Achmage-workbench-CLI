import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseRemoteOffer } from "../../../../packages/client/src/remote.ts";
import { Store } from "../store.ts";
import { EventBus } from "../bus.ts";
import { SessionManager } from "../sessions.ts";
import { DeviceService } from "./service.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A data folder that outlives the gateways started on it, as the real one outlives app restarts. */
function dataFolder() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-device-service-"));
  const store = new Store(join(directory, "state.sqlite"));
  const bus = new EventBus(8);
  const manager = new SessionManager(store, bus, { hostId: "loopback-host", hostLabel: "연결 검사 호스트", dataDir: directory, managedWorksDir: join(directory, "works") });
  cleanup.push(async () => { await manager.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  /** One gateway run. Only loopback is opened. */
  async function run(webDir: string | null = null) {
    const service = new DeviceService({ dataDir: directory, manager, bus, localToken: "test-local-owner", localOrigin: () => null, webDir });
    let open = true;
    const stop = () => { if (open) { open = false; service.close(); } };
    cleanup.push(stop);
    await service.start();
    return { service, stop };
  }
  return { run, directory };
}
async function occupy(port: number): Promise<Server> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(port, "127.0.0.1", resolve); });
  cleanup.push(() => new Promise<void>(resolve => { blocker.close(() => resolve()); }));
  return blocker;
}
const on = { enabled: true, listenHost: "127.0.0.1", port: 0 };

test("the address a device saved still works after the gateway restarts: an automatic port is kept", async () => {
  const folder = dataFolder();
  const first = await folder.run();
  const started = await first.service.configure(on);
  expect(started.status).toBe("listening");
  expect(started.port).toBeGreaterThan(1024);
  const saved = parseRemoteOffer((await first.service.createOffer()).url).workbench.endpoint;
  first.stop();

  const second = await folder.run();
  expect(second.service.state()).toMatchObject({ status: "listening", port: started.port });
  expect(parseRemoteOffer((await second.service.createOffer()).url).workbench.endpoint).toBe(saved);
  // Turning remote access off and on again keeps it too.
  await second.service.configure({ ...on, enabled: false });
  expect(second.service.state()).toMatchObject({ status: "disabled", port: null });
  expect((await second.service.configure(on)).port).toBe(started.port);
});

test("when another program holds the kept port the PC says so and does not move to a different port", async () => {
  const folder = dataFolder();
  const first = await folder.run();
  const port = (await first.service.configure(on)).port!;
  first.stop();
  const blocker = await occupy(port);

  const second = await folder.run();
  const state = second.service.state();
  expect(state.status).toBe("error");
  expect(state.port).toBeNull();
  expect(state.error).toContain(String(port));
  expect(state.error).toContain("다른 프로그램");
  await expect(second.service.createOffer()).rejects.toMatchObject({ status: 409 });

  await new Promise<void>(resolve => { blocker.close(() => resolve()); });
  expect(await second.service.configure(on)).toMatchObject({ status: "listening", port });
});

test("a port the owner chose is used as given, and a taken one is reported with its number", async () => {
  const folder = dataFolder();
  const run = await folder.run();
  const automatic = (await run.service.configure(on)).port!;
  const probe = await occupy(0);
  const address = probe.address();
  if (!address || typeof address === "string") throw Error("Missing probe port");
  await expect(run.service.configure({ ...on, port: address.port })).rejects.toThrow(String(address.port));
  expect(run.service.state()).toMatchObject({ status: "error", port: null });
  await new Promise<void>(resolve => { probe.close(() => resolve()); });
  expect(await run.service.configure({ ...on, port: address.port })).toMatchObject({ status: "listening", port: address.port });
  // Back to automatic: the port kept before, not a new one.
  expect((await run.service.configure(on)).port).toBe(automatic);
});

test("without an address a phone can open there is no QR, only a link to paste into another Workbench", async () => {
  const folder = dataFolder();
  const run = await folder.run();
  expect((await run.service.configure(on)).phoneUrl).toBeNull();
  const local = await run.service.createOffer();
  expect(local.url.startsWith("workbench://connect/#offer=")).toBe(true);
  expect(local.qrDataUrl).toBeNull();

  // A loopback address is this PC only: a phone cannot open it either.
  expect((await run.service.configure({ ...on, publicUrl: "http://127.0.0.1:8787" })).phoneUrl).toBeNull();
  expect((await run.service.createOffer()).qrDataUrl).toBeNull();

  // The address is only written into the link and its QR here; nothing connects to it.
  const reachable = await run.service.configure({ ...on, publicUrl: "https://desk.tailnet.example" });
  expect(reachable.phoneUrl).toBe("https://desk.tailnet.example");
  const offer = await run.service.createOffer();
  expect(offer.url.startsWith("https://desk.tailnet.example/#offer=")).toBe(true);
  expect(offer.qrDataUrl).toMatch(/^data:image\/png;base64,/);
});

test("a link made for an https address without a port number is one the device can read", async () => {
  const folder = dataFolder();
  const run = await folder.run();
  await run.service.configure({ ...on, publicUrl: "https://desk.tailnet.example" });
  // The device's own parser, as in the pairing screen. It only reads the link.
  const secure = parseRemoteOffer((await run.service.createOffer()).url);
  expect(secure.workbench.endpoint).toBe("wss://desk.tailnet.example/workbench");
  expect(secure.relay).toMatchObject({ endpoint: "desk.tailnet.example:443", useTls: true });
  await run.service.configure({ ...on, publicUrl: "http://desk.lan.example" });
  expect(parseRemoteOffer((await run.service.createOffer()).url).relay).toMatchObject({ endpoint: "desk.lan.example:80", useTls: false });
  await run.service.configure({ ...on, publicUrl: "https://desk.tailnet.example:8443" });
  expect(parseRemoteOffer((await run.service.createOffer()).url).relay).toMatchObject({ endpoint: "desk.tailnet.example:8443", useTls: true });
});

test("pages served to devices cannot be framed by another site, load plugins or be rebased, and files are not type-guessed", async () => {
  const folder = dataFolder();
  // A stand-in for the web build: the app page, a built file, and the design page the app frames itself.
  const web = join(folder.directory, "web");
  mkdirSync(join(web, "assets"), { recursive: true }); mkdirSync(join(web, "design"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(web, "assets", "app-1.js"), "export {};");
  writeFileSync(join(web, "design", "index.html"), "<!doctype html><title>design</title>");
  const run = await folder.run(web);
  const port = (await run.service.configure(on)).port!;
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: "error" });
  const directives = (response: Response) => (response.headers.get("content-security-policy") ?? "").split(";").map(part => part.trim()).filter(Boolean);

  for (const path of ["/", "/any/deep/link"]) {
    const page = await get(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>app</title>");
    expect(directives(page)).toEqual(expect.arrayContaining(["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]));
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  }
  // The design page is framed by the app from the same address, and by nothing else.
  const design = await get("/design/");
  expect(await design.text()).toContain("<title>design</title>");
  expect(directives(design)).toEqual(expect.arrayContaining(["frame-ancestors 'self'", "object-src 'none'", "base-uri 'none'"]));
  expect(design.headers.get("x-content-type-options")).toBe("nosniff");
  // No script rule is sent: the app's own scripts and styles load as before.
  expect(directives(await get("/")).some(part => /^(script|style|default|connect|worker)-src/.test(part))).toBe(false);
  const built = await get("/assets/app-1.js");
  expect(built.status).toBe(200);
  expect(built.headers.get("content-type")).toContain("javascript");
  expect(built.headers.get("x-content-type-options")).toBe("nosniff");
});
