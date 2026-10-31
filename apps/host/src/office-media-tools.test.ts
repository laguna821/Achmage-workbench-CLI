import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeSettings } from "./office-settings.mjs";
import { OfficeVault } from "./office-vault.ts";
import { createOfficeWebTools } from "./office-web-tools.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
const dirs: string[] = [], generated: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const path of generated.splice(0)) rmSync(path, { force: true }); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
async function fixture(injected = {}, context?: Parameters<typeof createOfficeWebTools>[2]) {
  const dir = mkdtempSync(join(tmpdir(), "wb-media-tools-")); dirs.push(dir);
  const store = new OfficeSettings(dir, new OfficeVault(dir, async () => ({ id: "8".repeat(32), key: Buffer.alloc(32, 8) })));
  const settings = store.snapshot().settings;
  settings.media = { imageProvider: "openai", analysisProvider: "openai", videoAnalysisProvider: "gemini", providers: {
    openai: { apiKey: "image-fixture-key", imageModel: "gpt-image-1", analysisModel: "gpt-4o", baseUrl: "https://media.fixture.test/v1" },
    gemini: { apiKey: "video-fixture-key", analysisModel: "gemini-2.5-flash" },
  } };
  await store.write(settings, store.snapshot().revision);
  const path = join(dir, "document", "one.docx"); mkdirSync(join(dir, "document")); writeFileSync(path, "fixture");
  return { dir, store, document: { path }, tools: createOfficeWebTools(store, injected, context), before: readFileSync(store.path) };
}

describe("original Office media engines", () => {
  it("generates with the stored sealed key, fetches the original image cache, and analyzes the actual bytes", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json(url.endsWith("/images/generations") ? { data: [{ b64_json: png }] } : { choices: [{ message: { content: "작은 이미지 분석" } }] });
    });
    const f = await fixture();
    try {
      expect(await f.tools.capabilities()).toMatchObject({ imageGeneration: { available: true, provider: "openai", route: "key" }, imageAnalysis: { available: true, provider: "openai" }, videoAnalysis: { available: true, provider: "gemini" } });
      const result = await f.tools.invoke("generate-image", [{ prompt: "작은 투명 아이콘", aspectRatio: "1:1", transparentBackground: true }], signal(), f.document) as any;
      expect(result.error).toBeUndefined(); generated.push(fileURLToPath(result.url));
      expect(await f.tools.invoke("fetch-image", [result.url], signal())).toEqual({ base64: png, mime: "image/png" });
      expect(await f.tools.invoke("analyze-media", [{ mediaUrls: [result.url], requirements: "무엇이 보이나요?" }], signal(), f.document)).toEqual({ text: "작은 이미지 분석" });
      expect(calls.map(c => c.url)).toEqual(["https://media.fixture.test/v1/images/generations", "https://media.fixture.test/v1/chat/completions"]);
      expect(calls.every(c => new Headers(c.init.headers).get("authorization") === "Bearer image-fixture-key")).toBe(true);
      expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ prompt: "작은 투명 아이콘", background: "transparent", model: "gpt-image-1" });
      expect(JSON.parse(String(calls[1]!.init.body)).messages[0].content[1].image_url.url).toBe(`data:image/png;base64,${png}`);
      expect(readFileSync(f.store.path)).toEqual(f.before); expect(f.before.toString()).not.toContain("image-fixture-key");
      expect(JSON.stringify(f.store.publicSettings())).not.toContain("image-fixture-key");
    } finally { f.store.close(); }
  });

  it("accepts media next to the document and embedded media, while rejecting outside paths, symlinks and missing scope", async () => {
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "분석 완료" } }] })); vi.stubGlobal("fetch", fetch);
    const f = await fixture();
    try {
      const inside = join(f.dir, "document", "picture.png"), outside = join(f.dir, "private.png"), link = join(f.dir, "document", "link.png");
      for (const path of [inside, outside]) writeFileSync(path, Buffer.from(png, "base64")); symlinkSync(outside, link);
      const invoke = (mediaUrls: string[]) => f.tools.invoke("analyze-media", [{ mediaUrls, requirements: "분석" }], signal(), f.document);
      expect(await invoke([inside, `data:image/png;base64,${png}`])).toEqual({ text: "분석 완료" });
      expect(await invoke([outside])).toMatchObject({ error: expect.stringContaining("outside the allowed") });
      expect(await invoke([link])).toMatchObject({ error: expect.stringContaining("outside the allowed") });
      expect(await invoke(["file:///etc/passwd"])).toMatchObject({ error: expect.stringContaining("Not an accessible image") });
      await expect(f.tools.invoke("analyze-media", [{ mediaUrls: [inside], requirements: "분석" }], signal())).rejects.toMatchObject({ status: 400 });
      await expect(invoke(Array(13).fill(inside))).rejects.toMatchObject({ status: 400 });
      await expect(f.tools.invoke("fetch-image", ["file:///etc/passwd"], signal())).rejects.toMatchObject({ status: 400 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { f.store.close(); }
  });

  it("uses the original video route instead of the image provider", async () => {
    const fetch = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: "영상 분석" }] } }] })); vi.stubGlobal("fetch", fetch);
    const f = await fixture();
    try {
      expect(await f.tools.invoke("analyze-media", [{ mediaUrls: ["data:video/mp4;base64,AAAA"], requirements: "영상을 설명" }], signal(), f.document)).toEqual({ text: "영상 분석" });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain("generativelanguage.googleapis.com");
      expect(JSON.stringify(init)).toContain("video-fixture-key");
      expect(JSON.stringify(init)).not.toContain("image-fixture-key");
      expect(String(init.body)).toContain("video/mp4");
    } finally { f.store.close(); }
  });

  it("propagates cancellation to the original provider and never accepts a late response", async () => {
    let started!: () => void, providerSignal: AbortSignal | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      providerSignal = init.signal as AbortSignal;
      providerSignal.addEventListener("abort", () => reject(providerSignal!.reason), { once: true }); started();
    }));
    const f = await fixture(), controller = new AbortController();
    try {
      const pending = f.tools.invoke("generate-image", [{ prompt: "취소 검사" }], controller.signal, f.document);
      await ready; controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(providerSignal?.aborted).toBe(true);
    } finally { f.store.close(); }
  });

  it("keeps a failed Codex subscription request on that route even with a configured paid key", async () => {
    const generate = vi.fn(async () => { throw new Error("subscription quota fixture"); });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const f = await fixture({ codexGenerate: generate }, async () => ({ path: "screen", statuses: { codex: { provider: "codex", state: "ready", meteredAccepted: false } } }));
    try {
      const settings = f.store.snapshot().settings; settings.media!.imageProvider = "codex";
      await f.store.write(settings, f.store.snapshot().revision);
      expect(await f.tools.capabilities()).toMatchObject({ imageGeneration: { available: true, route: "subscription", provider: "codex" } });
      expect(await f.tools.invoke("generate-image", [{ prompt: "한 번만 요청" }], signal(), f.document)).toMatchObject({ error: "subscription quota fixture" });
      expect(generate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    } finally { f.store.close(); }
  });
});
