/** Executable extensions are separate from searched or imported skill documents. */
export type ExtensionCapability = "tool" | "screen" | "provider";
export type ExtensionPermission = { files: ("read" | "write")[]; network: string[] };
export type ExtensionGrant = {
  extensionId: string; artifactHash: string; generation: number; enabled: boolean;
  capabilities: ExtensionCapability[]; workspaceIds: string[];
  permissions: ExtensionPermission; revokedAt: number | null;
};
export type ExtensionContribution = { id: string; title: string; method: string };
export type ExtensionScreenContribution = { id: string; title: string; file: string };
export type ExtensionManifest = {
  apiVersion: 1; runtime: "paseo-quickjs-v1"; id: string; name: string; version: string;
  license: string; source: { url: string; revision: string };
  capabilities: ExtensionCapability[]; permissions: ExtensionPermission;
  tools: ExtensionContribution[]; screens: ExtensionScreenContribution[];
  providers: ExtensionContribution[];
};
export type ExtensionArtifact = {
  manifest: ExtensionManifest; artifactHash: string; installedAt: number;
  files: { path: string; sha256: string; bytes: number }[];
};
export type ExtensionRecord = ExtensionArtifact & {
  status: "disabled" | "enabled" | "updating" | "failed";
  grant: ExtensionGrant; previous: ExtensionArtifact | null; error: string | null;
};
export type ExtensionInstallRequest = { directory: string; expectedHash?: string };
export type ExtensionActivation = {
  expectedHash: string; expectedGeneration: number; capabilities: ExtensionCapability[];
  workspaceIds: string[]; permissions: ExtensionPermission;
};
export type ExtensionCall = {
  extensionId: string; artifactHash: string; grantGeneration: number;
  capability: ExtensionCapability; workspaceId: string; contributionId: string; input?: unknown;
};
export type ExtensionRun = {
  id: string; extensionId: string; artifactHash: string; grantGeneration: number;
  workspaceId: string; capability: ExtensionCapability; contributionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number; finishedAt: number | null; error: string | null;
};
export type ExtensionRunResult = { run: ExtensionRun; output: unknown };
/** Render only in an opaque-origin sandbox iframe with this nonce and no app credentials. */
export type ExtensionScreen = {
  extensionId: string; artifactHash: string; grantGeneration: number; workspaceId: string;
  screenId: string; nonce: string; html: string; expiresAt: number;
};
export type ExtensionScreenCall = { nonce: string; call: ExtensionCall };
export type ExtensionState = {
  extensions: ExtensionRecord[]; runs: ExtensionRun[];
  runtime: { format: "paseo-quickjs-v1"; isolation: "quickjs-wasm"; nativeCode: false;
    platform: string; verification: "host-tested" | "not-tested" };
};
