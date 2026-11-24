import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@workbench/contracts";
import { writeAtomic } from "./atomic-write.ts";

/**
 * Engine choices the person makes in 설정 › AI 엔진 that the gateway itself applies (engine-prefs.json in
 * the data folder). Today one: "내 MCP 서버와 훅 불러오기" per engine — whether Workbench's conversations
 * start the person's own MCP servers and hooks. Off unless switched on (the owner, 2026-11-16: the public
 * build loads none of them by default; loading Achmage MCP is set separately per engine).
 */
export class EnginePrefs {
  private readonly file: string;
  private value: { personalTools: Partial<Record<Provider, boolean>>; gemini?: GeminiSettings };
  constructor(dataDir: string) {
    this.file = join(dataDir, "engine-prefs.json");
    this.value = { personalTools: {} };
    try {
      const read = JSON.parse(readFileSync(this.file, "utf8")) as { personalTools?: Record<string, unknown>; gemini?: Record<string, unknown> };
      for (const provider of ["claude", "codex"] as const) if (read.personalTools?.[provider] === true) this.value.personalTools[provider] = true;
      if (read.gemini && typeof read.gemini === "object") this.value.gemini = parseGemini(read.gemini);
    } catch { /* Not set yet: every switch off. */ }
  }
  /** 설정 › AI 엔진 › Gemini: the opt-in (subscription login only, through agy's own sign-in; off until the person agrees). */
  gemini(): GeminiSettings { return this.value.gemini ?? { ...GEMINI_DEFAULT }; }
  setGemini(patch: Record<string, unknown>) {
    this.value = { ...this.value, gemini: parseGemini({ ...this.gemini(), ...patch }) };
    writeAtomic(this.file, JSON.stringify(this.value, null, 2));
    return this.gemini();
  }
  personalTools(provider: Provider) { return this.value.personalTools[provider] === true; }
  setPersonalTools(provider: Provider, on: boolean) {
    this.value = { ...this.value, personalTools: { ...this.value.personalTools, [provider]: on } };
    writeAtomic(this.file, JSON.stringify(this.value, null, 2));
  }
}

export type GeminiSettings = { googleOptIn: boolean };
const GEMINI_DEFAULT: GeminiSettings = { googleOptIn: false };
/** Only the opt-in is kept: an API-key or Enterprise choice stored before the owner's 2026-11-21 decision is dropped. */
function parseGemini(value: Record<string, unknown>): GeminiSettings {
  return { googleOptIn: value.googleOptIn === true };
}
