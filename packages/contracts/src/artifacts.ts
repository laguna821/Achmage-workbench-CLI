/** A file result at the moment of a message, distinct from the current file on disk. */
export type ArtifactRef = {
  hostId: string; workspaceId: string | null; artifactId: string; canonicalPath: string;
  revision: string; hash: string; MIME: string; sourceMessageId: string;
};

export function artifactCacheKey(ref: ArtifactRef): string {
  return JSON.stringify([ref.hostId, ref.workspaceId, ref.artifactId, ref.revision, ref.hash]);
}

export type MessageMedia = { source: string; attachment: import("./index.ts").Attachment };
