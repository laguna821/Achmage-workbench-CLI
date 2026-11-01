import { afterEach, describe, expect, it } from "vitest";
import { type IndexEntry } from "./search-index.ts";
import { SearchProjection, searchChunks } from "./search-projection.ts";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  const store = new Store(":memory:");
  const index = store.search;
  const projection = new SearchProjection(index, () => ({ provider: "codex" }));
  cleanups.push(async () => { await projection.close(); store.close(); });
  return { index, projection, service: projection.service };
}
const entry = (key: string, body: string): IndexEntry => ({ key, kind: "user", scope: "session", workId: "a", sessionId: "s", title: "", body, at: 1 });

it("keeps long raw source and exact YAML keys/shapes in the derived cache", () => {
  const { index } = fixture();
  const body = "앞부분 ".repeat(45_000) + "마지막 확인값 📝";
  const properties: NonNullable<IndexEntry["properties"]> = [["DIKM_단계:", ["🔵 I"]], ["빈값:", null], ["빈목록:", []]];
  index.put({ ...entry("item:a", body), properties });
  expect(index.cached()[0]).toMatchObject({ body, fields: { properties } });
  expect(index.put({ ...entry("item:a", body + " changed"), properties })).toBe(true);
  expect(index.cached()[0]!.body).toBe(body + " changed");
  const chunks = searchChunks(body);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.text).toBe(body.slice(chunk.offset, chunk.offset + chunk.text.length));
    expect(chunk.text.length).toBeLessThanOrEqual(48_000);
    expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text)).toBe(false);
  }
  expect(chunks.at(-1)!.text).toContain("마지막 확인값");
});

describe.skipIf(!process.env.WORKBENCH_SEARCH_WORKER_BIN && !process.env.WORKBENCH_APP_BIN)("native cache projection", () => {
  it("keeps source identities and removes stale chunks after edit, rollback and delete", async () => {
    const { index, projection, service } = fixture();
    const body = "자료 문단입니다.\n\n".repeat(25_000) + "끝부분 고유확인값";
    index.put(entry("item:long", body));
    await projection.settled();
    const found = await service.search("고유확인값");
    expect(found.total).toBe(1);
    expect(projection.source(found.hits[0]!.path)?.source).toBe("item:long");
    expect(projection.source(found.hits[0]!.path)!.offset).toBeGreaterThan(200_000);
    expect((await service.search("자료")).total).toBe(1); // overlaps do not inflate totals
    expect(() => index.transaction(() => { index.put(entry("item:long", "rolledbacksecret")); throw new Error("rollback"); })).toThrow("rollback");
    await projection.flush();
    expect((await service.search("rolledbacksecret")).total).toBe(0);
    expect((await service.search("고유확인값")).total).toBe(1);
    index.put(entry("item:long", "replacement"));
    await projection.flush();
    expect((await service.search("고유확인값")).total).toBe(0);
    expect((await service.status()).documents).toBe(1);
    index.remove("item:long"); await projection.flush();
    expect((await service.status()).documents).toBe(0);
  });

  it("replays committed updates during bootstrap and survives a derived-cache rebuild", async () => {
    const { index, projection, service } = fixture();
    index.transaction(() => { for (let n = 0; n < 1200; n++) index.put(entry(`item:${n}`, "oldvalue")); });
    await projection.ready();
    expect(projection.state().phase).toBe("indexing");
    index.put(entry("item:3", "earlychange")); index.put(entry("item:1199", "latechange"));
    index.remove("item:7");
    await projection.settled();
    expect((await service.search("earlychange")).total).toBe(1);
    expect((await service.search("latechange")).total).toBe(1);
    expect((await service.status()).documents).toBe(1199);
    index.transaction(() => { index.clear(); index.put(entry("item:new", "rebuilt")); });
    await projection.flush();
    expect((await service.search("oldvalue")).total).toBe(0);
    expect((await service.search("rebuilt")).total).toBe(1);
  });
});
