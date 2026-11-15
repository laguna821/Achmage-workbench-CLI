import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialsState } from "@workbench/contracts";
import { openKit, until } from "../channels/test-kit.ts";
import { HttpError } from "../errors.ts";
import { OfficeVault } from "../office-vault.ts";
import { installScrubber } from "./install.ts";
import { CredentialService, HANDOFF_TTL, continuationId, continuationText } from "./service.ts";

// Made-up values only.
const PASSWORD = "zz-secret-pass-0003";
const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(dir = mkdtempSync(join(tmpdir(), "wb-credsvc-")), clock = { now: Date.now() }) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const k = openKit(dir, clock);
  const vault = new OfficeVault(k.dataDir, async () => ({ id: "c".repeat(32), key: Buffer.alloc(32, 7) }));
  const service = new CredentialService({ dataDir: k.dataDir, vault, manager: k.manager, now: () => clock.now });
  installScrubber(k.store, k.manager, service.scrubber);
  closers.push(async () => { service.close(); await k.manager.shutdown(); k.store.close(); });
  const work = k.manager.view.works.size ? [...k.manager.view.works.values()][0]! : k.manager.createWork({ title: "도서관", titleSource: "user" });
  const session = [...k.manager.view.sessions.values()][0] ?? k.manager.createSession(work.id, { provider: "claude", access: "full" });
  return { ...k, dir, clock, service, session };
}
const need = ["need", "--name", "학술정보원", "--kind", "login", "--site", "https://lib.example.ac.kr", "--fields", "아이디,비밀번호"];
const continuations = (k: ReturnType<typeof setup>) => k.engine.sent.filter((entry) => entry.requestId.startsWith("cont:") || entry.text.includes("[자동 이어 하기]"));

describe("workbench-credential", () => {
  it("answers only ok or a fixed failure, and names entries without their values", async () => {
    const k = setup();
    expect(await k.service.run(k.session.id, ["list"])).toMatchObject({ code: 0, stdout: "(비어 있음)\n" });
    expect(await k.service.run(k.session.id, ["fill", "--name", "x"])).toMatchObject({ code: 1, stdout: "fail:not_available_yet\n" });
    expect(await k.service.run(k.session.id, ["mcp"])).toMatchObject({ stdout: "fail:not_available_yet\n" });
    expect(await k.service.run(k.session.id, ["need", "--kind", "login"])).toMatchObject({ stdout: "fail:bad_arguments\n" });
    expect(await k.service.run(k.session.id, ["need", "--name", "x", "--kind", "bank"])).toMatchObject({ stdout: "fail:bad_arguments\n" });
    expect(await k.service.run(k.session.id, ["rm", "-rf"])).toMatchObject({ stdout: "fail:bad_arguments\n" });
    expect(await k.service.run("no-such-session", need)).toMatchObject({ stdout: "fail:unknown_session\n" });
    await k.service.add({ name: "노션키", kind: "api-key", site: "notion.so", values: { 키: PASSWORD } });
    const listed = await k.service.run(k.session.id, ["list"]);
    expect(listed.stdout).toBe("노션키\tapi-key\tnotion.so\n");
  });

  it("asks for a hand-over once, then answers ok at once when the entry exists (no message)", async () => {
    const k = setup();
    expect(await k.service.run(k.session.id, need)).toMatchObject({ code: 1, stdout: "fail:handover_sent\n" });
    expect(await k.service.run(k.session.id, need)).toMatchObject({ stdout: "fail:handover_waiting\n" });
    expect(k.service.state().waiting).toMatchObject([{ name: "학술정보원", fields: ["아이디", "비밀번호"], mode: "give", inChat: false, sessionLabel: "「도서관」 › 「대화 1」" }]);
    await k.service.add({ name: "학술정보원", kind: "login", site: "lib.example.ac.kr", values: { 아이디: "zz-secret-user-0003", 비밀번호: PASSWORD } });
    expect(k.service.state().waiting).toEqual([]);
    expect(await k.service.run(k.session.id, need)).toEqual({ code: 0, stdout: "ok\n", stderr: "" });
  });

  it("adding at the PC continues the waiting conversation with one request, by its fixed id and words", async () => {
    const k = setup();
    await k.service.run(k.session.id, need);
    const [waiting] = k.service.state().waiting;
    await k.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0003", 비밀번호: PASSWORD } });
    await until(() => continuations(k).length === 1);
    const items = k.manager.items(k.session.id).items;
    expect(items.find((item) => item.id === `user:${continuationId(waiting!.id)}`)).toMatchObject({ kind: "user", text: continuationText("학술정보원") });
    // Asked to go on again (a retry, the same name added twice): still one.
    await k.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0003", 비밀번호: PASSWORD } });
    expect(continuations(k)).toHaveLength(1);
  });

  it("puts the continuation in the queue of a busy conversation; it leaves the queue only when its user item is written", async () => {
    const k = setup();
    await k.service.run(k.session.id, need);
    await k.manager.send(k.session.id, "busy-1", "다른 일");
    const [waiting] = k.service.state().waiting;
    await k.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0003", 비밀번호: PASSWORD } });
    const id = continuationId(waiting!.id);
    expect(k.manager.view.sessions.get(k.session.id)!.queued.map((entry) => entry.id)).toEqual([id]);
    expect(k.manager.items(k.session.id).items.some((item) => item.id === `user:${id}`)).toBe(false);
    k.engine.finish(k.session.id);
    await until(() => k.manager.items(k.session.id).items.some((item) => item.id === `user:${id}`));
    expect(k.manager.view.sessions.get(k.session.id)!.queued).toEqual([]);
    expect(continuations(k)).toHaveLength(1);
  });

  it("is inserted once across a restart: a continuation not recorded as sent is sent again by its id, and taken once", async () => {
    const k = setup();
    await k.service.run(k.session.id, need);
    const [waiting] = k.service.state().waiting;
    // The gateway stopped right after the entry was kept and the hand-over marked ready, before the continuation was recorded.
    await k.service.receive(waiting!.id, "아이디", "zz-secret-user-0003", "ev-1");
    await k.service.receive(waiting!.id, "비밀번호", PASSWORD, "ev-2");
    k.service.store.finish(waiting!.id, { state: "ready", doneAt: k.clock.now });
    expect(continuations(k)).toHaveLength(0);
    await k.service.start();
    await until(() => continuations(k).length === 1);
    // The continuation went out, but the gateway stopped before writing that down: started again, it is not sent twice.
    k.service.store.updateHandoff(waiting!.id, { continued: null });
    k.service.close();
    await k.service.start();
    expect(continuations(k)).toHaveLength(1);
    expect(k.service.handoff(waiting!.id)).toMatchObject({ state: "ready", continued: "queued" });
  });

  it("continues nothing in an archived conversation", async () => {
    const k = setup();
    await k.service.run(k.session.id, need);
    const [waiting] = k.service.state().waiting;
    k.manager.updateSession(k.session.id, { archived: true });
    await k.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0003", 비밀번호: PASSWORD } });
    expect(continuations(k)).toHaveLength(0);
    expect(k.service.handoff(waiting!.id)).toMatchObject({ state: "ready", continued: "refused" });
    expect(await k.service.run(k.session.id, need)).toMatchObject({ stdout: "fail:archived\n" });
  });

  it("ends a hand-over that waited a day", async () => {
    const k = setup();
    await k.service.run(k.session.id, need);
    const [waiting] = k.service.state().waiting;
    k.clock.now += HANDOFF_TTL + 1;
    await k.service.tick();
    expect(k.service.handoff(waiting!.id)).toMatchObject({ state: "expired" });
    expect(k.service.state().waiting).toEqual([]);
    // Asked again later: a new hand-over.
    expect(await k.service.run(k.session.id, need)).toMatchObject({ stdout: "fail:handover_sent\n" });
  });

  it("매번 묻기: asks before each use; 쓰기 continues and allows one use, 안 쓰기 continues nothing", async () => {
    const k = setup();
    const entry = await k.service.add({ name: "카드 1", kind: "card", site: "", values: { 카드번호: "4000123412341234" } });
    k.service.store.setAsk(entry.id, true);
    const card = ["need", "--name", "카드 1", "--kind", "card"];
    expect(await k.service.run(k.session.id, card)).toMatchObject({ stdout: "fail:handover_sent\n" });
    const [asked] = k.service.state().waiting;
    expect(asked).toMatchObject({ mode: "use", name: "카드 1" });
    await k.service.allow(asked!.id, true);
    await until(() => continuations(k).length === 1);
    expect(await k.service.run(k.session.id, card)).toMatchObject({ stdout: "ok\n" });
    expect(await k.service.use("카드 1", k.session.id)).toEqual({ 카드번호: "4000123412341234" });
    // The leave is spent: the next use asks again.
    await expect(k.service.use("카드 1", k.session.id)).rejects.toMatchObject({ code: "credential_needs_leave" });
    expect(await k.service.run(k.session.id, card)).toMatchObject({ stdout: "fail:handover_sent\n" });
    const [again] = k.service.state().waiting;
    await k.service.allow(again!.id, false);
    expect(k.service.handoff(again!.id)).toMatchObject({ state: "declined" });
    expect(continuations(k)).toHaveLength(1);
  });
});

describe("the 비밀 보관함 routes", () => {
  it("add, list, rename, 매번 묻기, delete and restore; no answer carries a value", async () => {
    const k = setup();
    const server = createServer((req, res) => {
      const parts = new URL(req.url ?? "/", "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
      void k.service.handle(req, res, parts).catch((error: { status?: number; code?: string }) => { res.writeHead(error.status ?? 500); res.end(JSON.stringify({ code: error.code })); });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    closers.push(() => new Promise<void>((done) => server.close(() => done())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/channels/credentials`;
    const call = async (method: string, path = "", body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      expect(text).not.toContain(PASSWORD);
      return { status: response.status, body: JSON.parse(text) as CredentialsState };
    };
    let state = (await call("POST", "", { name: "네이버", kind: "login", site: "nid.naver.com", values: { 아이디: "zz-secret-user-0004", 비밀번호: PASSWORD } })).body;
    expect(state.entries).toMatchObject([{ name: "네이버", kind: "login", site: "nid.naver.com", fields: ["아이디", "비밀번호"], held: "sealed" }]);
    const id = state.entries[0]!.id;
    state = (await call("PATCH", `/${id}`, { name: "네이버 업무", askEachTime: true })).body;
    expect(state.entries[0]).toMatchObject({ name: "네이버 업무", askEachTime: true });
    // Other hosts the person allowed in the chat: the PC only removes them.
    k.service.store.allowHost(id, "m.naver.com");
    k.service.store.allowHost(id, "sso.example.org");
    expect((await call("PATCH", `/${id}`, { hosts: ["sso.example.org", "evil.example"] })).status).toBe(400);
    state = (await call("PATCH", `/${id}`, { hosts: ["sso.example.org"] })).body;
    expect(state.entries[0]!.hosts).toEqual(["sso.example.org"]);
    state = (await call("PATCH", `/${id}`, { hosts: [] })).body;
    expect(state.entries[0]!.hosts).toBeUndefined();
    state = (await call("DELETE", `/${id}`)).body;
    expect(state.entries).toEqual([]);
    expect(state.trash).toMatchObject([{ id, name: "네이버 업무" }]);
    state = (await call("POST", `/${id}/restore`)).body;
    expect(state.entries.map((entry) => entry.name)).toEqual(["네이버 업무"]);
    expect((await call("POST", "", { name: "빈 값", values: { 값: "" } })).status).toBe(400);
    expect((await call("GET")).body.entries).toHaveLength(1);
  });
});

describe("fix round 1 (R5, Minor 6)", () => {
  it("while the stored secrets cannot be learned (keyring locked), answers fail:keyring_locked and gives nothing; once open, ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-credsvc-"));
    const first = setup(dir);
    await first.service.add({ name: "노션키", kind: "api-key", site: "notion.so", values: { 키: PASSWORD } });
    const clock = { now: Date.now() };
    const kit = openKit(dir, clock);
    let open = false;
    const vault = new OfficeVault(kit.dataDir, async () => { if (!open) throw new HttpError(503, "office_vault_unavailable", "잠김"); return { id: "c".repeat(32), key: Buffer.alloc(32, 7) }; });
    const service = new CredentialService({ dataDir: kit.dataDir, vault, manager: kit.manager, now: () => clock.now });
    installScrubber(kit.store, kit.manager, service.scrubber);
    closers.push(async () => { service.close(); await kit.manager.shutdown(); kit.store.close(); });
    expect(await service.warmUp()).toBe(false);
    const work = kit.manager.createWork({ title: "도서관", titleSource: "user" });
    const session = kit.manager.createSession(work.id, { provider: "claude", access: "full" });
    expect(await service.run(session.id, ["need", "--name", "노션키", "--kind", "api-key"])).toMatchObject({ stdout: "fail:keyring_locked\n" });
    await expect(service.use("노션키", session.id)).rejects.toMatchObject({ code: "credentials_locked" });
    open = true;
    await service.tick();
    expect(await service.run(session.id, ["need", "--name", "노션키", "--kind", "api-key"])).toMatchObject({ stdout: "ok\n" });
  });

  it("keeps at most three hand-overs waiting per conversation, and the site as a bare host name", async () => {
    const k = setup();
    for (const [index, name] of ["가", "나", "다"].entries()) expect(await k.service.run(k.session.id, ["need", "--name", name, "--kind", "other", "--site", index ? "x" : "https://lib.example.ac.kr/login?next=/a <b>‮"])).toMatchObject({ stdout: "fail:handover_sent\n" });
    expect(await k.service.run(k.session.id, ["need", "--name", "라", "--kind", "other"])).toMatchObject({ stdout: "fail:too_many_handovers\n" });
    expect(k.service.state().waiting.find((handoff) => handoff.name === "가")!.site).toBe("lib.example.ac.kr");
  });
});

describe("fix round 2 (review N5)", () => {
  it("does not try the keyring again on a timer; tries once when something needs the store, and says locked to the PC", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const dir = mkdtempSync(join(tmpdir(), "wb-credsvc-"));
      const first = setup(dir);
      await first.service.add({ name: "노션키", kind: "api-key", site: "notion.so", values: { 키: PASSWORD } });
      const clock = { now: Date.now() };
      const kit = openKit(dir, clock);
      let open = false, calls = 0;
      const vault = new OfficeVault(kit.dataDir, async () => { calls += 1; if (!open) throw new HttpError(503, "office_vault_unavailable", "잠김"); return { id: "c".repeat(32), key: Buffer.alloc(32, 7) }; });
      const service = new CredentialService({ dataDir: kit.dataDir, vault, manager: kit.manager, now: () => clock.now });
      installScrubber(kit.store, kit.manager, service.scrubber);
      closers.push(async () => { service.close(); await kit.manager.shutdown(); kit.store.close(); });
      expect(await service.warmUp()).toBe(false);
      await service.start();
      const after = calls;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(calls).toBe(after);
      expect(service.state().locked).toBe(true);
      const work = kit.manager.createWork({ title: "도서관", titleSource: "user" });
      const session = kit.manager.createSession(work.id, { provider: "claude", access: "full" });
      await service.run(session.id, ["need", "--name", "노션키", "--kind", "api-key"]);
      expect(calls).toBe(after + 1);
      open = true;
      expect(await service.unlock()).toBe(true);
      expect(service.state().locked).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("a hand-over finishing tries the keyring once more (it may have been opened meanwhile)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-credsvc-"));
    const first = setup(dir);
    await first.service.add({ name: "노션키", kind: "api-key", site: "notion.so", values: { 키: PASSWORD } });
    const kit = openKit(dir, { now: Date.now() });
    let open = false, calls = 0;
    const vault = new OfficeVault(kit.dataDir, async () => { calls += 1; if (!open) throw new HttpError(503, "office_vault_unavailable", "잠김"); return { id: "c".repeat(32), key: Buffer.alloc(32, 7) }; });
    const service = new CredentialService({ dataDir: kit.dataDir, vault, manager: kit.manager });
    installScrubber(kit.store, kit.manager, service.scrubber);
    closers.push(async () => { service.close(); await kit.manager.shutdown(); kit.store.close(); });
    expect(await service.warmUp()).toBe(false);
    const work = kit.manager.createWork({ title: "도서관", titleSource: "user" });
    const session = kit.manager.createSession(work.id, { provider: "claude", access: "full" });
    expect(await service.run(session.id, ["need", "--name", "새 키", "--kind", "api-key", "--fields", "키"])).toMatchObject({ stdout: "fail:handover_sent\n" });
    const [handoff] = service.state().waiting;
    open = true;
    await service.receive(handoff!.id, "키", "zz-secret-finish-0021", "e1");
    expect(service.state().locked).toBe(true);
    await service.finish(handoff!.id);
    expect(service.state().locked).toBe(false);
  });

  it("an engine is not started until warm-up has settled (the gateway listens meanwhile)", async () => {
    const k = setup();
    let settle!: () => void;
    k.manager.engineGate = new Promise<void>((done) => { settle = done; });
    const sending = k.manager.send(k.session.id, "r9", "일 해 줘");
    await new Promise((done) => setTimeout(done, 50));
    expect(k.engine.asked).toBe(0);
    settle();
    await sending;
    expect(k.engine.asked).toBe(1);
  });
});

describe("fix round 3 (re-review 2, minor): a request that waits on the keyring says so", () => {
  for (const opened of [false, true]) {
    it(`a PC request shows one line while it waits for the PC's keyring, and what happened (${opened ? "opened" : "gave up"})`, async () => {
      const k = setup();
      let settle!: (opened: boolean) => void;
      k.manager.engineGate = new Promise<boolean>((done) => { settle = done; });
      const sending = k.manager.send(k.session.id, "r9", "일 해 줘");
      const lines = () => k.manager.items(k.session.id).items.filter((item) => item.kind === "notice" && item.id.startsWith("keyring-wait:"));
      await until(() => lines().length === 1);
      expect((lines()[0] as { text: string }).text).toBe("PC의 키링을 기다리고 있습니다. 열리면 바로 보냅니다.");
      expect(k.engine.asked).toBe(0);
      settle(opened);
      await sending;
      expect(k.engine.asked).toBe(1);
      expect(lines()).toHaveLength(1);
      expect((lines()[0] as { text: string }).text).toBe(opened ? "PC의 키링이 열려 보냈습니다." : "PC의 키링이 열리지 않아 저장한 값 없이 보냈습니다. 저장한 값이 필요하면 비밀 보관함에서 다시 시도해 주세요.");
      // Settled: the next request says nothing about it.
      k.engine.finish(k.session.id);
      await k.manager.send(k.session.id, "r10", "하나 더");
      expect(lines()).toHaveLength(1);
    });
  }
});
