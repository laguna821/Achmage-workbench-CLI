export type HookSource = "auto" | "shared-only" | "local-only" | "run-both";
export type WorkspaceEnvironment = {
  revision: number; setupScript: string; archiveScript: string;
  setupSource: HookSource; archiveSource: HookSource;
  sharedPaths: string[]; waitForSetup: boolean; bashPath: string;
};
export type PreparationOptions = { kind: "setup" | "archive"; applyPaths: boolean; runCommands: boolean; openTabs: boolean };
export type PreparationPath = {
  path: string; source: string; target: string; mode: "copy" | "share";
  origin: "local" | "orca.yaml" | ".worktreeinclude";
  action: "apply" | "preserve" | "skip"; reason: string | null;
  bytes: number; entries: number; fingerprint: string; links: number;
};
export type PreparationTab = { title: string; command: string | null; color?: string; key: string; terminalId: string | null };
export type PreparationPreview = {
  workspaceId: string; workId: string; primary: string; target: string;
  revision: string; configRevision: string; options: PreparationOptions;
  hook: { script: string; source: Exclude<HookSource, "auto">; digest: string };
  shell: "bash" | "cmd"; shellPath: string; environment: Record<string, string>;
  waitForSetup: boolean; paths: PreparationPath[]; tabs: PreparationTab[]; warnings: string[];
};
export type PreparationJob = {
  id: string; workspaceId: string; workId: string; preview: PreparationPreview;
  phase: "queued" | "paths" | "hook" | "tabs" | "complete" | "failed" | "canceled" | "interrupted";
  pathResults: { path: string; outcome: "copied" | "shared" | "preserved" | "skipped" }[];
  terminalIds: string[]; hookTerminalId: string | null; error: string | null;
  createdAt: number; updatedAt: number;
};
export type ApplyPreparationRequest = { requestId: string; expectedRevision: string; options: PreparationOptions };
