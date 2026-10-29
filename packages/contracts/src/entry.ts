// ① 들어가는 길 (docs/design/프로젝트-노트-설계.md §3, §13): where a request from home goes, and
// where works started without a folder get their own folder.
import type { Work } from "./index.ts";

/** The live (not archived) work whose folder is the given one, after both are resolved to real paths. */
export type WorkAtFolder = { work: Work | null };

/**
 * "새 프로젝트 폴더 위치": the folder under which a work started without a folder gets its own
 * folder. `custom` is false while it is the gateway's own default. Existing works never move.
 */
export type WorksDirView = {
  path: string;
  defaultPath: string;
  custom: boolean;
  /** Why the chosen folder cannot take new projects now (missing, not writable), or null. */
  problem: string | null;
};

/** Where the request typed on home goes: decided by the folder ("auto"), a new project, or an existing one. */
export type ProjectPick = { kind: "auto" } | { kind: "new" } | { kind: "work"; workId: string };
