/** The original Office UI's source names. Workbench's directory-based IDs stay stable. */
export type OfficeSkillSource = "builtin" | "app" | "user" | "plugin" | "codex" | "project";
export type OfficeSkillChip = { id: string; source: OfficeSkillSource; title: string };
export type OfficeSkillVersion = { id: string; sha256: string };
export type OfficeStoredSkill = OfficeSkillChip & { sha256: string };
/** Carried by the original send/queue, independently of its rendered chat bubble. */
export type OfficeSkillContext = { text: string; chips: OfficeSkillChip[]; reads?: OfficeSkillVersion[] };
export type OfficeSkillView = {
  id: string; source: OfficeSkillSource; plugin?: string; name: string; title: string; description: string;
  enabled: boolean; invoke: "manual" | "auto"; hidden: boolean; hasScripts: boolean;
  template?: string; templateExists: boolean; agentOnly: boolean; unreadable?: string;
  files: number; bytes: number; owned: boolean; shadowedBy?: string;
  can: { edit: boolean; copyToMine: boolean; export: boolean; checkUpdate: boolean; openFolder: boolean; remove: boolean; hide: boolean };
};
export type OfficeSkillRead = {
  id: string; name: string; title: string; description: string; body: string; sha256: string;
  files: string[]; template?: string; hasScripts: boolean;
};
export type OfficeSkillHandoff = {
  id: string; mode: "skill"; target: import("./index.ts").OfficeEditorKind;
  text: string; chips: OfficeSkillChip[]; createdAt: number;
};
export type OfficeSkillRequest = {
  type: "office:skills"; requestId: string; action: "open-template" | "take-handoff" | "focus-tab";
  input: Record<string, unknown>;
};
