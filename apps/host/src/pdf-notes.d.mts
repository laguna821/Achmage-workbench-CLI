import type { SessionManager } from "./sessions.ts";
import type { EventBus } from "./bus.ts";
import type { EditorGrants } from "./editors.ts";
import type { PdfNoteResult } from "../../../packages/contracts/src/pdf-notes.ts";
export class PdfNotes {
  constructor(manager: SessionManager, bus: EventBus);
  readonly store: any;
  readonly service: { afterSave(path: string): Promise<void> };
  action(artifactId: string, token: string, grants: EditorGrants, action: unknown, input?: Record<string, unknown>): Promise<PdfNoteResult | string[]>;
  close(): void;
}
