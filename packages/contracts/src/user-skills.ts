import type { DocFormat } from "./index.ts";

export type WorkbenchSkillSource = "project" | "claude" | "codex" | "shared" | "plugin" | "imported" | "ieum" | "builtin";
/** Workbench selection only. This does not rewrite Claude/Codex's native skill settings. */
export type WorkbenchSkillState = { enabled: boolean; invoke: "manual" | "auto" };
export type WorkbenchSkill = {
  id: string;
  name: string;
  title: string;
  description: string;
  source: WorkbenchSkillSource;
  dir: string;
  plugin: string | null;
  template: { relativePath: string; name: string; format: DocFormat | null; exists: boolean } | null;
  state: WorkbenchSkillState;
  /** The installed or project skill that takes precedence over this same-name entry. */
  shadowedBy: string | null;
  editable: boolean;
  hasScripts: boolean;
  github: boolean;
  files: number;
  bytes: number;
  problem: string | null;
};
export type WorkbenchSkillDetail = { skill: WorkbenchSkill; markdown: string; body: string; sha256: string };
export type TemplateSelection = { skillId: string; title: string; sha256: string; skillSha256: string };
export type TemplatePreview = {
  template: TemplateSelection;
  name: string;
  format: DocFormat;
  size: number;
  text: string | null;
  pages: { page: number; width: number; height: number; url: string }[];
  problem: string | null;
};
export type SkillImportPreview = {
  id: string;
  origin: string;
  license: string | null;
  candidates: { key: string; name: string; title: string; description: string; files: number; bytes: number; hasScripts: boolean; hasTemplate: boolean; collision: boolean; problem: string | null; urls: string[]; license: string | null }[];
};
export type SkillUpdatePreview = { id: string | null; status: "up-to-date" | "changed"; commit: string; locallyEdited: boolean; changes: { rel: string; change: "added" | "removed" | "modified" }[] };
