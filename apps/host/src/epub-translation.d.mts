import type { EpubSession } from "./epub-ops.mjs";
type Outcome = { ok: boolean; error?: string; message?: string; [key: string]: unknown };
export function epubTranslationStore(directory: string, knows: (owner: string, hash: string) => boolean): {
  invoke(operation: string, owner: string, args: Record<string, unknown>): Promise<Outcome>;
  units(session: EpubSession, args: Record<string, unknown>): Promise<Outcome>;
  build(session: EpubSession, args: Record<string, unknown>): Promise<Outcome & { bytes?: Uint8Array; report?: unknown; identifier?: string }>;
  migrate(session: EpubSession, hashes: { oldDocHash: string; newDocHash: string }): Promise<unknown>;
  interrupt(docHash: string, languages: Iterable<string>): Promise<void>;
};
