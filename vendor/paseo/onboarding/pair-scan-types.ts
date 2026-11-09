// Type-only extraction from upstream/runtime/host-runtime.ts at the pinned Paseo revision.
// Workbench never uses the upstream password branch; LinkPairing is opaque in this decoder adapter.
export interface PasswordRequiredPairing { link: string; pairing: unknown; }
export type ConnectionLinkImport =
  | { status: "connected"; serverId: string }
  | ({ status: "password_required" } & PasswordRequiredPairing)
  | { status: "cancelled" };
