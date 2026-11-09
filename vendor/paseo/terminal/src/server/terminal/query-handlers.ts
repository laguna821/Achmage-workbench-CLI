import type { Terminal } from "@xterm/headless";
// Direct extraction from pinned terminal.ts; see source.json.
const TERMINAL_OSC_COLOR_QUERY_RESPONSES = new Map<number, string>([
  [10, "rgb:e6e6/e6e6/e6e6"],
  [11, "rgb:0b0b/0b0b/0b0b"],
  [12, "rgb:e6e6/e6e6/e6e6"],
]);
export function attachTerminalQueryHandlers(terminal: Terminal, ptyProcess: { write(data: string): void }) {
  // Respond to DA1 queries (CSI c or CSI 0 c) — apps like nvim query terminal capabilities
  terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      ptyProcess.write("\x1b[?62;4;22c");
      return true;
    }
    return false;
  });
  terminal.parser.registerCsiHandler({ final: "n" }, (params) => {
    if (params.length !== 1) {
      return false;
    }
    if (params[0] === 5) {
      ptyProcess.write("\x1b[0n");
      return true;
    }
    if (params[0] === 6) {
      const buffer = terminal.buffer.active;
      ptyProcess.write(`\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
      return true;
    }
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
    if (params.length !== 1 || params[0] !== 6) {
      return false;
    }
    const buffer = terminal.buffer.active;
    ptyProcess.write(`\x1b[?${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
    return true;
  });
  for (const [code, response] of TERMINAL_OSC_COLOR_QUERY_RESPONSES) {
    terminal.parser.registerOscHandler(code, (data) => {
      if (data.trim() !== "?") {
        return false;
      }
      ptyProcess.write(`\x1b]${code};${response}\x1b\\`);
      return true;
    });
  }

}
