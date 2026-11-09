import { StringDecoder } from "node:string_decoder";
import { createHeadlessTerminal } from "@workbench/paseo-terminal/headless";
import { createTerminalSerializer } from "@workbench/paseo-terminal/serializer";
import { attachTerminalQueryHandlers } from "@workbench/paseo-terminal/query-handlers";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";

/** ANSI state is Paseo's model. Process ownership and the byte journal remain Terminals'. */
export class TerminalEmulator {
  private readonly terminal;
  private readonly serialize;
  private readonly decoder = new StringDecoder("utf8");
  private readonly modes = new TerminalInputModeTracker();
  private tail: Promise<unknown> = Promise.resolve();
  private cursor = 0;
  private ended = false;
  private pendingBytes = 0;
  constructor(rows: number, cols: number, respond: (data: string) => void) {
    this.respond = respond;
    this.terminal = createHeadlessTerminal({ rows, cols, scrollback: 10_000 });
    this.serialize = createTerminalSerializer(this.terminal);
    attachTerminalQueryHandlers(this.terminal, { write: respond });
    this.terminal.onData(respond);
  }
  feed(bytes: Uint8Array, cursor: number) {
    if (this.pendingBytes + bytes.length > 4 * 1024 * 1024) throw new Error("Terminal emulator backlog exceeds 4 MiB");
    this.pendingBytes += bytes.length;
    const text = this.decoder.write(Buffer.from(bytes));
    this.tail = this.tail.then(() => new Promise<void>(resolve => {
      if (this.ended) { this.pendingBytes -= bytes.length; resolve(); return; }
      this.terminal.write(text, () => {
        const update = this.modes.feed(text);
        // Enhanced keyboard replies are provided by the same original mode parser.
        for (const response of update.responses) this.respond(response);
        this.cursor = cursor; this.pendingBytes -= bytes.length;
        resolve();
      });
    }));
  }
  private respond: (data: string) => void = () => {};
  resize(rows: number, cols: number) {
    this.tail = this.tail.then(() => { if (!this.ended) this.terminal.resize(cols, rows); });
  }
  capture() {
    const captured = this.tail.then(() => ({
      data: Buffer.concat([Buffer.from(this.modes.getPreamble()), Buffer.from(this.serialize())]).toString("base64"),
      cursor: this.cursor, rows: this.terminal.rows, cols: this.terminal.cols,
      retainedHistoryLines: Math.max(0, this.terminal.buffer.normal.length - this.terminal.rows),
    }));
    this.tail = captured;
    return captured;
  }
  dispose() {
    void this.tail.finally(() => { this.ended = true; this.terminal.dispose(); });
  }
}
