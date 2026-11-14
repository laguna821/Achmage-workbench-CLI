/** Remote devices never inherit the local application's owner credential. */
export const DEVICE_PERMISSIONS = ["read", "send", "approve", "cancel", "terminal"] as const;
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number];

export type DeviceGrant = {
  deviceId: string;
  hostId: string;
  name: string;
  platform: string | null;
  permissions: DevicePermission[];
  /** An empty list grants no project access. Wildcards are not supported. */
  workIds: string[];
  createdAt: number;
  approvedAt: number;
  activatedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  credentialVersion: number;
  lastRotatedAt: number | null;
  /** When the owner approved a device that said it keeps its credential after its tab or app closes.
   * A record of what the device declared, not a limit the host enforces: expiry and revocation are. */
  rememberedAt?: number | null;
};

export type DeviceApproval = {
  permissions: DevicePermission[];
  workIds: string[];
  /** Omission defaults to 30 days. null explicitly chooses no expiry. */
  expiresAt?: number | null;
  /** Earlier approvals of this same device to take off the list with this approval. Removal only:
   * nothing of theirs (projects, permissions) carries over. */
  replaces?: string[];
};

/** token is returned only when the local user creates this single-use offer. */
export type PairingOffer = {
  offerId: string;
  hostId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
};

export type PairingRequest = {
  requestId: string;
  hostId: string;
  name: string;
  platform: string | null;
  /** Compare on both screens. This is not a public-key fingerprint. */
  verificationCode: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "rejected";
  deviceId: string | null;
  /** The device will keep its credential after its tab or app closes. */
  remember?: boolean;
  /** An approval this host issued earlier that the device names as its own. An unproven hint for
   * the owner, used only to offer removing that earlier entry. */
  previousDeviceId?: string | null;
};

export type PairingRequestInput = {
  offerId: string;
  token: string;
  name: string;
  platform?: string;
  remember?: boolean;
  previousDeviceId?: string;
  /** Injected by the protected gateway, never trusted from a request body. */
  connectionId: string;
};

export type PairingRequestTicket = {
  requestId: string;
  hostId: string;
  claimToken: string;
  verificationCode: string;
  expiresAt: number;
};

export type PairingCredentialClaim = {
  requestId: string;
  claimToken: string;
  /** Must identify the same live protected connection that requested pairing. */
  connectionId: string;
};

export type DeviceCredential = { grant: DeviceGrant; credential: string };
export type PairingCredentialResult =
  | { status: "pending"; requestId: string; expiresAt: number }
  | ({ status: "approved" } & DeviceCredential);

export type DeviceRegistryEvent = {
  type: "requested" | "approved" | "rejected" | "revoked" | "rotated" | "updated" | "expired";
  requestId?: string;
  deviceId?: string;
};

export type DeviceErrorCode =
  | "invalid_input" | "invalid_offer" | "offer_expired" | "offer_used"
  | "invalid_claim" | "pairing_expired" | "pairing_rejected" | "pairing_used" | "pairing_not_pending"
  | "device_not_found" | "invalid_credential" | "device_expired" | "device_revoked"
  | "permission_denied" | "work_scope_required" | "work_scope_denied"
  | "registry_unavailable" | "registry_limit";
