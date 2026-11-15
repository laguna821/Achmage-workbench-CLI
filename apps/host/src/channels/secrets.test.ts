import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeVault, nativeOfficeVault } from "../office-vault.ts";
import { ChannelSecrets } from "./secrets.ts";

// A stand-in for the OS keyring: a fixed key, or the same 503 the real one gives when there is none.
const KEY_ID = "c".repeat(32);
const standIn = (dir: string) => new OfficeVault(dir, async () => ({ id: KEY_ID, key: Buffer.alloc(32, 3) }));
const noKeyring = (dir: string) => new OfficeVault(dir, nativeOfficeVault(dir, "/missing-workbench-secret-binary"));

// A made-up value in the shape of a bot token; it was never issued.
const TOKEN = "7012345678:AAH" + "y".repeat(8) + "-Fake_token-for-tests-0002";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "wb-channel-secrets-"));
  dirs.push(dir);
  return dir;
}
/** Every file under the data folder, as text. */
function everything(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"))
    .join("\n");
}

describe("sealing for a purpose with the existing vault", () => {
  it("opens what it sealed, and marks the purpose in the envelope", async () => {
    const vault = standIn(folder());
    const sealed = await vault.sealFor("channel", TOKEN);
    expect(sealed.startsWith(`sealed:v1:workbench:${KEY_ID}:channel:`)).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(await vault.openFor("channel", sealed)).toBe(TOKEN);
  });

  it("seals the same value differently each time", async () => {
    const vault = standIn(folder());
    expect(await vault.sealFor("channel", TOKEN)).not.toBe(await vault.sealFor("channel", TOKEN));
  });

  it("does not open a value under another purpose, nor as an Office key, nor an Office key as a channel value", async () => {
    const vault = standIn(folder());
    const channel = await vault.sealFor("channel", TOKEN);
    const office = await vault.seal("office-key-value");
    await expect(vault.openFor("cred", channel)).rejects.toMatchObject({ status: 422 });
    await expect(vault.open(channel)).rejects.toMatchObject({ status: 422 });
    await expect(vault.openFor("channel", office)).rejects.toMatchObject({ status: 422 });
    // Relabelling the envelope does not help: the purpose is authenticated.
    await expect(vault.openFor("cred", channel.replace(":channel:", ":cred:"))).rejects.toMatchObject({ status: 422 });
    // Office values still open as before.
    expect(await vault.open(office)).toBe("office-key-value");
  });

  it("refuses with the vault's 503 when the OS keyring is missing, for sealing and for opening", async () => {
    const dir = folder();
    const sealed = await standIn(dir).sealFor("channel", TOKEN);
    await expect(noKeyring(dir).sealFor("channel", TOKEN)).rejects.toMatchObject({ status: 503, code: "office_vault_unavailable" });
    await expect(noKeyring(dir).openFor("channel", sealed)).rejects.toMatchObject({ status: 503, code: "office_vault_unavailable" });
  });
});

describe("the bot token store", () => {
  it("keeps a token sealed in <data>/channels/bots.json (0600, folder 0700) and gives it back after a restart", async () => {
    const dir = folder();
    const secrets = new ChannelSecrets(dir, standIn(dir));
    expect(await secrets.keep("telegram:7012345678", TOKEN)).toBe("sealed");
    const file = join(dir, "channels", "bots.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "channels")).mode & 0o777).toBe(0o700);
    expect(everything(dir)).not.toContain(TOKEN);
    expect(readFileSync(file, "utf8")).toContain("sealed:v1:workbench:");
    // A new process: nothing in memory.
    const again = new ChannelSecrets(dir, standIn(dir));
    expect(await again.reveal("telegram:7012345678")).toBe(TOKEN);
    expect(again.held("telegram:7012345678")).toBe("sealed");
  });

  it("writes nothing when the keyring is missing, and says why with the vault's 503", async () => {
    const dir = folder();
    const secrets = new ChannelSecrets(dir, noKeyring(dir));
    await expect(secrets.keep("telegram:7012345678", TOKEN)).rejects.toMatchObject({ status: 503, code: "office_vault_unavailable" });
    expect(everything(dir)).not.toContain(TOKEN);
    expect(secrets.held("telegram:7012345678")).toBe("none");
    await expect(secrets.reveal("telegram:7012345678")).rejects.toMatchObject({ status: 409, code: "channel_token_missing" });
  });

  it("remembers a token for this run only when asked, never on disk, and it is gone after a restart", async () => {
    const dir = folder();
    const secrets = new ChannelSecrets(dir, noKeyring(dir));
    expect(await secrets.keep("telegram:7012345678", TOKEN, { memoryOnly: true })).toBe("memory");
    expect(await secrets.reveal("telegram:7012345678")).toBe(TOKEN);
    expect(secrets.held("telegram:7012345678")).toBe("memory");
    expect(everything(dir)).not.toContain(TOKEN);
    const again = new ChannelSecrets(dir, noKeyring(dir));
    expect(again.held("telegram:7012345678")).toBe("none");
    await expect(again.reveal("telegram:7012345678")).rejects.toMatchObject({ status: 409, code: "channel_token_missing" });
  });

  it("replaces a token, forgets one, and leaves the other bots' tokens alone", async () => {
    const dir = folder();
    const secrets = new ChannelSecrets(dir, standIn(dir));
    await secrets.keep("telegram:1", TOKEN);
    await secrets.keep("telegram:2", TOKEN + "b");
    await secrets.keep("telegram:1", TOKEN + "new");
    expect(await secrets.reveal("telegram:1")).toBe(TOKEN + "new");
    secrets.forget("telegram:1");
    expect(secrets.held("telegram:1")).toBe("none");
    expect(await new ChannelSecrets(dir, standIn(dir)).reveal("telegram:2")).toBe(TOKEN + "b");
  });

  it("does not open a stored token when the keyring is missing later, and keeps the file as it was", async () => {
    const dir = folder();
    await new ChannelSecrets(dir, standIn(dir)).keep("telegram:1", TOKEN);
    const before = readFileSync(join(dir, "channels", "bots.json"), "utf8");
    const later = new ChannelSecrets(dir, noKeyring(dir));
    await expect(later.reveal("telegram:1")).rejects.toMatchObject({ status: 503, code: "office_vault_unavailable" });
    expect(readFileSync(join(dir, "channels", "bots.json"), "utf8")).toBe(before);
  });

  it("registers what it reveals with the redactor, so a later log line cannot carry it", async () => {
    const dir = folder();
    const secrets = new ChannelSecrets(dir, standIn(dir));
    // Not token-shaped on purpose: only the registration can hide it.
    await secrets.keep("slack:T1", "plain-secret-value-123");
    expect(secrets.redactor.apply("failed with plain-secret-value-123")).toBe("failed with [비밀: slack:T1]");
  });

  it("keeps hiding a token after it was replaced (토큰 바꾸기)", async () => {
    const dir = folder();
    const secrets = new ChannelSecrets(dir, standIn(dir));
    await secrets.keep("slack:T1", "plain-secret-value-123");
    await secrets.keep("slack:T1", "plain-secret-value-456");
    expect(secrets.redactor.apply("old plain-secret-value-123 new plain-secret-value-456")).not.toMatch(/plain-secret-value/);
  });
});
