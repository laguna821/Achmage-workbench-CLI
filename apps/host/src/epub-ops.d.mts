export const EPUB_MAX_BYTES: number;
export interface EpubSession {
  readonly bytes: Uint8Array;
  readonly docHash: string;
  readonly locked: boolean;
  summary(): unknown;
  bookReadOnly(): string | null;
  readChapter(index: unknown): Promise<Record<string, unknown>>;
  applyEdits(index: unknown, edits: unknown): Promise<Record<string, unknown>>;
  replaceRanges(index: unknown, version: unknown, replacements: unknown): Promise<Record<string, unknown>>;
  setLocked(locked: boolean): void;
  isDirty(): boolean;
  prepareSave(): Promise<{ result: { ok: true; changed: false } | { ok: true; changed: true; bytes: Uint8Array } | { ok: false; reason: string; detail: string }; snapshot: Map<string, string> }>;
  rebase(bytes: Uint8Array, snapshot: ReadonlyMap<string, string>): Promise<{ oldDocHash: string; newDocHash: string }>;
  readText(): Promise<string>;
}
export type EpubViewPrefs = { fontScale: number; lineHeight: number | null; dark: boolean };
export type EpubReadPosition = { spineIndex: number; blockId: string | null };
export function openEpubSession(bytes: Uint8Array): Promise<{ ok: true; session: EpubSession } | { ok: false; reason: string }>;
export function epubText(bytes: Uint8Array): Promise<string>;
export function epubAsset(session: EpubSession, token: string, path: string, method: string): Promise<Response>;
export function readPositionOf(value: unknown): EpubReadPosition | null;
export function epubReadingState(dir: string): {
  get(path: string | null): Promise<{ position: EpubReadPosition | null; viewPrefs: EpubViewPrefs }>;
  setPosition(path: string, position: EpubReadPosition): Promise<void>;
  setViewPrefs(patch: unknown): Promise<EpubViewPrefs>;
};
