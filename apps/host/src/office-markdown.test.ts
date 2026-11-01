import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { OfficeMarkdown } from "./office-markdown.mjs";
import { OfficeVault } from "./office-vault.ts";
import { OfficeImport } from "./office-import.mjs";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const token = "synthetic-long-image-secret-".repeat(8), key = "synthetic-access-key";
const settings: Record<string, Record<string, string>> = {
  s3: { kind: "s3", endpoint: "https://s3.example.invalid", bucket: "pictures", accessKeyId: key, secretAccessKey: token, publicBase: "https://images.example.invalid" },
  smms: { kind: "smms", token }, github: { kind: "github", token, owner: "fixture", repo: "pictures", branch: "main", dir: "assets" },
};
function fixture(injected: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-markdown-host-"));
  const vault = new OfficeVault(dir, async () => ({ id: "7".repeat(32), key: Buffer.alloc(32, 7) }));
  const markdown = new OfficeMarkdown(dir, { vault, ...injected });
  return { dir, vault, markdown, close() { markdown.close(); vault.close(); rmSync(dir, { force: true, recursive: true }); } };
}
for (const kind of ["s3", "smms", "github"]) it(`encrypts ${kind} keys, reuses saved references and sends the original protocol with the exact picture`, async () => {
  const requests: { url: string; init: any }[] = [];
  const f = fixture({ fetch: async (url: string, init: any) => { requests.push({ url, init }); return new Response(JSON.stringify(kind === "smms" ? { success: true, data: { url: "https://images.example.invalid/image.png" } } : { content: { download_url: "https://images.example.invalid/image.png" } }), { status: 200 }); } });
  try {
    const saved = await f.markdown.write({ imageHost: settings[kind] }, f.markdown.snapshot().revision);
    const raw = readFileSync(f.markdown.path, "utf8");
    expect(raw).toContain("sealed:v1:workbench:"); expect(raw).not.toContain(token); expect(raw).not.toContain(key);
    expect(JSON.stringify(saved.snapshot)).not.toContain(token); expect(JSON.stringify(saved.snapshot)).not.toContain("sealed:v1:");
    const again = await f.markdown.write({ imageHost: { ...saved.snapshot.imageHost, ...(kind === "s3" ? { prefix: "edited" } : {}) } }, saved.snapshot.revision);
    expect(await f.markdown.upload({ base64: png.toString("base64"), ext: "png" })).toMatchObject({ ok: true, url: expect.stringMatching(/^https:\/\//) });
    expect(requests).toHaveLength(1); const { url, init } = requests[0]!;
    if (kind === "s3") { expect(url).toContain("/pictures/edited/"); expect(init.headers.Authorization).toContain(`Credential=${key}/`); expect(Buffer.from(init.body)).toEqual(png); }
    if (kind === "smms") { expect(url).toBe("https://smms.app/api/v2/upload"); expect(init.headers.Authorization).toBe(token); expect(Buffer.from(await ((init.body as FormData).get("smfile") as Blob).arrayBuffer())).toEqual(png); }
    if (kind === "github") { expect(url).toContain("https://api.github.com/repos/fixture/pictures/contents/assets/"); expect(init.headers.Authorization).toBe(`Bearer ${token}`); expect(Buffer.from(JSON.parse(init.body).content, "base64")).toEqual(png); }
    const reopened = new OfficeMarkdown(f.dir, { vault: f.vault });
    expect(reopened.snapshot().revision).toBe(again.snapshot.revision); expect(reopened.snapshot().imageHost?.kind).toBe(kind); reopened.close();
  } finally { f.close(); }
});
it("preserves unknown fields, refuses invalid forms and stale writes, and clears only the chosen host", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, "office")); writeFileSync(f.markdown.path, JSON.stringify({ future: { empty: null, list: ["x"] }, markdownTheme: "nord" }));
    const initial = f.markdown.snapshot(), saved = await f.markdown.write({ imageHost: settings.github }, initial.revision);
    await expect(f.markdown.write({ imageHost: { kind: "s3" } }, saved.snapshot.revision)).rejects.toThrow("필수 항목");
    await expect(f.markdown.write({ markdownTheme: "newsprint" }, initial.revision)).rejects.toThrow("바뀌었습니다");
    const cleared = await f.markdown.write({ imageHost: null }, saved.snapshot.revision);
    expect(cleared.snapshot).toMatchObject({ imageHost: null, markdownTheme: "nord", themeConfigured: true });
    expect(JSON.parse(readFileSync(f.markdown.path, "utf8")).future).toEqual({ empty: null, list: ["x"] });
    writeFileSync(f.markdown.path, "broken json"); expect(() => f.markdown.snapshot()).toThrow("JSON"); expect(readFileSync(f.markdown.path, "utf8")).toBe("broken json");
  } finally { f.close(); }
});
it("rechecks the file after asynchronous key sealing instead of overwriting another settings writer", async () => {
  const f = fixture(); let begin!: () => void, proceed!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { proceed = resolve; });
  const slow = new OfficeMarkdown(f.dir, { vault: { seal: async (plain: string) => { begin(); await gate; return f.vault.seal(plain); } } });
  try {
    const revision = f.markdown.snapshot().revision, write = slow.write({ imageHost: settings.github }, revision);
    const rejected = expect(write).rejects.toThrow("바뀌었습니다"); await started;
    await f.markdown.write({ markdownTheme: "blubook" }, revision); proceed(); await rejected;
    expect(f.markdown.snapshot()).toMatchObject({ imageHost: null, markdownTheme: "blubook" });
  } finally { proceed(); slow.close(); f.close(); }
});
it("returns a safe upload failure for fallback, redacts echoed secrets and honors abort/owner changes", async () => {
  let calls = 0;
  const f = fixture({ fetch: async () => { calls++; return new Response(JSON.stringify({ message: `denied ${token}` }), { status: 403 }); } });
  try {
    await f.markdown.write({ imageHost: settings.github }, f.markdown.snapshot().revision);
    const data = { base64: png.toString("base64"), ext: "png" }, error = await f.markdown.upload(data);
    expect(error.ok).toBe(false); expect(error.error).not.toContain(token.slice(0, 12)); expect(error.error).toContain("GitHub"); expect(error.error).toContain("HTTP 403");
    const c = new AbortController(); c.abort(); expect((await f.markdown.upload(data, c.signal)).ok).toBe(false);
    expect((await f.markdown.upload(data, undefined, () => { throw new Error("view closed"); })).ok).toBe(false);
    expect(calls).toBe(1);
  } finally { f.close(); }
});
it("uses the original remote-image gate and byte MIME detection without granting private or file reads", async () => {
  let calls = 0;
  const f = fixture({ fetch: async () => { calls++; return new Response(new Uint8Array(png), { headers: { "content-type": "application/octet-stream" } }); } });
  try {
    expect(await f.markdown.readImage("file:///etc/passwd")).toBeNull(); expect(await f.markdown.readImage("http://127.0.0.1/private.png")).toBeNull(); expect(calls).toBe(0);
    expect(await f.markdown.readImage("https://93.184.216.34/picture")).toEqual({ base64: png.toString("base64"), mime: "image/png" }); expect(calls).toBe(1);
  } finally { f.close(); }
});
it("imports the selected Markdown theme or host, encrypts backups and preserves source bytes and other settings", async () => {
  const f = fixture(), db = new Store(join(f.dir, "state.sqlite"));
  const manager = new SessionManager(db, new EventBus(), { hostId: "test", hostLabel: "test", managedWorksDir: join(f.dir, "works"), dataDir: f.dir, kordoc: null });
  const importer = new OfficeImport(manager.documents, { find: () => null } as any, f.dir, { vault: f.vault });
  try {
    const source = join(f.dir, "source"); mkdirSync(source); const file = join(source, "markdown-settings.json");
    const original = JSON.stringify({ imageHost: settings.github, markdownTheme: "newsprint", future: "source preserved" }, null, 3); writeFileSync(file, original);
    await f.markdown.write({ imageHost: settings.smms, markdownTheme: "nord" }, f.markdown.snapshot().revision);
    const before = readFileSync(f.markdown.path, "utf8"), preview = importer.inspect(source);
    expect(JSON.stringify(preview)).not.toContain(token); expect(preview.markdown).toEqual({ theme: "newsprint", imageHost: { kind: "github" }, replacesCurrent: true });
    const result = await importer.apply({ id: preview.id, ai: false, keys: false, styles: false, markdownTheme: true });
    expect(result).toMatchObject({ markdownTheme: true, imageHost: false, errors: [] });
    expect(f.markdown.snapshot()).toMatchObject({ markdownTheme: "newsprint", imageHost: { kind: "smms" } });
    const backup = JSON.parse(readFileSync(result.markdownBackup!, "utf8"));
    const restored = Buffer.concat(await Promise.all(backup.chunks.map(async (chunk: string) => Buffer.from(await f.vault.open(chunk), "base64")))).toString("utf8"); expect(restored).toBe(before);
    const next = importer.inspect(source); const host = await importer.apply({ id: next.id, ai: false, keys: false, styles: false, imageHost: true });
    expect(host).toMatchObject({ imageHost: true, markdownTheme: false, errors: [] }); expect(f.markdown.snapshot().imageHost?.kind).toBe("github");
    expect(readFileSync(file, "utf8")).toBe(original); expect(readFileSync(f.markdown.path, "utf8")).not.toContain(token);
    const conflict = importer.inspect(source); writeFileSync(file, `${original}\n`);
    await expect(importer.apply({ id: conflict.id, ai: false, keys: false, styles: false, imageHost: true })).rejects.toThrow("원본 설정");
    expect(existsSync(result.markdownBackup!)).toBe(true);
  } finally { importer.close(); await manager.shutdown(); db.close(); f.close(); }
});
