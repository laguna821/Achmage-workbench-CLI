import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OfficePreferences, importedOfficePreferences } from "./office-preferences.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "wb-office-prefs-")); roots.push(root); return new OfficePreferences(root); }
it("uses original defaults and preserves an unconfigured panel for legacy per-editor fallback", () => {
  const p = fixture(); expect(p.snapshot()).toMatchObject({ panelConfigured: false, documentTheme: "follow", autoSaveDefault: { on: false }, author: { value: "" } });
  expect(p.snapshot().author.fallback).not.toBe("");
  p.invoke("home:set-author-name", ["  Test\n   Author  "]);
  expect(p.snapshot().author.value).toBe("Test Author"); expect(p.snapshot().panelConfigured).toBe(false);
});
it("shares panel settings between instances, preserves other fields, and clamps original custom sizes", () => {
  const p = fixture(), second = new OfficePreferences(dirname(dirname(p.path)));
  p.invoke("home:set-document-theme", ["dark"]); p.setPanel({ side: "right", fontSize: "custom", customFontSize: 99 });
  expect(second.snapshot()).toMatchObject({ documentTheme: "dark", panelConfigured: true, aiPanel: { side: "right", fontSize: "custom", customFontSize: 32 } });
  second.setPanel({ spellcheck: false }); expect(p.snapshot().aiPanel).toMatchObject({ side: "right", spellcheck: false, customFontSize: 32 });
  p.setPanel({ authorName: "Untrusted panel", mcpEnabled: true }); expect(p.snapshot().author.value).toBe("");
  expect(JSON.parse(readFileSync(p.path, "utf8")).mcpEnabled).toBeUndefined();
});
it("imports only document preferences and never imports paths, login consent or automatic servers", () => {
  expect(importedOfficePreferences({ authorName: " A ", aiPanelSide: "right", documentTheme: "dark", autoSaveDefault: true,
    autoSaveDefaultUpdatedAt: 3, mcpEnabled: true, headlessSubscriptionEnabled: true, defaultSaveDir: "/other", fileSearch: { apiKey: "key" }, autoUpdateCheck: false }))
    .toEqual({ authorName: "A", aiPanelSide: "right", documentTheme: "dark", autoSaveDefault: true });
});
it("keeps legacy panel values on the first partial change and ignores stale legacy values after that", () => {
  const p = fixture(); p.setPanel({ spellcheck: false }, { side: "right", fontSize: "large" });
  expect(p.snapshot().aiPanel).toMatchObject({ side: "right", fontSize: "large", spellcheck: false });
  p.setPanel({ customFontSize: 22 }, { side: "left", fontSize: "default" });
  expect(p.snapshot().aiPanel).toMatchObject({ side: "right", fontSize: "large", customFontSize: 22 });
});
it("backs up exact previous bytes and rejects an import after destination changed", () => {
  const p = fixture(); mkdirSync(dirname(p.path), { recursive: true });
  const previous = '{ "authorName" : "Before", "future": {"keep":true} }\n'; writeFileSync(p.path, previous);
  const old = p.snapshot().revision; p.setPanel({ side: "right" });
  expect(() => p.write({ authorName: "Stale" }, old, true)).toThrow("변경");
  const bytes = readFileSync(p.path); const result = p.write({ authorName: "After" }, p.snapshot().revision, true);
  expect(readFileSync(result.backup!)).toEqual(bytes); expect(JSON.parse(readFileSync(p.path, "utf8")).future).toEqual({ keep: true });
});
it("makes an explicit autosave choice newer than legacy per-document choices and persists it", () => {
  const p = fixture(), before = Date.now(); p.invoke("home:set-auto-save-default", [true]);
  expect(p.snapshot().autoSaveDefault.on).toBe(true); expect(p.snapshot().autoSaveDefault.updatedAt).toBeGreaterThanOrEqual(before);
  expect(() => p.invoke("home:set-auto-save-default", ["false"])).toThrow();
  expect(() => p.invoke("home:set-document-theme", ["system"])).toThrow();
});
it("does not overwrite an unreadable existing settings file", () => {
  const p = fixture(); mkdirSync(dirname(p.path), { recursive: true }); writeFileSync(p.path, "broken original bytes");
  expect(() => p.write({ authorName: "New" })).toThrow(); expect(readFileSync(p.path, "utf8")).toBe("broken original bytes");
});
