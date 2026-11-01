export type OfficeImportPreview = {
  id: string; directory: string; appAvailable: boolean;
  ai: null | { provider: string; keys: number; sealedKeys: number; replacesCurrent: boolean };
  styles: { name: string; targetName: string; same: boolean }[];
  warnings: string[];
};
export type OfficeImportChoice = { id: string; ai: boolean; keys: boolean; styles: boolean };
export type OfficeImportResult = { ai: boolean; styles: number; skipped: number; backup: string | null; errors: string[] };
