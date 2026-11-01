import type { OfficeImportChoice, OfficeImportPreview, OfficeImportResult } from "../../../packages/contracts/src/office-import.ts";
export function ieumSettingsDirectory(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string): string;
export function revealIeumSecrets(app: string | undefined, directory: string, values: string[], signal?: AbortSignal): Promise<Record<string, string>>;
export class OfficeImport {
  constructor(documents: import("./artifacts.ts").Documents, desktop: Pick<import("./ieum-desktop.ts").IeumDesktop, "find">, dataDir: string, injected?: Record<string, any>);
  sources(): { directory: string; exists: boolean; appAvailable: boolean };
  inspect(directory: string): OfficeImportPreview;
  apply(choice: OfficeImportChoice, signal?: AbortSignal): Promise<OfficeImportResult>;
  close(): void;
}
