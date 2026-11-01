import { afterEach, describe, expect, it } from "vitest";
import { SearchService, type FastFindDocument } from "./search-service.ts";

const services: SearchService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((s) => s.close())); });
const worker = () => { const service = new SearchService(); services.push(service); return service; };
const doc = (key: string, text: string, workId = "work-a"): FastFindDocument => ({ key, revision: 1, mtime: 1, text,
  metadata: { kind: "request", scope: "session", workId }, fields: { title: "" } });

it("reports a missing executable and finishes its owned lifecycle", async () => {
  const service = new SearchService({ binary: "/nonexistent/achmage-search-worker" }); services.push(service);
  await expect(service.start()).rejects.toThrow();
  await expect(service.search("anything")).rejects.toThrow();
  await service.close();
  expect(service.pid).toBeNull();
});

// Run with the built standalone worker, or the installed app's WORKBENCH_APP_BIN.
// Rust protocol tests always run independently of the JS test runner.
describe.skipIf(!process.env.WORKBENCH_SEARCH_WORKER_BIN && !process.env.WORKBENCH_APP_BIN)("real native Fast Find transport", () => {
  it("shares one engine across concurrent UI and CLI requests", async () => {
    const service = worker();
    const starts = await Promise.all([service.start(), service.start()]);
    expect(starts[0].protocol).toBe(1);
    const pid = service.pid;
    await service.upsert([doc("item:a", "alpha body"), doc("item:b", "beta body", "work-b")]);
    const [a, b] = await Promise.all([service.search("alpha"), service.search("beta")]);
    expect(a.hits.map((h) => h.path)).toEqual(["item:a"]);
    expect(b.hits.map((h) => h.path)).toEqual(["item:b"]);
    expect(service.pid).toBe(pid);
    expect((await service.status()).documents).toBe(2);
  });

  it("aborts only one caller and keeps other callers and ordered mutations working", async () => {
    const service = worker(); await service.start();
    const controller = new AbortController();
    const upsert = service.upsert([doc("item:a", "alpha")]);
    const cancelled = service.search("alpha", {}, controller.signal);
    const checked = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    const search = service.search("alpha");
    await upsert; await checked;
    expect((await search).total).toBe(1);
    await service.remove([{ key: "item:a", revision: 2 }]);
    expect((await service.search("alpha")).total).toBe(0);
  });

  it("keeps typed YAML, Unicode ranges, scope and source revisions through JSONL", async () => {
    const service = worker();
    const raw = '---\n"DIKM_단계:": ["🔵 I"]\n"빈값:":\n---\n📝 한글 needle 끝\n';
    const note = doc("note:a.md", raw);
    note.fields = { title: "Readable", properties: [{ key: "DIKM_단계:", values: ["🔵 I"] }, { key: "빈값:", values: [] }] };
    await service.upsert([note]);
    const scope = { workIds: ["work-a"], properties: [{ key: "빈값:" }] };
    const found = await service.search("needle", { scope });
    expect(found.total).toBe(1);
    const excerpt = found.hits[0]!.excerpt!;
    expect(excerpt.ranges.map(([a, b]) => excerpt.text.slice(a, b))).toContain("needle");
    expect(await service.preview(note.key, scope)).toMatchObject({ found: true, text: raw, revision: 1 });
    expect(await service.preview(note.key, { workIds: [] })).toMatchObject({ found: false });
    await service.upsert([{ ...note, revision: 2, text: "replacement" }]);
    await service.upsert([{ ...note, revision: 1 }]);
    expect((await service.search("needle")).total).toBe(0);
  });

  it("rejects one invalid request without corrupting the shared engine", async () => {
    const service = worker();
    await service.upsert([doc("item:a", "alpha")]);
    await expect(service.search("alpha", { limit: 501 })).rejects.toThrow();
    expect((await service.search("alpha")).total).toBe(1);
    await service.close();
    expect(service.pid).toBeNull();
    await expect(service.search("alpha")).rejects.toThrow();
  });

  it("invalidates scoped counts on source changes and never shares them across scopes", async () => {
    const service = worker();
    await service.upsert([doc("item:a", "alpha"), doc("item:b", "beta", "work-b")]);
    const a = { workIds: ["work-a"] };
    expect((await service.search("alpha", { scope: a })).totalDocs).toBe(1);
    expect((await service.search("missing", { scope: a })).totalDocs).toBe(1);
    expect((await service.search("alpha", { scope: { workIds: [] } })).totalDocs).toBe(0);
    expect((await service.search("alpha")).totalDocs).toBe(2);
    await service.upsert([doc("item:c", "alpha")]);
    expect((await service.search("alpha", { scope: a })).totalDocs).toBe(2);
    await service.remove([{ key: "item:a", revision: 2 }]);
    expect((await service.search("alpha", { scope: a })).totalDocs).toBe(1);
  });
});
