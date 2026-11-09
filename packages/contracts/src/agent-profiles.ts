import type { AccessMode, Provider } from "./index.ts";

export type AgentProfileInput = {
  name: string; provider: Provider | null; model: string | null; effort: string | null;
  access: AccessMode | null; instructions: string;
};
export type AgentProfile = AgentProfileInput & { id: string; revision: number; updatedAt: number };
/** Captured at request admission, never changed by subsequent profile edits. */
export type RunSettings = {
  provider: Provider; model: string | null; effort: string | null; access: AccessMode;
  instructions: string; profileId: string | null; profileRevision: number | null; profileName: string | null;
};
export type SubmitCommand = {
  commandId: string; hostId: string; workspaceId: string; sessionId: string;
  text: string; mode?: "auto" | "queue" | "steer"; profileId?: string | null;
};
