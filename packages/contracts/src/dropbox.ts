import type { Artifact, Work } from "./index.ts";

export type DropboxFolder = { path: string; label: string; source: "registered" | "suggested" | "manual"; available: boolean };
export type DropboxState = { selected: DropboxFolder | null; candidates: DropboxFolder[]; syncStatus: "managed-by-dropbox" };
export type DropboxEntry = { name: string; path: string; kind: "folder" | "document"; conflictedCopy: boolean };
export type DropboxListing = { path: string; parent: string | null; entries: DropboxEntry[]; truncated: boolean };
export type DropboxOpened = { work: Work; artifact?: Artifact };
