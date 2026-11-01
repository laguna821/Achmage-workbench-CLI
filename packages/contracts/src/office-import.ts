export type OfficeImportPreview = {
  id: string; directory: string; appAvailable: boolean;
  ai: null | { provider: string; keys: number; sealedKeys: number; replacesCurrent: boolean };
  preferences: null | { fields: string[]; replacesCurrent: boolean };
  markdown?: { theme: string | null; imageHost: { kind: string | null } | null; replacesCurrent: boolean };
  styles: { name: string; targetName: string; same: boolean }[];
  warnings: string[];
};
export type OfficeImportChoice = { id: string; ai: boolean; keys: boolean; styles: boolean; preferences?: boolean; markdownTheme?: boolean; imageHost?: boolean };
export type OfficeImportResult = { ai: boolean; styles: number; skipped: number; backup: string | null; preferences: boolean; preferenceBackup: string | null; markdownTheme?: boolean; imageHost?: boolean; markdownBackup?: string | null; errors: string[] };
