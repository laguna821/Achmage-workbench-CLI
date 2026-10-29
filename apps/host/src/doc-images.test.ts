import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { createHttpServer } from "./http.ts";
import { altText, amzDate, DocImages, imageType, normalizePrefix, parseAccount, resolveDocImage, signingKey, signV4 } from "./doc-images.ts";
import { HttpError } from "./errors.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// Images pasted into Markdown documents: SigV4 as AWS documents it, R2 settings that never come
// back whole, uploads with a work-folder fallback, and previews that stay inside the work folder.

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);

describe("SigV4 (AWS published examples)", () => {
  // AWS General Reference, "Examples of how to derive a signing key for Signature Version 4".
  it("derives the signing key", () => {
    expect(signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam").toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });

  // The S3 API reference, "Signature Calculations for the Authorization Header", examples.
  const s3 = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3" };
  const host = "examplebucket.s3.amazonaws.com";

  it("signs GET Object", () => {
    const signed = signV4({
      ...s3,
      method: "GET",
      path: "/test.txt",
      headers: { Host: host, Range: "bytes=0-9", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
      payloadHash: EMPTY,
    });
    expect(sha256(signed.canonicalRequest)).toBe("7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");
    expect(signed.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signs PUT Object, encoding the key once", () => {
    const body = "Welcome to Amazon S3.";
    const signed = signV4({
      ...s3,
      method: "PUT",
      path: "/test$file.text",
      headers: {
        Host: host,
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": sha256(body),
      },
      payloadHash: sha256(body),
    });
    expect(signed.canonicalRequest.split("\n")[1]).toBe("/test%24file.text");
    expect(signed.signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("signs GET Bucket with a query", () => {
    const signed = signV4({
      ...s3,
      method: "GET",
      path: "/",
      query: [
        ["prefix", "J"],
        ["max-keys", "2"],
      ],
      headers: { host, "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
      payloadHash: EMPTY,
    });
    expect(signed.canonicalRequest.split("\n")[2]).toBe("max-keys=2&prefix=J");
    expect(signed.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  // The SigV4 test suite's "get-vanilla".
  it("signs the test suite's plain GET", () => {
    const signed = signV4({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "service",
      method: "GET",
      path: "/",
      headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
      payloadHash: EMPTY,
    });
    expect(signed.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("formats the request time", () => {
    expect(amzDate(new Date(Date.UTC(2026, 9, 28, 21, 5, 9, 123)))).toBe("20261028T210509Z");
  });
});

/** A stand-in for the bucket's S3 API and its public address. */
async function fakeR2(options: { secret?: string; publicMissing?: boolean } = {}) {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const seen: { method: string; path: string; authorization: string; signedOk: boolean }[] = [];
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await read(req);
    if (url.pathname.startsWith("/public/")) {
      const object = options.publicMissing ? undefined : objects.get(decodeURIComponent(url.pathname.slice(8)));
      res.writeHead(object ? 200 : 404, { "content-type": object?.type ?? "text/plain" });
      return res.end(object?.body ?? "missing");
    }
    // Check the signature the way R2 would, with the secret it knows.
    const authorization = String(req.headers.authorization ?? "");
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? [];
    const headers = Object.fromEntries(signedHeaders.map((name) => [name, String(req.headers[name] ?? "")]));
    const expected = signV4({
      method: req.method ?? "",
      path: decodeURIComponent(url.pathname),
      headers,
      payloadHash: String(req.headers["x-amz-content-sha256"]),
      accessKeyId: "a".repeat(32),
      secretAccessKey: options.secret ?? "s".repeat(64),
      region: "auto",
      service: "s3",
    });
    const signedOk = authorization === expected.authorization && sha256(body) === req.headers["x-amz-content-sha256"];
    seen.push({ method: req.method ?? "", path: url.pathname, authorization, signedOk });
    if (!signedOk) {
      res.writeHead(403, { "content-type": "application/xml" });
      return res.end("<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>");
    }
    const key = decodeURIComponent(url.pathname).replace(/^\/[^/]+\//, "");
    if (req.method === "PUT") objects.set(key, { body, type: String(req.headers["content-type"] ?? "") });
    if (req.method === "DELETE") objects.delete(key);
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, objects, seen };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function setup(endpoint: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "wb-doc-images-"));
  const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
  const work = manager.createWork({ title: "글", cwd: join(dir, "project") });
  mkdirSync(join(work.cwd, "강의"), { recursive: true });
  writeFileSync(join(work.cwd, "메모.md"), "# 메모\n");
  writeFileSync(join(work.cwd, "강의", "1주차.md"), "# 1주차\n");
  writeFileSync(join(work.cwd, "표.docx"), "PK");
  const images = new DocImages({ dataDir: dir, documents: manager.documents, workCwd: (id) => manager.workCwd(id), endpoint });
  return {
    dir,
    manager,
    cwd: work.cwd,
    images,
    note: manager.openFile(work.id, "메모.md"),
    lesson: manager.openFile(work.id, "강의/1주차.md"),
  };
}

const R2 = { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "a".repeat(32), secretAccessKey: "s".repeat(64), bucket: "notes-img" };

describe("R2 settings", () => {
  it("are kept in a file only this user can read, and never come back whole", () => {
    const { dir, images } = setup();
    expect(images.view()).toMatchObject({ configured: false, secretSet: false, accessKeyHint: null });
    const view = images.save({ ...R2, accessKeyId: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", publicBaseUrl: "https://pub-abc.r2.dev/", keyPrefix: "workbench" });
    expect(view).toMatchObject({ configured: true, secretSet: true, accessKeyHint: "1a2b…5c6d", publicBaseUrl: "https://pub-abc.r2.dev", keyPrefix: "workbench/" });
    const shown = JSON.stringify(view);
    expect(shown).not.toContain("s".repeat(64));
    expect(shown).not.toContain("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d");
    expect(statSync(join(dir, "image-upload.json")).mode & 0o777).toBe(0o600);
    // Changing the bucket without typing the keys again keeps them.
    expect(images.save({ bucket: "other-bucket", secretAccessKey: "", accessKeyId: "" })).toMatchObject({ configured: true, bucket: "other-bucket", accessKeyHint: "1a2b…5c6d" });
    expect(JSON.parse(readFileSync(join(dir, "image-upload.json"), "utf8")).secretAccessKey).toBe("s".repeat(64));
    expect(images.clear()).toMatchObject({ configured: false, secretSet: false });
  });

  it("refuse what cannot work, saying why", () => {
    const { images } = setup();
    expect(() => images.save({ ...R2, accountId: "my-account", publicBaseUrl: "https://pub-abc.r2.dev" })).toThrow(/계정 ID/);
    expect(() => images.save({ ...R2, bucket: "Notes_Img", publicBaseUrl: "https://pub-abc.r2.dev" })).toThrow(/버킷/);
    expect(() => images.save({ ...R2, publicBaseUrl: "pub-abc.r2.dev" })).toThrow(/공개 주소/);
    expect(() => images.save({ ...R2, publicBaseUrl: `https://${R2.accountId}.r2.cloudflarestorage.com/notes-img` })).toThrow(/S3 API/);
    expect(() => images.save({ ...R2, publicBaseUrl: "https://pub-abc.r2.dev", keyPrefix: "../x" })).toThrow(HttpError);
  });

  it("take the account (and bucket) from the S3 API address the dashboard shows", () => {
    expect(parseAccount(`https://${R2.accountId.toUpperCase()}.r2.cloudflarestorage.com/notes-img`)).toEqual({ accountId: R2.accountId, bucket: "notes-img" });
    expect(parseAccount(`${R2.accountId}.eu.r2.cloudflarestorage.com`)).toEqual({ accountId: `${R2.accountId}.eu`, bucket: null });
    expect(normalizePrefix("/img//2026")).toBe("img/2026/");
    expect(normalizePrefix("")).toBe("");
  });
});

describe("images in Markdown documents", () => {
  it("are kept in the work folder by content and linked relatively without R2", async () => {
    const { cwd, images, note, lesson } = setup();
    const first = await images.upload(note.id, PNG, "강의 도식.png");
    const name = `${sha256(PNG).slice(0, 16)}.png`;
    expect(first).toEqual({ markdown: `![강의 도식](assets/${name})`, url: `assets/${name}`, alt: "강의 도식", stored: "local" });
    expect(readFileSync(join(cwd, "assets", name))).toEqual(PNG);
    // From a document in a subfolder: the same file, one level up.
    expect((await images.upload(lesson.id, PNG, "image.png")).url).toBe(`../assets/${name}`);
    await expect(images.upload(note.id, Buffer.from("<html></html>"), "page.html")).rejects.toThrow(/그림 파일/);
  });

  it("show in the preview only from inside the work folder", async () => {
    const { cwd, dir, images, note, lesson } = setup();
    const { url } = await images.upload(lesson.id, PNG, "x.png");
    expect(images.image(lesson.id, url).file).toBe(join(cwd, "assets", url.split("/").pop()!));
    expect(images.image(note.id, encodeURI(`assets/${url.split("/").pop()}`)).type).toBe("image/png");
    writeFileSync(join(dir, "secret.png"), PNG);
    writeFileSync(join(cwd, "notes.txt"), "text");
    mkdirSync(join(cwd, ".workbench"), { recursive: true });
    writeFileSync(join(cwd, ".workbench", "pinned.png"), PNG);
    symlinkSync(join(dir, "secret.png"), join(cwd, "link.png"));
    for (const src of ["../secret.png", "/etc/passwd", `file://${dir}/secret.png`, "https://example.com/a.png", "notes.txt", ".workbench/pinned.png", "link.png", "%2E%2E/secret.png", "missing.png"]) {
      expect(() => images.image(note.id, src), src).toThrow(HttpError);
    }
    expect(() => resolveDocImage(cwd, join(cwd, "메모.md"), "assets/../../secret.png")).toThrow(/밖/);
  });

  it("go to R2 when it is set up, and to the work folder when R2 refuses", async () => {
    const r2 = await fakeR2();
    const { images, note, cwd } = setup(r2.url);
    images.save({ ...R2, publicBaseUrl: `${r2.url}/public`, keyPrefix: "workbench" });
    const result = await images.upload(note.id, PNG, "도식.png");
    const key = `workbench/${sha256(PNG).slice(0, 16)}.png`;
    expect(result).toEqual({ markdown: `![도식](${r2.url}/public/${key})`, url: `${r2.url}/public/${key}`, alt: "도식", stored: "r2" });
    expect(r2.objects.get(key)).toEqual({ body: PNG, type: "image/png" });
    expect(r2.seen[0]).toMatchObject({ method: "PUT", path: `/notes-img/${key}`, signedOk: true });
    expect(r2.seen[0]!.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=a{32}\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);

    // A wrong secret: R2 refuses, the image is kept in the work folder and the reason comes along.
    images.save({ secretAccessKey: "w".repeat(64) });
    const kept = await images.upload(note.id, PNG, "도식.png");
    expect(kept).toMatchObject({ stored: "local", url: `assets/${sha256(PNG).slice(0, 16)}.png`, fallback: "비밀 액세스 키가 맞지 않습니다." });
    expect(readFileSync(join(cwd, kept.url))).toEqual(PNG);
  });

  it("check the connection by writing, reading at the public address and deleting", async () => {
    const r2 = await fakeR2();
    const { images } = setup(r2.url);
    const check = await images.check({ ...R2, publicBaseUrl: `${r2.url}/public` });
    expect(check.ok).toBe(true);
    expect(check.steps.map((step) => [step.step, step.ok])).toEqual([
      ["upload", true],
      ["public", true],
      ["cleanup", true],
    ]);
    expect(r2.objects.size).toBe(0);
    // Not saved by a check.
    expect(images.view().configured).toBe(false);

    const hidden = await fakeR2({ publicMissing: true });
    const { images: other } = setup(hidden.url);
    const failed = await other.check({ ...R2, publicBaseUrl: `${hidden.url}/public` });
    expect(failed.ok).toBe(false);
    expect(failed.steps.find((step) => step.step === "public")?.message).toMatch(/공개 주소에서 열리지 않습니다/);
    expect((await other.check({ ...R2, secretAccessKey: "w".repeat(64), publicBaseUrl: `${hidden.url}/public` })).steps).toEqual([
      { step: "upload", ok: false, message: "비밀 액세스 키가 맞지 않습니다." },
    ]);
    expect((await other.check({})).steps[0]).toMatchObject({ step: "settings", ok: false });
  });

  it("know an image by its bytes and name it by its file", () => {
    expect(imageType(PNG)?.ext).toBe(".png");
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.mime).toBe("image/jpeg");
    expect(imageType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.ext).toBe(".svg");
    expect(imageType(Buffer.from("GIF89a......"))?.ext).toBe(".gif");
    expect(imageType(Buffer.from("hello world, not an image"))).toBeNull();
    expect(altText("Screenshot [1].png")).toBe("Screenshot 1");
    expect(altText("")).toBe("image");
  });
});

/** A stand-in for the CMDS Eagle Worker of the user's note: POST /upload (Bearer key, multipart "file"), GET /health. */
async function fakeWorker(key = "k-secret") {
  const stored = new Map<string, { body: Buffer; type: string; filename: string }>();
  const seen: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://x");
    seen.push(`${req.method} ${url.pathname}`);
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const authorized = String(req.headers.authorization ?? "") === `Bearer ${key}`;
    if (url.pathname === "/health") return authorized ? reply(200, { success: true, message: "OK" }) : reply(401, { success: false, message: "Unauthorized" });
    if (url.pathname !== "/upload" || req.method !== "POST") return reply(404, { success: false, message: "Not Found" });
    if (!authorized) return reply(401, { success: false, message: "Unauthorized" });
    const form = await new Request("http://x/upload", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: Buffer.concat(chunks) }).formData();
    const file = form.get("file") as File;
    const name = `images/${stored.size + 1}-${String(form.get("filename"))}`;
    stored.set(name, { body: Buffer.from(await file.arrayBuffer()), type: String(form.get("content_type")), filename: String(form.get("filename")) });
    reply(200, { success: true, key: name, url: `https://pub-test.r2.dev/${name}`, publicUrl: `https://pub-test.r2.dev/${name}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stored, seen };
}

describe("pictures through the CMDS Eagle Worker", () => {
  it("take the plugin's three values, keep the key on this computer only, and never send it back", () => {
    const { dir, images } = setup();
    expect(images.view()).toMatchObject({ configured: false, mode: "worker", apiKeySet: false });
    const view = images.save({ mode: "worker", workerUrl: "https://obsidian-eagle-uploader.me.workers.dev/upload/", apiKey: "k-secret", publicBaseUrl: "https://pub-test.r2.dev/" });
    expect(view).toMatchObject({ configured: true, mode: "worker", workerUrl: "https://obsidian-eagle-uploader.me.workers.dev", apiKeySet: true, publicBaseUrl: "https://pub-test.r2.dev" });
    expect(JSON.stringify(view)).not.toContain("k-secret");
    expect(statSync(join(dir, "image-upload.json")).mode & 0o777).toBe(0o600);
    // Other fields change without typing the key again.
    expect(images.save({ mode: "worker", workerUrl: "obsidian-eagle-uploader.me.workers.dev", apiKey: "" })).toMatchObject({ configured: true, apiKeySet: true });
    expect(() => images.save({ mode: "worker", workerUrl: "", apiKey: "x" })).toThrow(/Worker 주소/);
    expect(() => images.clear() && images.save({ mode: "worker", workerUrl: "https://a.workers.dev", apiKey: "" })).toThrow(/API Key/);
  });

  it("upload as the plugin does, link the Worker's address, send the same picture once, and fall back when refused", async () => {
    const worker = await fakeWorker();
    const { images, note } = setup();
    images.save({ mode: "worker", workerUrl: worker.url, apiKey: "k-secret" });
    const result = await images.upload(note.id, PNG, "도식.png");
    const name = `${sha256(PNG).slice(0, 16)}.png`;
    expect(result).toEqual({ markdown: `![도식](https://pub-test.r2.dev/images/1-${name})`, url: `https://pub-test.r2.dev/images/1-${name}`, alt: "도식", stored: "r2" });
    expect(worker.stored.get(`images/1-${name}`)).toEqual({ body: PNG, type: "image/png", filename: name });
    // The same picture again: linked to what was sent, nothing uploaded.
    expect((await images.upload(note.id, PNG, "다시.png")).url).toBe(result.url);
    expect(worker.seen.filter((line) => line === "POST /upload")).toHaveLength(1);
    // A wrong key: kept in the work folder, with the reason.
    images.save({ mode: "worker", apiKey: "wrong" });
    const other = Buffer.concat([PNG, Buffer.from([0])]);
    expect(await images.upload(note.id, other, "또.png")).toMatchObject({ stored: "local", fallback: expect.stringMatching(/API Key/) });
  });

  it("check the Worker by its /health with the key", async () => {
    const worker = await fakeWorker();
    const { images } = setup();
    expect(await images.check({ mode: "worker", workerUrl: worker.url, apiKey: "k-secret" })).toEqual({ ok: true, steps: [{ step: "worker", ok: true, message: expect.stringMatching(/API Key를 받았습니다/) }] });
    expect(await images.check({ mode: "worker", workerUrl: worker.url, apiKey: "nope" })).toMatchObject({ ok: false, steps: [{ step: "worker", ok: false, message: expect.stringMatching(/UPLOAD_API_KEY/) }] });
    expect(await images.check({ mode: "worker", workerUrl: "http://127.0.0.1:9", apiKey: "k" })).toMatchObject({ ok: false });
  });
});

describe("the gateway's picture routes", () => {
  it("answer only with the app's token, and serve no file outside the work folder", async () => {
    const { manager, images, note } = setup();
    const server = createHttpServer(manager, new EventBus(), { token: "app-token", webDir: null, docImages: images });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: "Bearer app-token" };
    expect((await fetch(`${base}/api/image-upload`)).status).toBe(401);
    expect((await fetch(`${base}/api/clipboard/picture`)).status).toBe(401);
    expect((await fetch(`${base}/api/artifacts/${note.id}/images`, { method: "POST", body: new Uint8Array(PNG) })).status).toBe(401);
    expect(await (await fetch(`${base}/api/image-upload`, { headers: auth })).json()).toMatchObject({ configured: false, secretSet: false });
    const saved = await fetch(`${base}/api/artifacts/${note.id}/images`, { method: "POST", headers: { ...auth, "x-file-name": encodeURIComponent("도식.png") }, body: new Uint8Array(PNG) });
    const result = (await saved.json()) as { url: string; alt: string };
    expect([saved.status, result.alt]).toEqual([201, "도식"]);
    const shown = await fetch(`${base}/api/artifacts/${note.id}/asset?src=${encodeURIComponent(result.url)}`, { headers: auth });
    expect([shown.status, shown.headers.get("content-type"), shown.headers.get("x-content-type-options")]).toEqual([200, "image/png", "nosniff"]);
    expect(Buffer.from(await shown.arrayBuffer())).toEqual(PNG);
    expect((await fetch(`${base}/api/artifacts/${note.id}/asset?src=${encodeURIComponent("../state.sqlite")}`, { headers: auth })).status).toBe(403);
  });
});
