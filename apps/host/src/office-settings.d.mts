import type { OfficeVault } from "./office-vault.ts";
export const OFFICE_SECRET_PLACEHOLDER: string;
export type OfficeSettingsSnapshot = { revision: string; settings: Record<string, any>; legacySecrets: number };
export class OfficeSettings {
  constructor(dataDir: string, vault?: OfficeVault);
  readonly path: string;
  snapshot(): OfficeSettingsSnapshot;
  publicSettings(): Record<string, any>;
  executionSettings(): Promise<Record<string, any>>;
  write(settings: unknown, expectedRevision: string): Promise<OfficeSettingsSnapshot>;
  setMeteredAccepted(provider: string, accepted: boolean): Promise<void>;
  close(): void;
}
