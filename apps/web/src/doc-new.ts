import type { Artifact } from "@workbench/contracts";

/**
 * A NEW document opens in its editor (doc-default, point a): pages-first is for opening an existing
 * document to look at it. The rule: a create flow of THIS window made it (새 문서 / a template, a
 * request's "새 문서로" result, 한글 문서 만들기 — they call `markNewDocument`), it still has only its
 * first revision, and that was under NEW_DOCUMENT_MS ago. Never guessed from dates alone: a folder
 * opened as a project registers its existing files as first revisions too, and those are to look at.
 */
export const NEW_DOCUMENT_MS = 10 * 60_000;
const madeHere = new Map<string, number>();
export function markNewDocument(artifactId: string, at = Date.now()) {
  madeHere.set(artifactId, at);
}
export function isNewDocument(artifact: Pick<Artifact, "id" | "revision"> | undefined, now = Date.now()) {
  const at = artifact ? madeHere.get(artifact.id) : undefined;
  return Boolean(artifact && at !== undefined && artifact.revision <= 1 && now - at < NEW_DOCUMENT_MS);
}
