import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.ts";
import { OfficeVault } from "../office-vault.ts";
import { formsOf } from "./forms.ts";
import { TranscriptScrubber } from "./scrubber.ts";
import { CredentialStore, type Handoff } from "./store.ts";

// Made-up values only.
const ID = "zz-secret-user-0001";
const PASSWORD = "zz-secret-pass-0002";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "wb-cred-")); dirs.push(dir); return dir; };
const key = { id: "c".repeat(32), key: Buffer.alloc(32, 7) };
const keyring = (dir: string) => new OfficeVault(dir, async () => ({ id: key.id, key: Buffer.from(key.key) }));
const noKeyring = (dir: string) => new OfficeVault(dir, async () => { throw new HttpError(503, "office_vault_unavailable", "없음"); });

/** Every byte under a folder, as text: what a value must never be found in. */
function everything(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue;
    out += readFileSync(join(name.parentPath, name.name)).toString("latin1");
    out += readFileSync(join(name.parentPath, name.name)).toString("utf8");
  }
  return out;
}
const found = (dir: string, value: string) => formsOf(value).filter((form) => everything(dir).includes(form));

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  id: "h1", sessionId: "s1", bindingId: null, name: "학술정보원", kind: "login", site: "https://lib.example.ac.kr", fields: ["아이디", "비밀번호"],
  mode: "give", entryId: "c_h1", state: "waiting", createdAt: 1, expiresAt: Date.now() + 60_000, doneAt: null, held: null, continued: null, events: [], ...over,
});

describe("the vault's credential purpose", () => {
  it("binds a sealed value to its entry and field: it opens only there, and the envelope does not say where", async () => {
    const vault = keyring(temp());
    const sealed = await vault.sealFor("cred", PASSWORD, "c_a\u0000비밀번호");
    expect(await vault.openFor("cred", sealed, "c_a\u0000비밀번호")).toBe(PASSWORD);
    await expect(vault.openFor("cred", sealed, "c_b\u0000비밀번호")).rejects.toMatchObject({ code: "office_secret_invalid" });
    await expect(vault.openFor("cred", sealed, "c_a\u0000아이디")).rejects.toMatchObject({ code: "office_secret_invalid" });
    await expect(vault.openFor("cred", sealed)).rejects.toMatchObject({ code: "office_secret_invalid" });
    expect(sealed).not.toContain("c_a");
    // A bot token sealed before (purpose only) still opens as it did.
    expect(await vault.openFor("channel", await vault.sealFor("channel", "token-value-0001"))).toBe("token-value-0001");
  });
});

describe("CredentialStore", () => {
  it("keeps only sealed values, in a 0700 folder and a 0600 file, and never lists a value", async () => {
    const dir = temp(), scrubber = new TranscriptScrubber();
    const store = new CredentialStore(dir, keyring(dir), scrubber);
    const entry = await store.add({ name: "학교 포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: ID, 비밀번호: PASSWORD } });
    expect(entry).toMatchObject({ name: "학교 포털", kind: "login", fields: ["아이디", "비밀번호"], held: "sealed", askEachTime: false, lastUsedAt: null });
    expect(statSync(join(dir, "credentials")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "credentials", "store.json")).mode & 0o777).toBe(0o600);
    expect(found(dir, ID)).toEqual([]);
    expect(found(dir, PASSWORD)).toEqual([]);
    expect(JSON.stringify(store.summaries())).not.toContain(PASSWORD);
    // The scrubber knows it at once.
    expect(scrubber.text(`pw=${PASSWORD}`)).toBe("pw=[비밀: 학교 포털]");
    // The search below can find a value, so its empty answers above mean something.
    writeFileSync(join(dir, "planted.txt"), `x ${encodeURIComponent(PASSWORD)} y`);
    expect(found(dir, PASSWORD).length).toBeGreaterThan(0);
  });

  it("opens the values again after a restart, for the one who uses them and for the scrubber", async () => {
    const dir = temp();
    const first = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    const { id } = await first.add({ name: "노션키", kind: "api-key", site: "notion.so", values: { 키: PASSWORD } });
    const scrubber = new TranscriptScrubber();
    const again = new CredentialStore(dir, keyring(dir), scrubber);
    expect(scrubber.text(PASSWORD)).toBe(PASSWORD);
    await again.warm();
    expect(scrubber.text(PASSWORD)).toBe("[비밀: 노션키]");
    expect(await again.reveal(id, "s9")).toEqual({ 키: PASSWORD });
    expect(again.summaries()[0]).toMatchObject({ usedIn: ["s9"] });
    expect(again.summaries()[0]!.lastUsedAt).not.toBeNull();
  });

  it("refuses a sealed value moved to another entry or field in the file", async () => {
    const dir = temp();
    const store = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    const a = await store.add({ name: "가", kind: "other", site: "", values: { 값: PASSWORD } });
    const b = await store.add({ name: "나", kind: "other", site: "", values: { 값: ID } });
    const file = join(dir, "credentials", "store.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.entries.find((entry: { id: string }) => entry.id === b.id).values["값"] = raw.entries.find((entry: { id: string }) => entry.id === a.id).values["값"];
    writeFileSync(file, JSON.stringify(raw));
    const again = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    // It cannot even be learned: nothing is given out.
    await expect(again.warm()).rejects.toMatchObject({ code: "office_secret_invalid" });
    await expect(again.reveal(b.id, "s1")).rejects.toMatchObject({ code: "credentials_locked" });
  });

  it("without a keyring stores nothing on disk, keeps the value in memory and gives it once", async () => {
    const dir = temp(), scrubber = new TranscriptScrubber();
    const store = new CredentialStore(dir, noKeyring(dir), scrubber);
    const entry = await store.add({ name: "카드 1", kind: "card", site: "", values: { 카드번호: "4000123412341234" } });
    expect(entry.held).toBe("memory");
    expect(found(dir, "4000123412341234")).toEqual([]);
    expect(scrubber.text("4000 1234 1234 1234")).toBe("[비밀: 카드 1]");
    expect(await store.reveal(entry.id, "s1")).toEqual({ 카드번호: "4000123412341234" });
    expect(store.summaries()).toEqual([]);
    await expect(store.reveal(entry.id, "s1")).rejects.toMatchObject({ code: "credential_missing" });
  });

  it("renames, refuses a name in use, turns 매번 묻기 on and off, and deletes reversibly", async () => {
    const dir = temp(), scrubber = new TranscriptScrubber();
    const store = new CredentialStore(dir, keyring(dir), scrubber);
    const a = await store.add({ name: "네이버", kind: "login", site: "nid.naver.com", values: { 비밀번호: PASSWORD } });
    await store.add({ name: "다음", kind: "login", site: "", values: { 비밀번호: ID } });
    expect(() => store.rename(a.id, " 다음 ")).toThrow(expect.objectContaining({ code: "credential_name_taken" }));
    store.rename(a.id, "네이버 업무");
    expect(scrubber.text(PASSWORD)).toBe("[비밀: 네이버 업무]");
    expect(store.setAsk(a.id, true).askEachTime).toBe(true);
    store.remove(a.id);
    expect(store.summaries().map((entry) => entry.name)).toEqual(["다음"]);
    // Still hidden while it can be brought back.
    expect(scrubber.text(PASSWORD)).toBe("[비밀: 네이버 업무]");
    store.restore(a.id);
    expect(store.find("네이버 업무")).toMatchObject({ askEachTime: true });
    expect(await store.reveal(a.id, "s1")).toEqual({ 비밀번호: PASSWORD });
  });

  it("collects a hand-over field by field; each received message counts once, also after a restart", async () => {
    const dir = temp();
    const store = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    const h = handoff();
    store.saveHandoff(h);
    expect(await store.putField(h, "아이디", ID, "ev-1")).toBe("sealed");
    expect(store.taken("h1", "ev-1")).toBe(true);
    expect(store.filled("h1")).toEqual(["아이디"]);
    const again = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    expect(again.taken("h1", "ev-1")).toBe(true);
    expect(await again.putField(h, "비밀번호", PASSWORD, "ev-2")).toBe("sealed");
    const done = again.finish("h1", { state: "ready", doneAt: 5, held: "sealed" });
    expect(done).toMatchObject({ name: "학술정보원", fields: ["아이디", "비밀번호"] });
    // The draft became the entry and the hand-over is ready, in one write; its messages still count as taken.
    const third = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    expect(await third.warm()).toBe(true);
    expect(third.handoff("h1")).toMatchObject({ state: "ready", held: "sealed" });
    expect(third.taken("h1", "ev-2")).toBe(true);
    expect(await third.reveal(done.id, "s1")).toEqual({ 아이디: ID, 비밀번호: PASSWORD });
    expect(found(dir, ID)).toEqual([]);
  });
});

describe("fix round 1 (review I2 / R2, Minor 8, R5)", () => {
  it("hides only secret fields: a login's 아이디 (an e-mail) is kept but not looked for, and the file says so per field", async () => {
    const dir = temp(), scrubber = new TranscriptScrubber();
    const store = new CredentialStore(dir, keyring(dir), scrubber);
    const mail = "zz.person@example.ac.kr";
    const entry = await store.add({ name: "학교 메일", kind: "login", site: "mail.example.ac.kr", values: { 아이디: mail, 비밀번호: PASSWORD } });
    expect(entry.secret).toEqual({ 아이디: false, 비밀번호: true });
    expect(scrubber.text(`내 메일 ${mail} 로, 비번 ${PASSWORD}`)).toBe(`내 메일 ${mail} 로, 비번 [비밀: 학교 메일]`);
    const file = JSON.parse(readFileSync(join(dir, "credentials", "store.json"), "utf8"));
    expect(file.entries[0].secret).toEqual({ 아이디: false, 비밀번호: true });
    expect(await store.reveal(entry.id, "s1")).toEqual({ 아이디: mail, 비밀번호: PASSWORD });
  });

  it("replaces an entry of the same name in one write, and the old one can be brought back", async () => {
    const dir = temp();
    const store = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    const old = await store.add({ name: "네이버", kind: "login", site: "", values: { 비밀번호: ID } });
    const file = join(dir, "credentials", "store.json");
    const write = vi.spyOn(store as unknown as { write: (next: unknown) => void }, "write");
    const fresh = await store.add({ name: "네이버", kind: "login", site: "", values: { 비밀번호: PASSWORD } });
    expect(write).toHaveBeenCalledTimes(1);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.entries.map((entry: { id: string }) => entry.id)).toEqual([fresh.id]);
    expect(raw.trash.map((entry: { id: string }) => entry.id)).toEqual([old.id]);
  });

  it("gives no value until it has learned every stored secret (a locked keyring at start), and learns them when it opens", async () => {
    const dir = temp();
    const first = new CredentialStore(dir, keyring(dir), new TranscriptScrubber());
    const { id } = await first.add({ name: "노션키", kind: "api-key", site: "", values: { 키: PASSWORD } });
    let open = false;
    const flaky = new OfficeVault(dir, async () => { if (!open) throw new HttpError(503, "office_vault_unavailable", "잠김"); return { id: key.id, key: Buffer.from(key.key) }; });
    const scrubber = new TranscriptScrubber();
    const again = new CredentialStore(dir, flaky, scrubber);
    expect(again.ready).toBe(false);
    expect(await again.warm()).toBe(false);
    await expect(again.reveal(id, "s1")).rejects.toMatchObject({ code: "credentials_locked" });
    open = true;
    expect(await again.warm()).toBe(true);
    expect(again.ready).toBe(true);
    expect(scrubber.text(PASSWORD)).toBe("[비밀: 노션키]");
    expect(await again.reveal(id, "s1")).toEqual({ 키: PASSWORD });
  });
});
