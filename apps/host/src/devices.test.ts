import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceApproval, DeviceRegistryEvent } from "@workbench/contracts";
import { DeviceRegistry, DeviceRegistryError } from "./devices.ts";

const roots: string[] = [];
const registries: DeviceRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  vi.useRealTimers();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(now?: () => number) {
  const directory = mkdtempSync(join(tmpdir(), "workbench-devices-"));
  roots.push(directory);
  const clock = { at: 1_000_000 };
  const registry = new DeviceRegistry(directory, "host-a", { now: now ?? (() => clock.at) });
  registries.push(registry);
  return { directory, clock, registry };
}
function rejectsCode(action: () => unknown, code: string) {
  try { action(); throw Error("Expected registry rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(DeviceRegistryError);
    expect((error as DeviceRegistryError).code).toBe(code);
  }
}
const connectionId = "protected-connection-one";
function enroll(registry: DeviceRegistry, approval: DeviceApproval = { permissions: ["read", "send"], workIds: ["work-a"] }, connection = connectionId) {
  const offer = registry.createOffer();
  const ticket = registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "내 휴대폰", platform: "ios", connectionId: connection });
  const approved = registry.approve(ticket.requestId, approval);
  const result = registry.claimCredential({ requestId: ticket.requestId, claimToken: ticket.claimToken, connectionId: connection });
  if (result.status !== "approved") throw Error("Expected approved credential");
  return { ...result, offer, ticket, approved };
}

describe("DeviceRegistry pairing and scoped authority", () => {
  it("consumes an offer before approval and delivers the credential once to its original protected connection", () => {
    const { registry } = fixture();
    const offer = registry.createOffer();
    const ticket = registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "휴대폰", connectionId });
    expect(registry.list()).toEqual([]);
    expect(registry.listPending()).toMatchObject([{ requestId: ticket.requestId, verificationCode: ticket.verificationCode, status: "pending" }]);
    expect(JSON.stringify(registry.listPending())).not.toContain(ticket.claimToken);
    rejectsCode(() => registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "복사한 링크", connectionId: "another-protected-connection" }), "offer_used");
    const claim = { requestId: ticket.requestId, claimToken: ticket.claimToken, connectionId };
    expect(registry.claimCredential(claim).status).toBe("pending");
    const approved = registry.approve(ticket.requestId, { permissions: ["read", "send"], workIds: ["work-a"] });
    expect(approved.activatedAt).toBeNull();
    expect(approved).not.toHaveProperty("credential");
    rejectsCode(() => registry.claimCredential({ ...claim, connectionId: "another-protected-connection" }), "invalid_claim");
    rejectsCode(() => registry.claimCredential({ ...claim, claimToken: "not-the-device-claim-token" }), "invalid_claim");
    const result = registry.claimCredential(claim);
    if (result.status !== "approved") throw Error("Expected credential");
    expect(registry.authorize(result.credential, "send", "work-a").deviceId).toBe(approved.deviceId);
    expect(result.grant.activatedAt).not.toBeNull();
    expect(registry.listPending()).toEqual([]);
    rejectsCode(() => registry.claimCredential(claim), "pairing_used");
    expect(registry.authenticate(offer.token)).toBeNull();
    expect(registry.authenticate(ticket.claimToken)).toBeNull();
    expect(registry.authenticate("local-owner-global-token")).toBeNull();
  });

  it("keeps each device's explicit permission and project scope independent", () => {
    const { registry } = fixture();
    const reader = enroll(registry, { permissions: ["read"], workIds: ["work-a"] });
    const terminal = enroll(registry, { permissions: ["read", "terminal"], workIds: ["work-b"] }, "protected-connection-two");
    expect(registry.authorize(reader.credential, "read").workIds).toEqual(["work-a"]);
    rejectsCode(() => registry.authorize(reader.credential, "send", "work-a"), "permission_denied");
    rejectsCode(() => registry.authorize(reader.credential, "read", "work-b"), "work_scope_denied");
    rejectsCode(() => registry.authorize(terminal.credential, "terminal"), "work_scope_required");
    expect(registry.authorize(terminal.credential, "terminal", "work-b").deviceId).toBe(terminal.grant.deviceId);
    registry.update(reader.grant.deviceId, { permissions: ["read"], workIds: [] });
    expect(registry.authorize(reader.credential, "read").workIds).toEqual([]);
    rejectsCode(() => registry.authorize(reader.credential, "read", "work-a"), "work_scope_denied");
    rejectsCode(() => registry.update(reader.grant.deviceId, { permissions: ["read"], workIds: ["*"] }), "invalid_input");
    rejectsCode(() => registry.update(reader.grant.deviceId, { permissions: ["owner"], workIds: ["work-a"] } as unknown as DeviceApproval), "invalid_input");
  });

  it("denies expired offers, expired approvals, rejected claims and canceled offers", () => {
    const { registry, clock } = fixture();
    const expired = registry.createOffer({ ttlMs: 1000 });
    clock.at += 1000;
    rejectsCode(() => registry.requestPairing({ offerId: expired.offerId, token: expired.token, name: "late", connectionId }), "offer_expired");
    const offer = registry.createOffer({ ttlMs: 1000 });
    const ticket = registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "pending", connectionId });
    registry.approve(ticket.requestId, { permissions: ["read"], workIds: ["work-a"] });
    clock.at += 1000;
    rejectsCode(() => registry.claimCredential({ requestId: ticket.requestId, claimToken: ticket.claimToken, connectionId }), "pairing_expired");
    const canceled = registry.createOffer();
    registry.revokeOffer(canceled.offerId);
    rejectsCode(() => registry.requestPairing({ offerId: canceled.offerId, token: canceled.token, name: "canceled", connectionId }), "offer_used");
    const rejectedOffer = registry.createOffer();
    const rejected = registry.requestPairing({ offerId: rejectedOffer.offerId, token: rejectedOffer.token, name: "rejected", connectionId });
    registry.reject(rejected.requestId);
    rejectsCode(() => registry.claimCredential({ requestId: rejected.requestId, claimToken: rejected.claimToken, connectionId }), "pairing_rejected");
    expect(registry.listPending()).toEqual([]);
  });

  it("persists only hashes in a private file and survives an owned host restart", () => {
    const { registry, directory, clock } = fixture();
    const issued = enroll(registry);
    const file = join(directory, "devices", "registry.json");
    const persisted = readFileSync(file, "utf8");
    for (const secret of [issued.offer.token, issued.ticket.claimToken, issued.credential, connectionId]) expect(persisted).not.toContain(secret);
    if (process.platform !== "win32") {
      expect(lstatSync(join(directory, "devices")).mode & 0o777).toBe(0o700);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
    }
    registry.close();
    const restored = new DeviceRegistry(directory, "host-a", { now: () => clock.at });
    registries.push(restored);
    expect(restored.authorize(issued.credential, "send", "work-a").deviceId).toBe(issued.grant.deviceId);
    rejectsCode(() => restored.claimCredential({ requestId: issued.ticket.requestId, claimToken: issued.ticket.claimToken, connectionId }), "pairing_used");
    expect(() => new DeviceRegistry(directory, "another-host")).toThrow(DeviceRegistryError);
  });

  it("rotates only the authenticated device and durably revokes old credentials without touching other devices", () => {
    const { registry, directory, clock } = fixture();
    const first = enroll(registry);
    const second = enroll(registry, { permissions: ["read"], workIds: ["work-b"] }, "protected-connection-two");
    const events: DeviceRegistryEvent[] = [];
    registry.subscribe((event) => events.push(event));
    const rotated = registry.rotate(first.credential);
    expect(rotated.credential).not.toBe(first.credential);
    expect(rotated.grant.credentialVersion).toBe(2);
    expect(registry.authenticate(first.credential)).toBeNull();
    expect(registry.authenticate(rotated.credential)?.deviceId).toBe(first.grant.deviceId);
    rejectsCode(() => registry.rotate(first.credential), "invalid_credential");
    registry.revoke(first.grant.deviceId);
    expect(registry.authenticate(rotated.credential)).toBeNull();
    expect(registry.authenticate(second.credential)?.deviceId).toBe(second.grant.deviceId);
    rejectsCode(() => registry.update(first.grant.deviceId, { permissions: ["read"], workIds: ["work-a"] }), "device_revoked");
    expect(events.map((event) => event.type)).toEqual(["rotated", "revoked"]);
    registry.close();
    const restored = new DeviceRegistry(directory, "host-a", { now: () => clock.at });
    registries.push(restored);
    expect(restored.authenticate(first.credential)).toBeNull();
    expect(restored.authenticate(rotated.credential)).toBeNull();
    expect(restored.authenticate(second.credential)).not.toBeNull();
  });

  it("notifies open gateways at grant expiry and refuses subsequent scoped commands", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { registry } = fixture(Date.now);
    const issued = enroll(registry, { permissions: ["read", "cancel"], workIds: ["work-a"], expiresAt: Date.now() + 1500 });
    const events: DeviceRegistryEvent[] = [];
    registry.subscribe((event) => events.push(event));
    vi.advanceTimersByTime(1500);
    expect(events).toContainEqual({ type: "expired", deviceId: issued.grant.deviceId });
    expect(registry.authenticate(issued.credential)).toBeNull();
    rejectsCode(() => registry.authorize(issued.credential, "cancel", "work-a"), "invalid_credential");
    rejectsCode(() => registry.update(issued.grant.deviceId, { permissions: ["read"], workIds: ["work-a"], expiresAt: Date.now() + 5000 }), "device_expired");
    expect(events.filter((event) => event.type === "expired")).toHaveLength(1);
  });

  it("preserves a corrupt registry instead of resetting authority and rejects symlink-backed stores", () => {
    const { registry, directory } = fixture();
    const file = join(directory, "devices", "registry.json");
    registry.close();
    writeFileSync(file, "{broken", { mode: 0o600 });
    expect(() => new DeviceRegistry(directory, "host-a")).toThrow(DeviceRegistryError);
    expect(readFileSync(file, "utf8")).toBe("{broken");
    if (process.platform !== "win32") {
      const external = join(directory, "external.json");
      writeFileSync(external, "untouched", { mode: 0o600 });
      rmSync(file);
      symlinkSync(external, file);
      expect(() => new DeviceRegistry(directory, "host-a")).toThrow(DeviceRegistryError);
      expect(readFileSync(external, "utf8")).toBe("untouched");
    }
  });

  it("does not acknowledge a grant change when private persistence has become unsafe", () => {
    if (process.platform === "win32") return;
    const { registry, directory } = fixture();
    const issued = enroll(registry);
    const file = join(directory, "devices", "registry.json");
    chmodSync(file, 0o644);
    rejectsCode(() => registry.revoke(issued.grant.deviceId), "registry_unavailable");
    expect(registry.get(issued.grant.deviceId)?.revokedAt).toBeNull();
    chmodSync(file, 0o600);
    registry.revoke(issued.grant.deviceId);
    expect(registry.authenticate(issued.credential)).toBeNull();
  });
});
