import type { TerminalSession } from "./terminals.ts";

/** A screen snapshot and the exact next byte of the existing terminal journal. */
export interface TerminalReplay {
  terminal: TerminalSession;
  cursor: number;
  data: string;
  rows: number;
  cols: number;
  retainedHistoryLines: number;
  truncated: boolean;
}
export interface TerminalSearchRequest { query: string; caseSensitive?: boolean; limit?: number }
export interface TerminalSearchResult {
  terminalId: string;
  query: string;
  start: number;
  end: number;
  truncated: boolean;
  limited: boolean;
  /** Line numbers and character offsets are in retained, ANSI-stripped log text. */
  matches: { line: number; text: string; from: number; to: number }[];
}
export interface TerminalResizeOwner { ownerId: string; intent: "claim" | "update" }
