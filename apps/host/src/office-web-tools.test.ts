import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeSettings } from "./office-settings.mjs";
import { OfficeVault } from "./office-vault.ts";
import { createOfficeWebTools } from "./office-web-tools.mjs";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture(token = "github-fixture", injected = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wb-web-tools-")); dirs.push(dir);
  const vault = new OfficeVault(dir, async () => ({ id: "7".repeat(32), key: Buffer.alloc(32, 7) }));
  const store = new OfficeSettings(dir, vault), settings = store.snapshot().settings;
  settings.search.provider = "serper"; settings.search.providers.serper.apiKey = "search-fixture";
  settings.readUrl = { githubToken: token };
  await store.write(settings, store.snapshot().revision);
  return { store, tools: createOfficeWebTools(store, injected), before: readFileSync(store.path) };
}
const signal = () => new AbortController().signal;

describe("original Office web tools", () => {
  it("routes the selected sealed search key through the original provider and preserves settings", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json(url.endsWith("/images") ? { images: [{ title: "그림", imageUrl: "https://example.com/picture.png", link: "https://example.com", imageWidth: 400, imageHeight: 300 }] } : { organic: [{ title: "자료", link: "https://example.com", snippet: "검색 본문" }] });
    });
    const f = await fixture();
    expect((await f.tools.invoke("web-search", ["문서", 3], signal()) as any).results[0].title).toBe("자료");
    expect((await f.tools.invoke("image-search", ["그림", 2], signal()) as any).images[0].width).toBe(400);
    expect(calls.map(c => c.url)).toEqual(["https://google.serper.dev/search", "https://google.serper.dev/images"]);
    expect(calls.every(c => new Headers(c.init.headers).get("X-API-KEY") === "search-fixture")).toBe(true);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ q: "문서", num: 3 });
    expect(await f.tools.capabilities()).toMatchObject({ webSearch: { available: true, provider: "serper" }, imageGeneration: { available: false } });
    expect(readFileSync(f.store.path)).toEqual(f.before);
    expect(f.before.toString()).not.toContain("search-fixture");
    expect(JSON.stringify(f.store.publicSettings())).not.toContain("github-fixture");
    f.store.close();
  });

  it("uses request-local decoded GitHub credentials and drops them on a redirect", async () => {
    const calls: { url: string; token: string | null }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), token: new Headers(init?.headers).get("authorization") });
      if (String(url).includes("api.github.com")) return new Response(null, { status: 302, headers: { location: `https://example.com/${randomUUID()}` } });
      return new Response("<html><head><title>자료</title></head><body><article>원본 웹 읽기 본문</article></body></html>", { headers: { "content-type": "text/html" } });
    };
    const injected = { readUrlFetch: fetchImpl };
    const a = await fixture("token-a", injected), b = await fixture("token-b", injected);
    const values = await Promise.all([a, b].map(f => f.tools.invoke("read-url", [`https://github.com/fixture/repo/blob/main/${randomUUID()}.md`], signal())));
    expect(values.every((v: any) => v.ok && v.text.includes("원본 웹 읽기 본문"))).toBe(true);
    expect(calls.filter(c => c.url.includes("api.github.com")).map(c => c.token).sort()).toEqual(["Bearer token-a", "Bearer token-b"]);
    expect(calls.filter(c => c.url.includes("example.com")).every(c => c.token === null)).toBe(true);
    for (const f of [a, b]) { expect(readFileSync(f.store.path)).toEqual(f.before); f.store.close(); }
  });

  it("keeps the original URL and image guards and returns actual image bytes", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetch);
    const f = await fixture();
    expect(await f.tools.invoke("fetch-image", ["https://example.com/image.png"], signal())).toEqual({ base64: "iVBORw==", mime: "image/png" });
    expect(await f.tools.invoke("fetch-image", ["http://127.0.0.1/secret"], signal())).toBeNull();
    expect(await f.tools.invoke("read-url", ["file:///etc/passwd"], signal())).toMatchObject({ ok: false, errorCode: "invalid_url" });
    expect(await f.tools.invoke("read-url", ["http://169.254.169.254/latest"], signal())).toMatchObject({ ok: false, errorCode: "blocked" });
    await expect(f.tools.invoke("fetch-image", ["file:///etc/passwd"], signal())).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1); f.store.close();
  });

  it("stops waiting for an in-flight search and rejects malformed tool requests", async () => {
    let finish!: (v: unknown) => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture("", { webSearch: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
    const controller = new AbortController();
    const pending = f.tools.invoke("web-search", ["문서"], controller.signal);
    await ready; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    finish({ results: [] });
    await expect(f.tools.invoke("web-search", ["문서", 1000], signal())).rejects.toMatchObject({ status: 400 });
    await expect(f.tools.invoke("run-shell", ["id"], signal())).rejects.toMatchObject({ status: 400 });
    f.store.close();
  });
});
