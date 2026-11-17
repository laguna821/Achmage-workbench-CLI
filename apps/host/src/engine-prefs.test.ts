import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EnginePrefs } from "./engine-prefs.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("'내 MCP 서버와 훅 불러오기' is off for both engines until switched on, and is kept across starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-engine-prefs-"));
  dirs.push(dir);
  const prefs = new EnginePrefs(dir);
  expect([prefs.personalTools("claude"), prefs.personalTools("codex")]).toEqual([false, false]);
  prefs.setPersonalTools("claude", true);
  expect(new EnginePrefs(dir).personalTools("claude")).toBe(true);
  expect(new EnginePrefs(dir).personalTools("codex")).toBe(false);
  prefs.setPersonalTools("claude", false);
  expect(new EnginePrefs(dir).personalTools("claude")).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "engine-prefs.json"), "utf8"))).toEqual({ personalTools: { claude: false } });
});
