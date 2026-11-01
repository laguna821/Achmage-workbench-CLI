export type DriveFixtureFile = { id: string; name: string; mimeType: string; bytes: Buffer | string; version?: number; canEdit?: boolean; parents?: string[] };
export function googleDriveFixture(initial?: DriveFixtureFile[]): {
  files: Map<string, Required<Omit<DriveFixtureFile, "bytes">> & { bytes: Buffer }>;
  fetch(address: string, init?: RequestInit): Promise<Response>;
  uploads: { id: string; created: boolean; name: string; bytes: Buffer }[];
  requests: { url: string; method: string }[];
  readonly revoked: boolean;
  setTokenFailure(value: boolean): void;
};
