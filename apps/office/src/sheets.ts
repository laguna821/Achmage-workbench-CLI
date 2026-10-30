import { mountOfficeAi, officeAiTransport } from "./office-ai.ts";
import { DEFAULT_AI_PANEL_PREFS, normalizeAiPanelPrefs } from "../../../vendor/ieumoffice/packages/ui/src/ai-panel-prefs.ts";
import "./sheets.css";
import { Gateway, GatewayError, handshake, listen, post } from "./bridge.ts";
import { dispatch, useTransport } from "./platform/electron-renderer.ts";
import { recovery } from "./recovery.ts";
import { convertForeignPictures, pasteDesktopPictures } from "./pictures.ts";
import type { WorkerCall, WorkerMessage, WorkerRequest } from "./slides/protocol.ts";

// IeumOffice's spreadsheet editor inside Workbench. Its screen (vendor/ieumoffice/apps/sheets
// renderer, Univer) and its window API (the preload) are used unchanged; its editing code runs in
// this page's worker (sheets/worker.ts) with the Rust xlsx engine as WebAssembly, instead of an
// Electron main process and a separate engine process. The workbook comes from a Workbench
// revision and a save becomes the next revision; AI stays in Workbench's conversation.

const init = await handshake();
const gateway = new Gateway(init.token);
const ai = mountOfficeAi(init, gateway);
const artifactId = init.artifact.id;
/**
 * `revision`: what the editor's workbook is based on (a save must name it). `pending`: edits the
 * editor has not saved (its journal). `uncommitted`: saved in the editor but not taken as a
 * revision (the document moved on meanwhile); the working copy holds them.
 */
const state = { revision: init.artifact.revision, theme: init.theme, pending: 0, uncommitted: false, kept: false };

document.documentElement.dataset.workbenchTheme = state.theme;

// ── the worker ───────────────────────────────────────────────────────────
const worker = new Worker(new URL("./sheets/worker.ts", import.meta.url), { type: "module" });
const waiting = new Map<number, { resolve(value: { value: unknown; unhandled?: boolean }): void; reject(error: Error): void }>();
let nextCall = 1;
worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === "send") return dispatch(message.channel, message.args);
  if (message.type === "notice") return post({ type: "office:error", message: message.message });
  const waiter = waiting.get(message.id);
  if (!waiter) return;
  waiting.delete(message.id);
  if (message.ok) waiter.resolve({ value: message.value, unhandled: message.unhandled });
  else waiter.reject(new Error(message.error));
};
worker.onerror = (event) => post({ type: "office:error", message: `편집기 엔진 오류: ${event.message}` });

function call(request: WorkerRequest, transfer: Transferable[] = []) {
  const id = nextCall++;
  return new Promise<{ value: unknown; unhandled?: boolean }>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...request, id } as WorkerCall, transfer);
  });
}
const value = async <T>(request: WorkerRequest, transfer: Transferable[] = []) => (await call(request, transfer)).value as T;

// ── what the page answers itself ─────────────────────────────────────────
let aiPrefs = DEFAULT_AI_PANEL_PREFS;
try { aiPrefs = normalizeAiPanelPrefs(JSON.parse(localStorage.getItem("workbench.office.sheets.ai-prefs") ?? "null")); } catch { /* UI preferences only. */ }
const noAi = () => Promise.reject(new Error("이 AI 도구는 아직 지원하지 않습니다."));
const notHere = (what: string) => Promise.reject(new Error(`${what}은(는) Workbench에서 아직 지원하지 않습니다.`));
const unhandled = new Set<string>();

async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  switch (channel) {
    case "app:get-language":
      return "ko";
    case "app:get-theme":
      return state.theme;
    case "app:get-document-theme":
      return "follow";
    case "app:get-auto-save-default":
      // Every save is a revision: saved on Ctrl+S, before a request, when the tab or view changes.
      return { on: false, updatedAt: 1 };
    case "app:get-ai-panel-prefs": return aiPrefs;
    case "app:set-ai-panel-prefs": {
      aiPrefs = normalizeAiPanelPrefs({ ...aiPrefs, ...(args[0] as object) });
      localStorage.setItem("workbench.office.sheets.ai-prefs", JSON.stringify(aiPrefs)); dispatch("app:ai-panel-prefs-changed", [aiPrefs]); return aiPrefs;
    }
    case "user:display-name":
      return "";
    case "workbook:select-for-merge":
    case "workbook:open-for-merge":
      // Only this document: no other files are opened from the editor.
      return null;
    case "workbook:save":
      return save(args);
    case "workbook:export-pdf":
    case "workbook:print":
      return notHere("PDF 내보내기와 인쇄");
    case "workbook:create-document":
      return notHere("새 문서 만들기");
    case "shell:open-external":
      return null;
  }
  if (/^(ai|sheets:ai|sheets:files|sheets:capture|sheets:mcp|project|home):/.test(channel)) return noAi();
  const reply = await call({ type: "invoke", channel, args });
  if (reply.unhandled && !unhandled.has(channel)) {
    unhandled.add(channel);
    console.debug(`[workbench office] not provided: ${channel}`);
  }
  noteSession(reply.value);
  return reply.value;
}

let closeSaveAnswer: ((ok: boolean) => void) | null = null;
function send(channel: string, args: unknown[]) {
  if (channel === "workbook:close-save-result") {
    closeSaveAnswer?.(args[0] === true);
    closeSaveAnswer = null;
    return;
  }
  if (channel === "workbook:pending-edits") {
    state.pending = typeof args[0] === "number" ? args[0] : 0;
    reportDirty();
  }
  void call({ type: "send", channel, args }).catch(() => undefined);
}

useTransport({ invoke: officeAiTransport(ai, dispatch, invoke), send });

// ── saving ───────────────────────────────────────────────────────────────
const dirty = () => state.pending > 0 || state.uncommitted;
let lastReported: boolean | null = null;
function reportDirty() {
  const now = dirty();
  if (now !== lastReported) post({ type: "office:dirty", dirty: now });
  lastReported = now;
}

/** The working copy as the editor saved it, taken as the revision after `state.revision`. */
async function commit(): Promise<boolean> {
  const bytes = await value<ArrayBuffer>({ type: "saved-bytes" });
  try {
    const saved = await gateway.saveBytes(artifactId, state.revision, bytes);
    state.revision = saved.revision;
    state.uncommitted = false;
    if (state.kept) {
      state.kept = false;
      void recovery.drop(artifactId).catch(() => undefined);
    }
    post({ type: "office:saved", revision: saved.revision });
    reportDirty();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The editor has saved; its bytes wait in the working copy until the user decides.
    state.uncommitted = true;
    reportDirty();
    if (error instanceof GatewayError && error.status === 409) post({ type: "office:conflict", code: error.code, message });
    else post({ type: "office:error", message });
    return false;
  }
}

async function save(args: unknown[]) {
  const request = await withFormulaResults(args[0] as SaveRequest);
  const result = await value<{ canceled?: boolean } | null>({ type: "invoke", channel: "workbook:save", args: [request, ...args.slice(1)] });
  noteSession(result);
  if (result && !result.canceled) await commit();
  return result;
}

// ── formula results in the saved revision ────────────────────────────────
// The editor computes formulas on screen, but its save keeps each formula cell's stored result as
// the file had it and asks Excel to recalculate on open. Workbench reads revisions without a
// spreadsheet program (the text view, the AI's copy), so a save also carries the formula results,
// computed by the editor's own Rust engine (IronCalc, its recalculation fallback) over the same
// edits. Results the engine cannot vouch for (functions it lacks, locale-bound text) keep the file's
// value; saves it cannot follow (rows or sheets moved, large workbooks) go out as the editor made them.

type CellScalar = string | number | boolean | null;
type SaveRequest = {
  sessionId: string;
  mode: string;
  targetPath?: string;
  editsTransferId?: string;
  edits: { sheetId: string; row: number; column: number; writeValue: boolean; value: CellScalar; formula?: string }[];
  bulkConstantFills?: unknown[];
  structuralOps: unknown[];
  sheetOps: { kind: string }[];
  formulaValues: { sheetId: string; row: number; column: number; value: CellScalar | { error: string } }[];
};
type SessionFile = { sessionId: string; fileBytes?: number; sheets: { id: string; rowCount?: number; columnCount?: number }[] };
type FormulaCells = {
  cells: { row: number; column: number; formula?: string }[];
  sharedGroups: { formula: string; range?: { startRow: number; endRow: number; startColumn: number; endColumn: number }; cells?: [number, number][] }[];
  indexingComplete: boolean;
  truncated: boolean;
};
type Recalculated = { cells: { sheetId: string; row: number; column: number; formatted: string; number?: number; isError?: boolean; isFormula: boolean }[] };

/** Within what the engine evaluates quickly in the page: a save waits for it. */
const RESULTS = { fileBytes: 8 * 1024 * 1024, gridCells: 500_000, formulas: 20_000, edits: 10_000, reads: 200, readCells: 100_000 };

/** The workbook sessions the editor has open (from its open and save results), by id. */
const sessions = new Map<string, SessionFile>();
function noteSession(result: unknown) {
  const file = (result && typeof result === "object" && "file" in result ? (result as { file: unknown }).file : result) as Partial<SessionFile> | null;
  if (file && typeof file === "object" && typeof file.sessionId === "string" && Array.isArray(file.sheets)) sessions.set(file.sessionId, file as SessionFile);
}

/**
 * Engine results that must not displace the file's value (the editor's rule, univer-sync.ts
 * `engineResultKeepsCache`): #NAME? is a function IronCalc lacks, #ERROR! its own failure, and
 * NUMBERSTRING/DOLLAR results are minted in the author's locale.
 */
function keepsFileValue(formatted: string, formula: string) {
  if (formatted === "#NAME?" || formatted === "#ERROR!") return true;
  const outsideQuotes = formula.split('"').filter((_, index) => index % 2 === 0);
  return outsideQuotes.some((segment) => /(?:^|[^A-Z0-9_.])(?:NUMBERSTRING|DOLLAR)\s*\(/.test(segment.toUpperCase()));
}

/** A cell edit as the engine takes typed input (the editor's own conversion). */
function typedInput(edit: SaveRequest["edits"][number]) {
  if (edit.formula) return edit.formula;
  const { value } = edit;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return value.startsWith("=") || value.startsWith("'") ? `'${value}` : value;
}

/** Rectangles covering a sheet's formula cells: one span per row, equal spans of adjacent rows merged. */
function readRanges(keys: Iterable<string>) {
  const rows = new Map<number, { start: number; end: number }>();
  for (const key of keys) {
    const [row, column] = key.split(":").map(Number) as [number, number];
    const span = rows.get(row);
    if (!span) rows.set(row, { start: column, end: column });
    else {
      span.start = Math.min(span.start, column);
      span.end = Math.max(span.end, column);
    }
  }
  const ranges: { startRow: number; endRow: number; startColumn: number; endColumn: number }[] = [];
  for (const [row, span] of [...rows].sort((a, b) => a[0] - b[0])) {
    const last = ranges.at(-1);
    if (last && last.endRow === row - 1 && last.startColumn === span.start && last.endColumn === span.end) last.endRow = row;
    else ranges.push({ startRow: row, endRow: row, startColumn: span.start, endColumn: span.end });
  }
  return ranges;
}

async function withFormulaResults(request: SaveRequest): Promise<SaveRequest> {
  try {
    const file = sessions.get(request?.sessionId);
    if (!file || !Array.isArray(request.edits) || !Array.isArray(request.formulaValues)) return request;
    if (request.mode !== "save" || request.targetPath || request.editsTransferId) return request;
    if (request.structuralOps.length > 0 || (request.bulkConstantFills?.length ?? 0) > 0) return request;
    if (request.sheetOps.some((op) => op.kind !== "set-sheet-tab-color")) return request;
    const gridCells = file.sheets.reduce((sum, sheet) => sum + (sheet.rowCount ?? 0) * (sheet.columnCount ?? 0), 0);
    if ((file.fileBytes ?? 0) > RESULTS.fileBytes || gridCells > RESULTS.gridCells) return request;
    const written = request.edits.filter((edit) => edit.writeValue);
    if (written.length > RESULTS.edits) return request;

    // Every formula cell of every sheet (shared-formula followers carry their group's formula).
    const formulas = new Map<string, Map<string, string>>();
    let count = 0;
    for (const sheet of file.sheets) {
      const found = await value<FormulaCells>({ type: "invoke", channel: "workbook:read-formulas", args: [{ sessionId: request.sessionId, sheetId: sheet.id }] });
      if (found.truncated || !found.indexingComplete) return request;
      const cells = new Map<string, string>();
      for (const cell of found.cells) if (cell.formula) cells.set(`${cell.row}:${cell.column}`, cell.formula);
      for (const group of found.sharedGroups) {
        const { range } = group;
        if (range && (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > RESULTS.formulas) return request;
        if (range) for (let row = range.startRow; row <= range.endRow; row++) for (let column = range.startColumn; column <= range.endColumn; column++) cells.set(`${row}:${column}`, group.formula);
        for (const [row, column] of group.cells ?? []) cells.set(`${row}:${column}`, group.formula);
      }
      count += cells.size;
      if (count > RESULTS.formulas) return request;
      if (cells.size > 0) formulas.set(sheet.id, cells);
    }
    // This save's own edits: formulas typed now are read too (the save writes them without a
    // result); a formula cell turned into a plain value is no longer one.
    for (const edit of written) {
      let cells = formulas.get(edit.sheetId);
      if (edit.formula) {
        if (!cells) formulas.set(edit.sheetId, (cells = new Map()));
        if (!cells.has(`${edit.row}:${edit.column}`)) count += 1;
        cells.set(`${edit.row}:${edit.column}`, edit.formula);
      } else cells?.delete(`${edit.row}:${edit.column}`);
    }
    if (count === 0 || count > RESULTS.formulas) return request;
    const reads = [...formulas].flatMap(([sheetId, cells]) => readRanges(cells.keys()).map((range) => ({ sheetId, range })));
    const readCells = reads.reduce((sum, { range }) => sum + (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1), 0);
    if (reads.length > RESULTS.reads || readCells > RESULTS.readCells) return request;

    const result = await value<Recalculated>({
      type: "invoke",
      channel: "workbook:recalc",
      args: [{ sessionId: request.sessionId, edits: written.map((edit) => ({ sheetId: edit.sheetId, row: edit.row, column: edit.column, input: typedInput(edit) })), reads }],
    });
    // Results the editor already sends stand.
    const taken = new Set(request.formulaValues.map((cell) => `${cell.sheetId}:${cell.row}:${cell.column}`));
    const added: SaveRequest["formulaValues"] = [];
    for (const cell of result.cells) {
      const formula = formulas.get(cell.sheetId)?.get(`${cell.row}:${cell.column}`);
      if (!cell.isFormula || formula === undefined || taken.has(`${cell.sheetId}:${cell.row}:${cell.column}`)) continue;
      if (keepsFileValue(cell.formatted, formula) || cell.formatted.length > 10_000) continue;
      added.push({ sheetId: cell.sheetId, row: cell.row, column: cell.column, value: cell.isError ? { error: cell.formatted.slice(0, 32) } : (cell.number ?? cell.formatted) });
    }
    return added.length > 0 ? { ...request, formulaValues: [...request.formulaValues, ...added] } : request;
  } catch (error) {
    console.debug("[workbench office] formula results not added to the save:", error instanceof Error ? error.message : error);
    return request;
  }
}

/** Keep what cannot be saved now (the saved working copy) for the next visit. */
async function keepNow() {
  if (!state.uncommitted) return;
  const bytes = await value<ArrayBuffer>({ type: "saved-bytes" }).catch(() => null);
  if (!bytes) return;
  await recovery.put(artifactId, { baseRevision: state.revision, bytes, at: Date.now() }).catch(() => undefined);
  state.kept = true;
}

/** Save now through the editor's own save path (its close-save request). */
async function flush() {
  if (state.uncommitted) {
    await keepNow();
    return post({ type: "office:flushed", revision: null });
  }
  // The React pending-count notification can lag behind an AI tool's committed
  // journal. Ask the original close-save handler even when the mirror says zero;
  // it reads the live journal and also commits an active cell editor.
  const ok = await new Promise<boolean>((resolve) => {
    closeSaveAnswer = resolve;
    dispatch("workbook:close-save-request", []);
    window.setTimeout(() => resolve(false), 60_000);
  });
  if (!ok || state.uncommitted) await keepNow();
  post({ type: "office:flushed", revision: ok && !state.uncommitted ? state.revision : null });
}

listen((message) => {
  if (message.type === "office:theme") {
    state.theme = message.theme;
    document.documentElement.dataset.workbenchTheme = message.theme;
    dispatch("app:theme-changed", [message.theme]);
  }
  if (message.type === "office:flush") void flush();
  if (message.type === "office:rebase") {
    state.revision = message.revision;
    if (state.uncommitted) {
      // Already saved by the editor: take the working copy as the next revision.
      void commit().then((ok) => post({ type: "office:flushed", revision: ok ? state.revision : null }));
    } else void flush();
  }
  if (message.type === "office:keep") void keepNow().then(() => post({ type: "office:flushed", revision: null }));
});

// Shortcuts the editor takes from its Electron app menu: here the page's keys send the same actions.
window.addEventListener(
  "keydown",
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = key === "s" && !event.shiftKey ? "save" : key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" ? "redo" : null;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch("menu:action", [action]);
  },
  true,
);

// ── open the document, then the editor ──────────────────────────────────
let kept = init.recover && !init.readOnly ? await recovery.get(artifactId).catch(() => undefined) : undefined;
if (kept && kept.baseRevision > init.artifact.revision) kept = undefined;
if (!kept && !init.readOnly) await recovery.drop(artifactId).catch(() => undefined);
if (kept) {
  // A saved workbook that was not taken as a revision: it opens as it was saved, still to be committed.
  state.revision = kept.baseRevision;
  state.kept = true;
  state.uncommitted = true;
}
const bytes = kept ? kept.bytes : await gateway.raw(artifactId, state.revision);
await value({ type: "init", token: init.token });
await value({ type: "open", name: init.artifact.name, bytes }, [bytes]);
post({ type: "office:opened", revision: state.revision, recovered: Boolean(kept) });
reportDirty();

// Pictures in formats the editor does not take go on to it as PNG; a paste that shows the page
// nothing (a screenshot in WebKitGTK) gets the desktop clipboard's picture.
convertForeignPictures();
pasteDesktopPictures();

await import("@ieum/apps/sheets/src/preload/index.ts");
await import("@ieum/apps/sheets/src/renderer/main.tsx");
