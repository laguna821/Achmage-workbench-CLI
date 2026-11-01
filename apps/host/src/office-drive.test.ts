import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { OfficeDrive, driveTokenVault } from "./office-drive.mjs";
import { OfficeVault } from "./office-vault.ts";
import { googleDriveFixture } from "../../../scripts/fixtures/google-drive.mjs";
import type { OfficeControl } from "./office-control.mjs";

type Internal = OfficeDrive & { connection: { api: unknown }; files: { entryFor(path: string): any; snapshot(): any[]; syncIfChanged(id: string): Promise<void> } };
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup(options: { persists?: boolean; client?: boolean; watch?: boolean; open?: () => Promise<{ ok: boolean }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-drive-")), paths: string[] = [];
  const remote = googleDriveFixture([
    { id: "note", name: "클라우드 노트.md", mimeType: "text/markdown", bytes: "# 원본\nDrive 본문" },
    { id: "google", name: "Google 문서", mimeType: "application/vnd.google-apps.document", bytes: "exported Office bytes" },
  ]);
  const makeVault = () => new OfficeVault(dir, async () => { if (options.persists === false) throw new Error("Locked keyring"); return { id: "a".repeat(32), key: Buffer.alloc(32, 7) }; });
  let authUrl = "";
  const control = { locate: () => undefined, view: () => undefined, handle: async (request: { path: string }) => { paths.push(request.path); return options.open ? options.open() : { ok: true }; } } as unknown as OfficeControl;
  const injected = { client: options.client === false ? null : { clientId: "fixture.apps.googleusercontent.com", clientSecret: "fixture-only" }, vault: makeVault(), fetch: remote.fetch,
    openBrowser: async (address: string) => {
      authUrl = address;
      const url = new URL(address), callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", url.searchParams.get("state")!);
      setTimeout(() => void fetch(callback).catch(() => {}), 1); return true;
    }, files: options.watch ? { debounceMs: 20 } : { watch: () => () => {} },
  };
  const drive = new OfficeDrive(null, control, dir, injected) as Internal;
  cleanup.push(() => { drive.close(); rmSync(dir, { recursive: true, force: true }); });
  const connect = () => drive.invoke("drive:connect");
  return { dir, drive, control, remote, paths, injected, connect, makeVault, authUrl: () => authUrl };
}

it("keeps unconfigured builds unavailable without touching Google", async () => {
  const f = setup({ client: false }); await f.drive.start();
  expect(f.drive.state()).toEqual({ state: "unavailable" }); expect(f.remote.requests).toEqual([]);
});
it("uses real PKCE loopback, seals refresh tokens, restores and disconnects", async () => {
  const f = setup(); expect(await f.connect()).toEqual({ ok: true });
  const auth = new URL(f.authUrl()); expect(auth.searchParams.get("code_challenge_method")).toBe("S256"); expect(auth.searchParams.has("client_secret")).toBe(false);
  const path = join(f.dir, "office/drive/google-drive.json"), saved = readFileSync(path, "utf8");
  expect(saved).toContain("sealed:v1:workbench:"); expect(saved).not.toMatch(/fixture-refresh|fixture-access/);
  expect(f.drive.state()).toMatchObject({ state: "connected", email: "drive-fixture@example.invalid", persisted: true, aiAccess: true });
  f.drive.close();
  const restored = new OfficeDrive(null, f.control, f.dir, { ...f.injected, vault: f.makeVault() }); cleanup.push(() => restored.close()); await restored.start();
  expect(restored.state()).toMatchObject({ state: "connected", persisted: true });
  await restored.invoke("drive:disconnect"); expect(restored.state()).toMatchObject({ state: "disconnected" }); expect(f.remote.revoked).toBe(true); expect(existsSync(path)).toBe(false);
});
it("keeps a usable session without writing a plaintext token when the OS vault is locked", async () => {
  const f = setup({ persists: false }); await f.connect();
  expect(f.drive.state()).toMatchObject({ state: "connected", persisted: false }); expect(existsSync(join(f.dir, "office/drive/google-drive.json"))).toBe(false);
});
it("lists original types, opens the downloaded file and waits for the GUI outcome", async () => {
  let resolve!: (value: { ok: boolean }) => void;
  const f = setup({ open: () => new Promise(done => { resolve = done; }) }); await f.connect();
  const listing = await f.drive.list({ kind: "folder", folderId: "root" });
  expect(listing.files).toContainEqual(expect.objectContaining({ id: "google", type: "document", google: true, openable: true }));
  let answered = false; const opening = f.drive.open("note").then(value => { answered = true; return value; });
  await vi.waitFor(() => expect(f.paths).toHaveLength(1)); expect(answered).toBe(false);
  expect(readFileSync(f.paths[0]!, "utf8")).toContain("Drive 본문"); resolve({ ok: false });
  expect(await opening).toEqual({ ok: false, kind: "disk" });
});
it("uploads saved edits, asks on remote change, and preserves a local-only choice", async () => {
  const f = setup(); await f.connect(); await f.drive.open("note");
  const path = f.paths[0]!; writeFileSync(path, "첫 편집"); await f.drive.files.syncIfChanged("note");
  expect(f.remote.uploads[0]).toMatchObject({ id: "note", created: false, bytes: Buffer.from("첫 편집") });
  const remote = f.remote.files.get("note")!; remote.bytes = Buffer.from("원격 변경"); remote.version++;
  writeFileSync(path, "PC에 보존"); const sync = f.drive.files.syncIfChanged("note");
  await vi.waitFor(() => expect(f.drive.activity().prompts).toHaveLength(1));
  const prompt = f.drive.activity().prompts[0]!; expect(prompt.choices.map(item => item.value)).toEqual(["overwrite", "copy", "local"]);
  f.drive.answer(prompt.id, "local"); await sync;
  expect(remote.bytes.toString()).toBe("원격 변경"); expect(readFileSync(path, "utf8")).toBe("PC에 보존");
  expect(f.drive.files.entryFor(path).detached).toBe(true);
});
it("saves Google documents as a new Office file and leaves the Google source intact", async () => {
  const f = setup(); await f.connect(); await f.drive.open("google");
  expect(f.paths[0]).toMatch(/\.docx$/); writeFileSync(f.paths[0]!, "edited Office bytes"); await f.drive.files.syncIfChanged("google");
  expect(f.remote.uploads).toHaveLength(1); expect(f.remote.uploads[0]).toMatchObject({ created: true, name: "Google 문서.docx" });
  expect(f.remote.files.get("google")!.bytes.toString()).toBe("exported Office bytes"); expect(f.drive.activity().notices[0]?.message).toContain("Google 문서.docx");
});
it("keeps manual attachment copies after temporary downloads are gone, independently of AI access", async () => {
  const f = setup(); await f.connect(); await f.drive.invoke("drive:set-ai-access", [false]);
  expect(await f.drive.tool("drive-read", ["note", 0])).toMatchObject({ ok: false });
  const attached = await f.drive.attach([{ id: "note", folder: false }]); expect(attached.ok).toBe(true);
  rmSync(join(f.dir, "office/drive/downloads"), { recursive: true, force: true });
  if (!attached.ok) throw new Error("Attachment failed"); expect(readFileSync(attached.paths[0]!, "utf8")).toContain("Drive 본문");
  await f.drive.invoke("drive:set-ai-access", [true]); expect(await f.drive.tool("drive-read", ["note", 0])).toMatchObject({ ok: true, page: { name: "클라우드 노트.md", text: expect.stringContaining("Drive 본문") } });
  expect(await f.drive.tool("drive-search", ["노트", 5])).toMatchObject({ ok: true, hits: expect.arrayContaining([expect.objectContaining({ id: "note" })]) });
});
it("does not mistake malformed stored tokens for a live connection", async () => {
  const f = setup(), path = join(f.dir, "broken.json"); writeFileSync(path, JSON.stringify({ version: 1, token: "plaintext" }));
  const vault = driveTokenVault(path, f.makeVault()); expect(await vault.load()).toBeNull(); expect(readFileSync(path, "utf8")).toContain("plaintext");
});
it("observes successive atomic replacements of the same downloaded file", async () => {
  const f = setup({ watch: true }); await f.connect(); await f.drive.open("note");
  const path = f.paths[0]!;
  for (const text of ["ATOMIC_FIRST", "ATOMIC_SECOND", "ATOMIC_THIRD"]) {
    writeFileSync(`${path}.temporary`, text); renameSync(`${path}.temporary`, path);
    await vi.waitFor(() => expect(f.remote.uploads.at(-1)?.bytes.toString()).toBe(text), { timeout: 3000 });
  }
});
