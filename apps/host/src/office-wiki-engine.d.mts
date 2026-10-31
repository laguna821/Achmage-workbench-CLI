import type { WikiBacklink, WikiGraph, WikiLink } from "../../../packages/contracts/src/office-wiki.ts";
export interface WikiFs {
  isFile(path: string): Promise<boolean>;
  list(dir: string): Promise<{ files: string[]; dirs: string[] }>;
  read(path: string): Promise<string>;
  mtimeMs(path: string): Promise<number>;
}
export const SKIP_DIRS: Set<string>;
export function resolveWikiLinks(targets: readonly string[], options: { fromPath: string; root: string }, fs: WikiFs): Promise<Map<string, WikiLink>>;
export function wikiBacklinks(root: string, path: string, fs: WikiFs): Promise<WikiBacklink[]>;
export function wikiGraph(root: string, fs: WikiFs): Promise<WikiGraph>;
export function rememberWikiFragment(key: string, fragment: string): void;
export function takeWikiFragment(key: string): string;
