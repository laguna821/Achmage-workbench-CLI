import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { OfficeFileSearch } from "./office-file-search.mjs";
import { OfficeVault } from "./office-vault.ts";
import { OfficeImport } from "./office-import.mjs";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { SessionManager } from "./sessions.ts";
import { Pkm } from "./pkm.ts";

const key = "synthetic-search-key-".repeat(20);
const config = { rerank: true, endpoint: "custom", keys: { custom: key }, customBaseUrl: "http://127.0.0.1:8009/v1/systemone", customModel: "local-decider" };
const reply = (body: string) => {
  const request = JSON.parse(body), docs = request.state.documents;
  return { status: 200, body: JSON.stringify({ answers: Object.fromEntries(docs.map((doc: { title: string }, i: number) => {
    const score = doc.title === "B.md" ? 2 : 0;
    return [`d${i}`, { type: "score", score, confidence: 1, probabilities: { 0: score === 0 ? 1 : 0, 1: 0, 2: score === 2 ? 1 : 0 } }];
  })) }) };
};
function fixture(send?: (...args: any[]) => Promise<any>) {
  const dir = mkdtempSync(join(tmpdir(), "wb-file-search-")), vault = new OfficeVault(dir, async () => ({ id: "9".repeat(32), key: Buffer.alloc(32, 9) }));
  const service = new OfficeFileSearch(dir, { vault, send }), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "test", hostLabel: "test", managedWorksDir: join(dir, "works"), dataDir: dir, kordoc: null });
  const work = manager.createWork({ title: "Rerank", folderId: null, cwd: join(dir, "project") });
  const write = (name: string, contents: string) => { const path = join(work.cwd, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); return path; };
  return { dir, vault, service, store, bus, manager, work, write, async close() { service.close(); await manager.shutdown(); vault.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
it("seals all endpoint keys, normalizes legacy fields before truncation, preserves saved references and rejects stale writes", async () => {
  const f = fixture();
  try {
    expect(f.service.snapshot().settings.rerank).toBe(false);
    const saved = await f.service.write({ ...config, keys: undefined, jevEndpoint: "direct", endpoint: undefined, jevKeys: { direct: key }, future: "not imported" }, f.service.snapshot().revision);
    expect(saved.snapshot.settings.endpoint).toBe("direct"); expect(JSON.stringify(saved.snapshot)).not.toContain(key);
    const raw = readFileSync(f.service.path, "utf8"); expect(raw).toContain("sealed:v1:workbench:"); expect(raw).not.toContain(key);
    const again = await f.service.write({ ...saved.snapshot.settings, rerank: false }, saved.snapshot.revision);
    expect(again.snapshot.settings.rerank).toBe(false);
    await expect(f.service.write(config, saved.snapshot.revision)).rejects.toThrow("바뀌었습니다");
    writeFileSync(f.service.path, "broken JSON"); expect(() => f.service.snapshot()).toThrow("JSON"); expect(readFileSync(f.service.path, "utf8")).toBe("broken JSON");
    expect(await f.service.rank("교육", ["A", "B"], f.manager.documents, () => true)).toBeNull();
  } finally { await f.close(); }
});
it("runs the original connection probe with a saved key and an unsaved draft without writing it", async () => {
  const calls: any[] = [], f = fixture(async (...args) => { calls.push(args); return reply(args[1]); });
  try {
    const saved = await f.service.write(config, f.service.snapshot().revision), raw = readFileSync(f.service.path, "utf8");
    expect(await f.service.probe({ ...saved.snapshot.settings, customModel: "draft-model" })).toEqual({ ok: true });
    expect(calls).toHaveLength(1); expect(calls[0][0]).toBe(config.customBaseUrl); expect(calls[0][2]).toBe(key); expect(JSON.parse(calls[0][1]).model).toBe("draft-model");
    expect(readFileSync(f.service.path, "utf8")).toBe(raw);
    const aborted = new AbortController(); aborted.abort(); expect((await f.service.probe(saved.snapshot.settings, aborted.signal)).ok).toBe(false); expect(calls).toHaveLength(1);
  } finally { await f.close(); }
});
it("uses original redacted excerpts and ranking, caches unchanged requests, and excludes dirty/unselected files", async () => {
  const calls: string[] = [], f = fixture(async (_url, body) => { calls.push(body); return reply(body); });
  try {
    const a = f.write("A.md", '교육 연구 <span class="redact-span" data-redaction="" data-label="가림">PRIVATE_SEARCH_SECRET</span>'), b = f.write("B.md", "교육 연구 정답"), outside = f.write("Private.md", "OUTSIDE_SECRET");
    const artifact = f.manager.openFile(f.work.id, a), allowed = (path: string) => [a, b].includes(path);
    expect(await f.service.rank("교육 연구", [a, b], f.manager.documents, allowed)).toBeNull(); expect(calls).toHaveLength(0);
    await f.service.write(config, f.service.snapshot().revision);
    const run = () => f.service.rank("교육 연구", [a, b, outside], f.manager.documents, allowed);
    expect((await run())?.order).toEqual([b, a]); expect(calls.join()).not.toContain("PRIVATE_SEARCH_SECRET"); expect(calls.join()).not.toContain("OUTSIDE_SECRET");
    expect((await run())?.order).toEqual([b, a]); expect(calls).toHaveLength(1);
    f.manager.documents.registry.open(artifact.id, { viewId: "dirty", windowId: "window", claim: true, dirty: true });
    expect(await run()).toBeNull(); expect(calls).toHaveLength(1);
    f.manager.documents.registry.open(artifact.id, { viewId: "dirty", windowId: "window", dirty: false });
    writeFileSync(b, "교육 연구 수정된 정답 새로운 내용"); expect((await run())?.order).toEqual([b, a]); expect(calls).toHaveLength(2);
  } finally { await f.close(); }
});
it("falls back when the original endpoint fails or a file changes while the judgement is in flight", async () => {
  let mutate = () => {}, fail = false;
  const f = fixture(async (_url, body) => { mutate(); return fail ? { status: 403, body: key } : reply(body); });
  try {
    const a = f.write("A.md", "교육 연구"), b = f.write("B.md", "교육 연구 정답"); await f.service.write(config, f.service.snapshot().revision);
    mutate = () => writeFileSync(b, "바뀐 파일"); expect(await f.service.rank("교육", [a, b], f.manager.documents, () => true)).toBeNull();
    mutate = () => {}; fail = true; expect(await f.service.rank("새 질문", [a, b], f.manager.documents, () => true)).toBeNull();
    expect(await f.service.probe(f.service.snapshot().settings)).toEqual({ ok: false, error: "HTTP 403" });
  } finally { await f.close(); }
});
it("orders visible document and vault hits without moving conversations, exposing hidden notes or rewriting files", async () => {
  const calls: string[] = [], f = fixture(async (_url, body) => { calls.push(body); return reply(body); });
  const pkm = new Pkm(f.store, f.bus, f.manager);
  try {
    const a = f.write("A.md", "교육 연구"), b = f.write("B.md", "교육 연구 정답"); f.manager.openFile(f.work.id, a); f.manager.openFile(f.work.id, b);
    await f.service.write(config, f.service.snapshot().revision);
    const page = (await f.manager.search("교육 연구", { scope: "document", per: 20, legacy: false })), before = readFileSync(a, "utf8");
    const conversation = { ...page.groups[0]!.hits[0]!, key: "conversation", kind: "assistant" as const, title: "대화 유지" };
    page.groups[0]!.hits.splice(1, 0, conversation);
    const ranked = await f.service.rankPage("교육 연구", page, f.manager);
    expect(ranked.reranked).toBe(true); expect(ranked.groups[0]?.hits[1]).toBe(conversation); expect(ranked.groups[0]?.hits.filter(hit => hit.kind === "document").map(hit => hit.path)).toEqual([b, a]); expect(ranked.total).toBe(page.total); expect(readFileSync(a, "utf8")).toBe(before);
    const vault = join(f.dir, "vault"); mkdirSync(join(vault, ".obsidian"), { recursive: true }); mkdirSync(join(vault, "Hidden"));
    writeFileSync(join(vault, "A.md"), "교육 연구"); writeFileSync(join(vault, "B.md"), "교육 연구 정답"); writeFileSync(join(vault, "Hidden", "Secret.md"), "교육 연구 HIDDEN_NOTE_SECRET");
    mkdirSync(join(vault, ".obsidian/plugins/notebook-navigator"), { recursive: true });
    writeFileSync(join(vault, ".obsidian/plugins/notebook-navigator/data.json"), JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["/Hidden"] }] }));
    pkm.attachVault(vault); await f.manager.finder.useVault(pkm.vault, f.bus);
    const notes = (await f.manager.search("교육 연구", { scope: "vault", per: 20, legacy: false }));
    const rankedNotes = await f.service.rankPage("교육 연구", notes, f.manager);
    expect(rankedNotes.groups[0]?.hits.map(hit => hit.path)).toEqual(["B.md", "A.md"]); expect(rankedNotes.reranked).toBe(true);
    // The finder resolves only actual current note hits, never a caller's arbitrary path.
    const hidden = { ...notes.groups[0]!.hits[0]!, path: "Hidden/Secret.md" };
    expect(f.manager.finder.fileForHit(hidden)).toBeNull();
    expect(calls.join()).not.toContain("HIDDEN_NOTE_SECRET");
  } finally { pkm.close(); await f.close(); }
});
it("selectively imports legacy rerank settings and sealed keys, backs up the destination and preserves source bytes", async () => {
  const f = fixture(), legacyKey = `sealed:v1:legacy:${"x".repeat(1400)}`; let reveal = 0;
  const importer = new OfficeImport(f.manager.documents, { find: () => ({ app: "/synthetic/ieum" }) } as any, f.dir, { vault: f.vault, reveal: async (_app: string, _directory: string, values: string[]) => { reveal++; expect(values).toEqual([legacyKey]); return { [legacyKey]: key }; } });
  try {
    const source = join(f.dir, "source"); mkdirSync(source); const file = join(source, "app-settings.json");
    const original = JSON.stringify({ authorName: "원작자", fileSearch: { ...config, keys: undefined, endpoint: undefined, jevEndpoint: "direct", jevKeys: { direct: legacyKey } }, future: [null, "keep"] }, null, 3); writeFileSync(file, original);
    await f.service.write(config, f.service.snapshot().revision); const before = readFileSync(f.service.path, "utf8");
    const preview = importer.inspect(source); expect(preview.fileSearch).toMatchObject({ endpoint: "direct", sealedKeys: 1 }); expect(JSON.stringify(preview)).not.toContain(legacyKey);
    const result = await importer.apply({ id: preview.id, ai: false, keys: false, styles: false, fileSearch: true, fileSearchKeys: true });
    expect(result).toMatchObject({ fileSearch: true, errors: [] }); expect(reveal).toBe(1); expect(f.service.snapshot().settings.endpoint).toBe("direct");
    const saved = readFileSync(f.service.path, "utf8"); expect(saved).not.toContain(key); expect(saved).toContain("sealed:v1:workbench:"); expect(readFileSync(file, "utf8")).toBe(original);
    const backup = JSON.parse(readFileSync(result.fileSearchBackup!, "utf8")); expect(Buffer.concat(await Promise.all(backup.chunks.map(async (value: string) => Buffer.from(await f.vault.open(value), "base64")))).toString()).toBe(before);
    const next = importer.inspect(source); await importer.apply({ id: next.id, ai: false, keys: false, styles: false, fileSearch: true, fileSearchKeys: false });
    expect(reveal).toBe(1); expect(Object.values(f.service.snapshot().settings.keys).every(value => value === "")).toBe(true);
  } finally { importer.close(); await f.close(); }
});
