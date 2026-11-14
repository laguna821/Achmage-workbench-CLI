import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "@workbench/paseo-server-transport/private-files";
import { HttpError } from "../errors.ts";
import type { OfficeVault } from "../office-vault.ts";
import { Redactor } from "./redact.ts";

type BotsFile = { version: 1; tokens: Record<string, string> };

/** How a bot's token is held: sealed on disk, for this run only (no OS keyring), or not at all. */
export type TokenHold = "sealed" | "memory" | "none";

/**
 * The channel's tokens (a Telegram bot token; Slack's two later). On disk only as values sealed by
 * the existing vault for the purpose "channel", in `<data>/channels/bots.json` (0600). Without an
 * OS keyring nothing is written: the vault's 503 is passed on, and the person may choose to keep
 * the token for this run only, in memory. Every value revealed here is registered with the
 * redactor, so no later log line or stored error can carry it.
 */
export class ChannelSecrets {
  readonly redactor: Redactor;
  private readonly file: string;
  private readonly vault: OfficeVault;
  private readonly memory = new Map<string, string>();

  constructor(dataDir: string, vault: OfficeVault, redactor = new Redactor()) {
    this.file = join(dataDir, "channels", "bots.json");
    this.vault = vault;
    this.redactor = redactor;
  }

  private read(): BotsFile {
    if (!existsSync(this.file)) return { version: 1, tokens: {} };
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<BotsFile>;
    const tokens: Record<string, string> = {};
    // Only sealed values are ever taken from the file; anything else is not a token of ours.
    for (const [id, value] of Object.entries(parsed.tokens ?? {})) if (typeof value === "string" && value.startsWith("sealed:v1:")) tokens[id] = value;
    return { version: 1, tokens };
  }

  private write(file: BotsFile) {
    ensurePrivateDirectory(join(this.file, ".."));
    writePrivateFileAtomicSync(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }

  /**
   * Keep a token. Sealed on disk when the OS keyring is there; otherwise the vault's 503, unless
   * `memoryOnly` asks to remember it for this run (it is gone after a restart).
   */
  async keep(id: string, token: string, options: { memoryOnly?: boolean } = {}): Promise<"sealed" | "memory"> {
    if (!token) throw new HttpError(400, "channel_token_empty", "토큰이 비어 있습니다.");
    this.redactor.add(id, token);
    if (options.memoryOnly) {
      this.memory.set(id, token);
      const file = this.read();
      if (file.tokens[id]) { delete file.tokens[id]; this.write(file); }
      return "memory";
    }
    const sealed = await this.vault.sealFor("channel", token);
    const file = this.read();
    file.tokens[id] = sealed;
    this.write(file);
    this.memory.delete(id);
    return "sealed";
  }

  held(id: string): TokenHold {
    if (this.memory.has(id)) return "memory";
    return this.read().tokens[id] ? "sealed" : "none";
  }

  /** The token itself, for the adapter that uses it. Never logged, never sent back to a screen. */
  async reveal(id: string): Promise<string> {
    const remembered = this.memory.get(id);
    if (remembered) return remembered;
    const sealed = this.read().tokens[id];
    if (!sealed) throw new HttpError(409, "channel_token_missing", "이 봇의 토큰이 없습니다. 토큰을 다시 넣어 주세요.");
    const token = await this.vault.openFor("channel", sealed);
    this.redactor.add(id, token);
    return token;
  }

  forget(id: string) {
    this.memory.delete(id);
    this.redactor.remove(id);
    const file = this.read();
    if (file.tokens[id]) { delete file.tokens[id]; this.write(file); }
  }
}
