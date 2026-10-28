// IeumOffice's xlsx engine client (apps/sheets/src/main/xlsx-sidecar-client.ts) as Workbench runs
// it: the same calls, answered by the engine compiled to WebAssembly (native/xlsx-wasm) inside
// this worker instead of a separate process. Files are the worker's own (platform/fs.ts, through
// WASI), so the editor code around the engine reads and writes the same ones.
import { createWasi } from "../platform/wasi.ts";
import engineUrl from "./xlsx-engine.wasm?url";

type Reply = { ok: boolean; result?: unknown; error?: { code: string; message: string } };
type Exports = {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  wb_alloc(len: number): number;
  wb_handle(ptr: number, len: number): number;
  wb_reply_len(): number;
};

let loading: Promise<(request: Record<string, unknown>) => Reply> | null = null;

function engine() {
  loading ??= (async () => {
    const wasi = createWasi((stream, text) => {
      const line = text.trimEnd();
      if (line) (stream === "stderr" ? console.warn : console.debug)(`[xlsx engine] ${line}`);
    });
    const bytes = await (await fetch(engineUrl)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, wasi.imports as unknown as WebAssembly.Imports);
    const exports = instance.exports as unknown as Exports;
    wasi.attach(exports.memory);
    exports._initialize?.();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return (request: Record<string, unknown>) => {
      const body = encoder.encode(JSON.stringify(request));
      const ptr = exports.wb_alloc(body.length);
      new Uint8Array(exports.memory.buffer, ptr, body.length).set(body);
      const reply = exports.wb_handle(ptr, body.length);
      const text = decoder.decode(new Uint8Array(exports.memory.buffer, reply, exports.wb_reply_len()));
      wasi.flush();
      return JSON.parse(text) as Reply;
    };
  })();
  return loading;
}

type Range = { readonly startRow: number; readonly endRow: number; readonly startColumn: number; readonly endColumn: number };

export class XlsxSidecarClient {
  constructor(_binaryPath?: string) {}

  /** The engine runs in this worker: it never dies on its own. */
  onProcessExit(_listener: () => void) {
    return () => undefined;
  }

  open(path: string, locale = "ko", shortDateFormat?: string) {
    return this.request({ command: "open", path, locale, ...(shortDateFormat === undefined ? {} : { shortDateFormat }) });
  }
  readRange(input: { readonly sessionId: string; readonly sheetId: string; readonly range: Range }) {
    return this.request({ command: "read_range", ...input });
  }
  readFormulaCells(input: { readonly sessionId: string; readonly sheetId: string }) {
    return this.request({ command: "read_formula_cells", ...input });
  }
  findCells(input: Readonly<Record<string, unknown>> & { readonly sessionId: string }) {
    return this.request({ command: "find_cells", ...input });
  }
  readRowOutline(input: { readonly sessionId: string; readonly sheetId: string }) {
    return this.request({ command: "read_row_outline", ...input });
  }
  async close(sessionId: string) {
    await this.request({ command: "close", sessionId });
  }
  readMedia(input: { readonly sessionId: string; readonly visualId: string }) {
    return this.request({ command: "read_media", ...input });
  }
  convertWorkbook(input: { path: string; targetPath: string }) {
    return this.request({ command: "convert_workbook", ...input });
  }
  archiveManifest(path: string) {
    return this.request({ command: "archive_manifest", path });
  }
  readEntries(input: { readonly path: string; readonly entries: readonly string[]; readonly outputDir: string }) {
    return this.request({ command: "read_entries", ...input });
  }
  scanEntries(input: { readonly path: string; readonly entries: readonly string[]; readonly needle: string }) {
    return this.request({ command: "scan_entries", ...input });
  }
  saveArchive(input: {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly replacements: readonly { name: string; contentPath: string }[];
    readonly removals: readonly string[];
    readonly additions: readonly { name: string; contentPath: string }[];
  }) {
    return this.request({ command: "save_archive", ...input });
  }
  recalcCells(input: { readonly path: string; readonly edits: readonly unknown[]; readonly reads: readonly unknown[] }) {
    return this.request({ command: "recalc_cells", ...input });
  }

  /** Load the engine ahead of the first request. */
  start() {
    void engine();
  }
  getProcessId() {
    return null;
  }
  stop() {}

  private async request(command: Record<string, unknown>) {
    const reply = (await engine())({ version: 1, requestId: crypto.randomUUID(), ...command });
    if (reply.ok) return reply.result;
    console.warn(`[xlsx engine] ${String(command.command)} failed: ${reply.error?.code ?? ""} ${reply.error?.message ?? ""}`);
    throw new Error(reply.error?.message ?? "XLSX engine request failed.");
  }
}
