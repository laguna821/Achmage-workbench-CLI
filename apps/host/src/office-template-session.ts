import type { CreationRecord } from "./creation-journal.ts";
import type { SessionManager } from "./sessions.ts";

/** The creation belongs to its source card, while its copy runs in its own document agent.
 * Bind legacy records on access without copying files or replaying their request. */
export function bindTemplateSession(manager: SessionManager, entry: CreationRecord): CreationRecord {
  if (!entry.office || !entry.artifactId || entry.office.targetSessionId) return entry;
  const target = manager.documentSession(entry.artifactId, entry.sessionId);
  return manager.creations.update(entry.requestId, { office: { ...entry.office, targetSessionId: target.id } })!;
}

/** Old cards remain in the shared parent history, exposed only to that source document's first child. */
export function isTemplateSource(manager: SessionManager, entry: CreationRecord, artifactId: string, sessionId: string): boolean {
  if (entry.office?.sourceArtifactId !== artifactId) return false;
  return entry.sessionId === sessionId || manager.office.scope(artifactId, sessionId).documentAgent?.legacySessionId === entry.sessionId;
}
