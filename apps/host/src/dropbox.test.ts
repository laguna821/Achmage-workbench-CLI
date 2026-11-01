import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { DropboxFolders, discoverDropbox } from "./dropbox.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { createHttpServer } from "./http.ts";
import type { AddressInfo } from "node:net";
import type { DropboxListing } from "../../../packages/contracts/src/dropbox.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "wb-dropbox-")), home = join(root, "home"), data = join(root, "local"), cloud = join(home, "Dropbox");
  mkdirSync(cloud, { recursive: true }); mkdirSync(join(home, ".dropbox"));
  writeFileSync(join(home, ".dropbox/info.json"), JSON.stringify({ personal: { path: cloud, host: "never-return-account-id" } }));
  const store = new Store(join(data, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "test", hostLabel: "test", managedWorksDir: join(data, "works"), dataDir: data });
  const dropbox = new DropboxFolders(store, manager, data, { home, platform: "linux" });
  cleanups.push(async () => { dropbox.close(); await manager.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, home, data, cloud, store, bus, manager, dropbox };
}

it.each(["linux", "darwin", "win32"] as const)("finds both registered Dropbox folders on %s without exposing account metadata", platform => {
  const { root, home, cloud } = setup(), business = join(root, "Company files"), appData = join(root, "roaming"), localData = join(root, "local-appdata"); mkdirSync(business);
  const info = { personal: { path: cloud, host: "private-id", token: "not-for-app" }, business: { path: business, subscription_type: "irrelevant" } };
  const files = platform === "win32" ? [join(appData, "Dropbox/info.json"), join(localData, "Dropbox/info.json")] : [join(home, ".dropbox/info.json")];
  for (const file of files) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(info)); }
  const folders = discoverDropbox({ platform, home, env: { APPDATA: appData, LOCALAPPDATA: localData } });
  expect(folders).toHaveLength(2); expect(folders.map(folder => folder.path)).toEqual([cloud, business]);
  expect(JSON.stringify(folders)).not.toMatch(/private-id|not-for-app|subscription_type/);
  expect(folders.every(folder => folder.available && folder.source === "registered")).toBe(true);
});

it("keeps malformed metadata as a suggestion, retains unavailable paths and never relocates documents", () => {
  const { home, cloud, root, manager, store, data, dropbox } = setup();
  writeFileSync(join(home, ".dropbox/info.json"), "invalid"); expect(dropbox.state().candidates[0]?.source).toBe("suggested");
  const file = join(cloud, "유지.md"); writeFileSync(file, "keep");
  dropbox.connect(cloud); const restored = new DropboxFolders(store, manager, data, { home, platform: "linux" });
  expect(restored.state().selected?.path).toBe(cloud);
  renameSync(cloud, join(root, "offline")); expect(restored.state().selected).toMatchObject({ path: cloud, available: false });
  expect(() => restored.list()).toThrow(/찾을 수 없습니다/);
  renameSync(join(root, "offline"), cloud); expect(restored.list().entries[0]?.path).toBe(file);
  dropbox.disconnect(); expect(dropbox.state().selected).toBeNull(); expect(readFileSync(file, "utf8")).toBe("keep");
});

it("scopes navigation and file opens, preserves conflict copies and keeps local state out of Dropbox", () => {
  const { root, data, cloud, manager, dropbox } = setup();
  expect(() => dropbox.connect(data)).toThrow(/앱 데이터/); expect(() => dropbox.connect(root)).toThrow(/앱 데이터/);
  const folder = join(cloud, "한글 프로젝트"); mkdirSync(folder);
  writeFileSync(join(folder, "보고서.md"), "original"); writeFileSync(join(folder, "보고서 (person conflicted copy).md"), "other version");
  writeFileSync(join(root, "outside.md"), "outside"); symlinkSync(join(root, "outside.md"), join(folder, "alias.md"));
  dropbox.connect(cloud); expect(() => dropbox.list("..")).toThrow(/안에서/); expect(() => dropbox.open(join(folder, "alias.md"), "document")).toThrow(/밖으로/);
  const listing = dropbox.list(folder); expect(listing.entries).toHaveLength(2); expect(listing.entries.filter(entry => entry.conflictedCopy)).toHaveLength(1);
  const opened = dropbox.open(folder, "folder"), document = dropbox.open(join(folder, "보고서.md"), "document");
  expect(document.work.id).toBe(opened.work.id); expect(dropbox.open(join(folder, "보고서.md"), "document").artifact?.id).toBe(document.artifact?.id);
  expect(manager.snapshot().works).toHaveLength(1); expect(document.artifact?.path).toBe(join(folder, "보고서.md"));
  expect(readdirSync(folder).sort()).toEqual(["alias.md", "보고서 (person conflicted copy).md", "보고서.md"].sort());
  expect(readFileSync(join(folder, "보고서.md"), "utf8")).toBe("original");
});

it("observes consecutive atomic replacements, preserves dirty edits and resumes after folder loss", async () => {
  const { cloud, root, manager, dropbox } = setup(), file = join(cloud, "동기화.md"); writeFileSync(file, "before"); dropbox.connect(cloud);
  const { artifact } = dropbox.open(file, "document"); const id = artifact!.id;
  const settle = () => { dropbox.refresh(); dropbox.refresh(); };
  const replace = (text: string) => { writeFileSync(join(root, "replacement"), text); renameSync(join(root, "replacement"), file); };
  settle();
  for (const [index, text] of ["remote one", "remote two", "remote three"].entries()) {
    replace(text); settle(); expect(manager.documents.get(id).revision).toBe(index + 2); expect((await manager.documents.text(id)).text).toBe(text);
  }
  const registration = manager.documents.registry.open(id, { viewId: "editor", windowId: "window", claim: true, dirty: true });
  replace("remote while typing"); settle(); expect(manager.documents.get(id)).toMatchObject({ revision: 4, diskState: "changed" });
  await expect(manager.documents.saveText(id, 4, "local draft", { viewId: "editor", writeToken: registration.writeToken })).rejects.toMatchObject({ code: "disk_changed" });
  expect(readFileSync(file, "utf8")).toBe("remote while typing"); expect(manager.documents.registry.forArtifact(id)[0]?.dirty).toBe(true);
  manager.documents.registry.open(id, { viewId: "editor", windowId: "window", dirty: false }); settle(); expect(manager.documents.get(id).revision).toBe(5);
  renameSync(cloud, join(root, "unmounted")); settle(); expect(manager.documents.get(id).diskState).toBe("missing"); expect(manager.documents.revisions(id)).toHaveLength(5);
  renameSync(join(root, "unmounted"), cloud); replace("back online"); settle(); expect(manager.documents.get(id)).toMatchObject({ revision: 6, diskState: "same" });
  expect(manager.documents.revisions(id).at(-1)?.note).toBe("Dropbox 폴더에서 바뀐 내용");
});

it("requires the existing host token for Dropbox discovery, connection and opens", async () => {
  const { manager, bus, cloud, dropbox } = setup(), server = createHttpServer(manager, bus, { token: "fixture-token", webDir: null, dropbox });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await fetch(`${url}/api/dropbox`)).status).toBe(401);
  const headers = { authorization: "Bearer fixture-token", "content-type": "application/json" };
  expect((await fetch(`${url}/api/dropbox`, { method: "PUT", headers, body: JSON.stringify({ path: cloud }) })).status).toBe(200);
  const listing = await fetch(`${url}/api/dropbox/files`, { headers }).then(response => response.json()) as DropboxListing;
  expect(listing.path).toBe(cloud); expect(listing.entries).toEqual([]);
  expect((await fetch(`${url}/api/dropbox/open`, { method: "POST", headers, body: JSON.stringify({ path: "..", kind: "folder" }) })).status).toBe(403);
});
