import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory } from "@workbench/paseo-server-transport/private-files";
import type { Redactor } from "./redact.ts";
import { cutAt } from "./shape.ts";

/**
 * The channel's log: a fixed code, and a detail that has passed the redactor. Message bodies and
 * secret values are never given to it; the redactor is for what slips into an error or an address.
 */
export class ChannelLog {
  private readonly redactor: Redactor;
  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(redactor: Redactor, write: (line: string) => void = () => {}, now: () => number = Date.now) {
    this.redactor = redactor;
    this.write = write;
    this.now = now;
  }

  /** An error as it may be shown or stored: redacted, on one line. */
  clean(error: unknown): string {
    return (error instanceof Error ? this.redactor.error(error) : cutAt(this.redactor.apply(String(error)), 500)).replace(/\s*[\r\n]+\s*/g, " ");
  }

  /** Text that leaves the PC for a chat (an answer, the activity line), with the secrets hidden. */
  scrub(text: string): string {
    return this.redactor.apply(text);
  }

  /** The forms of the values stored in the 비밀 보관함 (unit 9: what a file is checked for); none when nothing is stored. */
  stored(): string[] {
    return this.redactor.stored();
  }

  note(code: string, detail?: unknown) {
    const text = detail === undefined || detail === null ? "" : detail instanceof Error ? this.redactor.error(detail) : cutAt(this.redactor.apply(String(detail)), 500);
    const line = `${new Date(this.now()).toISOString()} ${code}${text ? ` ${text.replace(/\s*[\r\n]+\s*/g, " ")}` : ""}`;
    try {
      this.write(line);
    } catch {
      // A log that cannot be written never stops the channel.
    }
  }
}

/** Lines appended to `<data>/channels/channel.log` (0600); past `limit` bytes the file becomes `.1` and a new one starts. */
export function fileLog(dataDir: string, limit = 1_000_000): (line: string) => void {
  const folder = join(dataDir, "channels"), file = join(folder, "channel.log");
  return (line) => {
    ensurePrivateDirectory(folder);
    if (existsSync(file) && statSync(file).size > limit) renameSync(file, `${file}.1`);
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  };
}
