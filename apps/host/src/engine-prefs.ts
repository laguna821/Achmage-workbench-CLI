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
  private value: { personalTools: Partial<Record<Provider, boolean>> };
  constructor(dataDir: string) {
    this.file = join(dataDir, "engine-prefs.json");
    this.value = { personalTools: {} };
    try {
      const read = JSON.parse(readFileSync(this.file, "utf8")) as { personalTools?: Record<string, unknown> };
      for (const provider of ["claude", "codex"] as const) if (read.personalTools?.[provider] === true) this.value.personalTools[provider] = true;
    } catch { /* Not set yet: every switch off. */ }
  }
  personalTools(provider: Provider) { return this.value.personalTools[provider] === true; }
  setPersonalTools(provider: Provider, on: boolean) {
    this.value = { ...this.value, personalTools: { ...this.value.personalTools, [provider]: on } };
    writeAtomic(this.file, JSON.stringify(this.value, null, 2));
  }
}
