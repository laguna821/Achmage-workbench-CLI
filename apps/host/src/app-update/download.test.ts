import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadAsset, fetchSmall, updateSource, type Fetch } from "./download.ts";

const payload = Buffer.alloc(300_000, 7);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let server: Server, base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/big.json") { res.end(Buffer.alloc(70_000, 32)); return; }
    if (req.url === "/hop") { res.writeHead(302, { location: "/file.bin" }); res.end(); return; }
    if (req.url === "/away") { res.writeHead(302, { location: "https://evil.example/file.bin" }); res.end(); return; }
    if (req.url === "/file.bin") { res.end(payload); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

describe("source", () => {
  it("the fixed source is GitHub over https; an override is https or this computer only", () => {
    const fixed = updateSource({});
    expect(fixed.base.href).toBe("https://github.com/laguna821/Achmage-workbench-CLI/releases/latest/download/");
    expect(fixed.allowed(new URL("https://objects.githubusercontent.com/x"))).toBe(true);
    expect(fixed.allowed(new URL("https://release-assets.githubusercontent.com/x"))).toBe(true);
    expect(fixed.allowed(new URL("http://github.com/x"))).toBe(false);
    expect(fixed.allowed(new URL("https://github.com.evil.example/x"))).toBe(false);
    expect(fixed.allowed(new URL("https://evil.example/x"))).toBe(false);
    expect(fixed.allowed(new URL("https://user:pw@github.com/x"))).toBe(false);
    expect(fixed.allowed(new URL("https://github.com:8443/x"))).toBe(false);
    expect(() => updateSource({ WORKBENCH_UPDATE_SOURCE: "http://example.com/" })).toThrow();
    expect(updateSource({ WORKBENCH_UPDATE_SOURCE: base }).allowed(new URL("https://github.com/x"))).toBe(false);
  });
});

describe("download", () => {
  const source = () => updateSource({ WORKBENCH_UPDATE_SOURCE: base });
  it("follows a redirect on the same source and keeps the file when size and SHA-256 match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-dl-"));
    const progress: number[] = [];
    const file = await downloadAsset(source(), { name: "file.bin", size: payload.length, sha256: sha(payload) }, join(dir, "file.bin"), { onProgress: f => progress.push(f) });
    expect(readFileSync(file).equals(payload)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    const viaHop = await downloadAsset(source(), { name: "hop", size: payload.length, sha256: sha(payload) }, join(dir, "again.bin"));
    expect(existsSync(viaHop)).toBe(true);
  });
  it("a checksum or size mismatch keeps nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-dl-"));
    await expect(downloadAsset(source(), { name: "file.bin", size: payload.length, sha256: "0".repeat(64) }, join(dir, "file.bin"))).rejects.toThrow("내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다.");
    await expect(downloadAsset(source(), { name: "file.bin", size: payload.length - 1, sha256: sha(payload) }, join(dir, "file.bin"))).rejects.toThrow("게시된 것과 다릅니다");
    expect(readdirSync(dir)).toEqual([]);
  });
  it("a redirect to another host is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-dl-"));
    await expect(downloadAsset(source(), { name: "away", size: payload.length, sha256: sha(payload) }, join(dir, "file.bin"))).rejects.toMatchObject({ code: "source" });
    // From the real source: a GitHub redirect to its download host is followed; one to any other host is not.
    const asked: string[] = [];
    const fake: Fetch = async (input) => {
      const url = String(input); asked.push(url);
      if (url.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: url.endsWith("good.json") ? "https://objects.githubusercontent.com/a" : "https://attacker.example/a" } });
      return new Response("{}", { status: 200 });
    };
    expect((await fetchSmall(updateSource({}), "good.json", 100, fake)).toString()).toBe("{}");
    await expect(fetchSmall(updateSource({}), "bad.json", 100, fake)).rejects.toMatchObject({ code: "source" });
    expect(asked).not.toContain("https://attacker.example/a");
  });
  it("an oversized small file, a missing file and no network are each refused with their own sentence", async () => {
    await expect(fetchSmall(source(), "big.json", 64 * 1024)).rejects.toMatchObject({ code: "size" });
    await expect(fetchSmall(source(), "missing.json", 1024)).rejects.toThrow("GitHub가 업데이트 정보를 제대로 주지 않았습니다");
    const offline: Fetch = async () => { throw new TypeError("fetch failed"); };
    await expect(fetchSmall(updateSource({}), "update.json", 1024, offline)).rejects.toThrow("인터넷에 연결되지 않았습니다");
  });
  it("not enough room is said before anything is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-dl-"));
    await expect(downloadAsset(source(), { name: "file.bin", size: payload.length, sha256: sha(payload) }, join(dir, "file.bin"), { roomFactor: 1e12 })).rejects.toThrow("저장 공간이 부족합니다");
  });
});
