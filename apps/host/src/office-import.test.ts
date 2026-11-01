import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OfficeImport, ieumSettingsDirectory } from "./office-import.mjs";
import { OfficeSettings } from "./office-settings.mjs";
import { OfficeStyles } from "./office-styles.ts";
import { OfficeVault } from "./office-vault.ts";
import type { Documents } from "./artifacts.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const style = { topic: "발표", styleSkill: "원본 스타일", createdAt: "2026-11-01", basedOn: "clean", layout: { future: { color: "blue" } } };
function fixture(reveal = vi.fn(async (_app: string, _directory: string, values: string[]) => Object.fromEntries(values.map(value => [value, "opened-fixture-key"])))) {
  const root = mkdtempSync(join(tmpdir(), "wb-office-import-")), data = join(root, "target"), source = join(root, "source"); mkdirSync(source); mkdirSync(data);
  const makeVault = () => new OfficeVault(data, async () => ({ id: "b".repeat(32), key: Buffer.alloc(32, 4) }));
  const vault = makeVault(), docs = { dataDir: data } as Documents, styles = new OfficeStyles(docs, null);
  const importer = new OfficeImport(docs, { find: () => ({ app: "/fixture/ieum" }) } as any, data, { vault, reveal, defaultDirectory: source });
  const settingsFile = join(source, "ai-settings.json"), styleDir = join(source, "style-templates");
  const seed = (settings: unknown = { providers: { openai: { apiKey: "sealed:v1:fixture", model: "fixture-model" } }, provider: "openai" }) => writeFileSync(settingsFile, JSON.stringify(settings));
  const addStyle = (name: string, value: unknown = style) => { mkdirSync(styleDir, { recursive: true }); writeFileSync(join(styleDir, `${name}.json`), JSON.stringify(value)); };
  const current = () => new OfficeSettings(data, makeVault());
  const apply = (id: string, extra = {}) => importer.apply({ id, ai: true, keys: true, styles: true, ...extra });
  cleanup.push(() => { importer.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, data, source, importer, styles, vault, current, seed, addStyle, apply, settingsFile, reveal };
}
it("previews only names/counts and leaves source and target untouched", () => {
  const f = fixture(); f.seed(); f.addStyle("내 발표"); const before = readFileSync(f.settingsFile);
  const preview = f.importer.inspect(f.source);
  expect(preview).toMatchObject({ ai: { provider: "openai", keys: 1, sealedKeys: 1, replacesCurrent: false }, styles: [{ name: "내 발표", targetName: "내 발표", same: false }] });
  expect(JSON.stringify(preview)).not.toMatch(/sealed:v1|fixture-key/); expect(f.reveal).not.toHaveBeenCalled();
  expect(readFileSync(f.settingsFile)).toEqual(before); expect(existsSync(join(f.data, "office/ai-settings.json"))).toBe(false);
});
it("opens original sealed values once, reseals keys and preserves source bytes and style data", async () => {
  const f = fixture(); f.seed(); f.addStyle("내 발표"); const before = readFileSync(f.settingsFile), p = f.importer.inspect(f.source);
  expect(await f.apply(p.id)).toMatchObject({ ai: true, styles: 1, errors: [] });
  expect(f.reveal).toHaveBeenCalledOnce(); expect(readFileSync(f.settingsFile)).toEqual(before);
  const current = f.current(); expect((await current.executionSettings()).providers.openai.apiKey).toBe("opened-fixture-key");
  const raw = readFileSync(current.path, "utf8"); expect(raw).toContain("sealed:v1:workbench:"); expect(raw).not.toContain("opened-fixture-key");
  expect(f.styles.inspectSaved("내 발표")?.data).toEqual(style);
  expect((await f.apply(p.id)).styles).toBe(1); expect(f.reveal).toHaveBeenCalledOnce();
});
it("keeps old settings in a decryptable encrypted backup and imports without keys on explicit choice", async () => {
  const f = fixture(); f.seed({ providers: { openai: { apiKey: "new-plain-fixture", model: "new" } }, provider: "openai", meteredAccepted: { codex: true }, headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: 2 });
  const current = f.current(); const snapshot = current.snapshot();
  await current.write({ ...snapshot.settings, providers: { ...snapshot.settings.providers, openai: { apiKey: "old-fixture", model: "old" } } }, snapshot.revision);
  const before = readFileSync(current.path), p = f.importer.inspect(f.source); expect(p.ai?.replacesCurrent).toBe(true);
  const result = await f.apply(p.id, { keys: false });
  const backup = JSON.parse(readFileSync(result.backup!, "utf8")), chunks = await Promise.all(backup.chunks.map((value: string) => f.vault.open(value)));
  expect(Buffer.concat(chunks.map((value: string) => Buffer.from(value, "base64")))).toEqual(before);
  expect(JSON.stringify(backup)).not.toMatch(/old-fixture|new-plain-fixture/); expect(f.reveal).not.toHaveBeenCalled();
  const next = await current.executionSettings(); expect(next.providers.openai).toMatchObject({ apiKey: "", model: "new" }); expect(next.headlessSubscriptionEnabled).toBe(false); expect(next.meteredAccepted.codex).not.toBe(true);
});
it("copies conflicting style names and skips exact copies on repeated import", async () => {
  const f = fixture(); f.addStyle("내 발표"); const old = { ...style, styleSkill: "현재 스타일" };
  f.styles.saveImported("내 발표", old, null); const p = f.importer.inspect(f.source);
  expect(p.styles[0]?.targetName).toBe("내 발표 (가져옴 1)"); await f.apply(p.id, { ai: false });
  expect(f.styles.inspectSaved("내 발표")?.data).toEqual(old); expect(f.styles.inspectSaved("내 발표 (가져옴 1)")?.data).toEqual(style);
  const repeated = f.importer.inspect(f.source);
  expect(repeated.styles[0]).toMatchObject({ targetName: "내 발표 (가져옴 1)", same: true });
  expect(await f.apply(repeated.id, { ai: false })).toMatchObject({ styles: 0, skipped: 1 });
  const clean = fixture(); clean.addStyle("같음"); await clean.apply(clean.importer.inspect(clean.source).id, { ai: false });
  const again = clean.importer.inspect(clean.source); expect(again.styles[0]?.same).toBe(true); expect(await clean.apply(again.id, { ai: false })).toMatchObject({ styles: 0, skipped: 1 });
});
it("rejects changed source after waiting for the original app without writing target settings", async () => {
  const f = fixture(); f.seed(); const p = f.importer.inspect(f.source);
  f.reveal.mockImplementationOnce(async () => { f.seed({ providers: {}, provider: "codex" }); return { "sealed:v1:fixture": "opened-fixture-key" }; });
  await expect(f.apply(p.id)).rejects.toMatchObject({ status: 409 }); expect(existsSync(join(f.data, "office/ai-settings.json"))).toBe(false);
});
it("rejects target setting or style changes since preview", async () => {
  const f = fixture(); f.seed(); f.addStyle("내 발표"); const p = f.importer.inspect(f.source);
  f.styles.saveImported("내 발표", { ...style, styleSkill: "새 스타일" }, null);
  await expect(f.apply(p.id)).rejects.toMatchObject({ status: 409 }); expect(f.reveal).not.toHaveBeenCalled();
  const p2 = f.importer.inspect(f.source), current = f.current(), snapshot = current.snapshot(); await current.write(snapshot.settings, snapshot.revision);
  await expect(f.apply(p2.id)).rejects.toMatchObject({ status: 409 }); expect(f.reveal).not.toHaveBeenCalled();
});
it("keeps all settings when keys cannot be opened or import is cancelled", async () => {
  const f = fixture(); f.seed(); const p = f.importer.inspect(f.source);
  f.reveal.mockResolvedValueOnce({}); await expect(f.apply(p.id)).rejects.toThrow("키"); expect(existsSync(join(f.data, "office/ai-settings.json"))).toBe(false);
  const controller = new AbortController(); controller.abort();
  await expect(f.importer.apply({ id: p.id, ai: true, keys: false, styles: false }, controller.signal)).rejects.toThrow();
  expect(existsSync(join(f.data, "office/ai-settings.json"))).toBe(false);
});
it("locates only the official product data folder on each OS", () => {
  expect(ieumSettingsDirectory("linux", { XDG_CONFIG_HOME: "/config" }, "/home/person")).toBe("/config/IeumOffice");
  expect(ieumSettingsDirectory("darwin", {}, "/Users/person")).toBe("/Users/person/Library/Application Support/IeumOffice");
  expect(ieumSettingsDirectory("win32", { APPDATA: "/roaming" }, "/home/person")).toBe("/roaming/IeumOffice");
});
