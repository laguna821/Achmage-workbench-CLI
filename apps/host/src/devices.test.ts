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

describe("remembered devices and registering the same device again", () => {
  function pair(registry: DeviceRegistry, input: { remember?: boolean; previousDeviceId?: string; name?: string } = {}, connection = connectionId) {
    const offer = registry.createOffer();
    const ticket = registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: input.name ?? "내 휴대폰", platform: "ios", connectionId: connection,
      ...(input.remember === undefined ? {} : { remember: input.remember }), ...(input.previousDeviceId === undefined ? {} : { previousDeviceId: input.previousDeviceId }) });
    return { offer, ticket };
  }
  function finish(registry: DeviceRegistry, ticket: { requestId: string; claimToken: string }, approval: DeviceApproval = { permissions: ["read"], workIds: ["work-a"] }, connection = connectionId) {
    const approved = registry.approve(ticket.requestId, approval);
    const result = registry.claimCredential({ requestId: ticket.requestId, claimToken: ticket.claimToken, connectionId: connection });
    if (result.status !== "approved") throw Error("Expected approved credential");
    return { ...result, approved };
  }

  it("shows the owner that a device asked to be remembered, and records since when only for that device", () => {
    const { registry, clock } = fixture();
    const asked = pair(registry, { remember: true });
    expect(registry.listPending()).toMatchObject([{ requestId: asked.ticket.requestId, remember: true }]);
    clock.at += 5_000;
    const remembered = finish(registry, asked.ticket);
    expect(remembered.grant.rememberedAt).toBe(clock.at);
    const plain = pair(registry, {}, "protected-connection-two");
    expect(registry.listPending()).toMatchObject([{ requestId: plain.ticket.requestId, remember: false }]);
    const session = finish(registry, plain.ticket, undefined, "protected-connection-two");
    expect(session.grant.rememberedAt).toBeNull();
    expect(registry.list().map(grant => [grant.deviceId, grant.rememberedAt]).sort()).toEqual(
      [[remembered.grant.deviceId, clock.at], [session.grant.deviceId, null]].sort());
  });

  it("ends a remembered device at once on revocation, also after a host restart, and at its expiry", () => {
    const { registry, directory, clock } = fixture();
    const kept = finish(registry, pair(registry, { remember: true }).ticket, { permissions: ["read"], workIds: ["work-a"], expiresAt: clock.at + 60_000 });
    const other = finish(registry, pair(registry, { remember: true }, "protected-connection-two").ticket, undefined, "protected-connection-two");
    expect(registry.authenticate(kept.credential)?.deviceId).toBe(kept.grant.deviceId);
    expect(kept.grant.rememberedAt).toBe(clock.at);
    registry.revoke(other.grant.deviceId);
    expect(registry.authenticate(other.credential)).toBeNull();
    registry.close();
    const restored = new DeviceRegistry(directory, "host-a", { now: () => clock.at });
    registries.push(restored);
    expect(restored.authenticate(other.credential)).toBeNull();
    expect(restored.authenticate(kept.credential)?.rememberedAt).toBe(kept.grant.rememberedAt);
    clock.at += 60_000;
    expect(restored.authenticate(kept.credential)).toBeNull();
  });

  it("names an earlier approval to the owner only when this host issued it, without telling the device", () => {
    const { registry } = fixture();
    const first = finish(registry, pair(registry).ticket);
    const again = pair(registry, { previousDeviceId: first.grant.deviceId }, "protected-connection-two");
    const stranger = pair(registry, { previousDeviceId: "00000000-0000-4000-8000-000000000000" }, "protected-connection-three");
    const pending = registry.listPending();
    expect(pending.find(request => request.requestId === again.ticket.requestId)?.previousDeviceId).toBe(first.grant.deviceId);
    expect(pending.find(request => request.requestId === stranger.ticket.requestId)?.previousDeviceId).toBeNull();
    expect(Object.keys(again.ticket).sort()).toEqual(Object.keys(stranger.ticket).sort());
    expect(JSON.stringify(again.ticket)).not.toContain(first.grant.deviceId);
  });

  it("removes the earlier approvals the owner chose when the same device registers again, and leaves the others", () => {
    const { registry, directory, clock } = fixture();
    const first = finish(registry, pair(registry, { remember: true }).ticket);
    const bystander = finish(registry, pair(registry, { name: "태블릿" }, "protected-connection-two").ticket, { permissions: ["read"], workIds: ["work-b"] }, "protected-connection-two");
    const events: DeviceRegistryEvent[] = [];
    registry.subscribe(event => events.push(event));
    const again = pair(registry, { remember: true, previousDeviceId: first.grant.deviceId }, "protected-connection-three");
    const second = finish(registry, again.ticket, { permissions: ["read"], workIds: ["work-a"], replaces: [first.grant.deviceId, "already-gone"] }, "protected-connection-three");
    expect(registry.list().map(grant => grant.deviceId).sort()).toEqual([bystander.grant.deviceId, second.grant.deviceId].sort());
    expect(registry.get(first.grant.deviceId)).toBeNull();
    expect(registry.authenticate(first.credential)).toBeNull();
    expect(registry.authenticate(second.credential)?.deviceId).toBe(second.grant.deviceId);
    expect(registry.authenticate(bystander.credential)?.workIds).toEqual(["work-b"]);
    // Open connections of the earlier approval learn it the same way as a revocation.
    expect(events).toContainEqual({ type: "revoked", deviceId: first.grant.deviceId });
    rejectsCode(() => registry.approve(pair(registry, {}, "protected-connection-four").ticket.requestId,
      { permissions: ["read"], workIds: ["work-a"], replaces: "everything" } as unknown as DeviceApproval), "invalid_input");
    registry.close();
    const restored = new DeviceRegistry(directory, "host-a", { now: () => clock.at });
    registries.push(restored);
    expect(restored.list().map(grant => grant.deviceId).sort()).toEqual([bystander.grant.deviceId, second.grant.deviceId].sort());
    expect(restored.authenticate(first.credential)).toBeNull();
  });

  it("takes a device off the list on the owner's request and ends its credential", () => {
    const { registry } = fixture();
    const first = finish(registry, pair(registry).ticket);
    const second = finish(registry, pair(registry, {}, "protected-connection-two").ticket, undefined, "protected-connection-two");
    const events: DeviceRegistryEvent[] = [];
    registry.subscribe(event => events.push(event));
    registry.remove(first.grant.deviceId);
    expect(registry.list().map(grant => grant.deviceId)).toEqual([second.grant.deviceId]);
    expect(registry.authenticate(first.credential)).toBeNull();
    expect(registry.authenticate(second.credential)).not.toBeNull();
    expect(events).toEqual([{ type: "revoked", deviceId: first.grant.deviceId }]);
    rejectsCode(() => registry.remove(first.grant.deviceId), "device_not_found");
  });

  it("accepts the device kind a real browser sends: a user agent of up to 160 characters", () => {
    const { registry } = fixture();
    // What the pairing screen sends is navigator.userAgent cut to 160 characters.
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
    expect(iphone.length).toBeGreaterThan(100);
    for (const [index, platform] of [iphone, "A".repeat(160)].entries()) {
      const offer = registry.createOffer();
      const ticket = registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "내 휴대폰", platform, connectionId: `protected-connection-${index}-agent` });
      expect(registry.listPending().find(request => request.requestId === ticket.requestId)?.platform).toBe(platform);
    }
    const offer = registry.createOffer();
    rejectsCode(() => registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "내 휴대폰", platform: "A".repeat(201), connectionId }), "invalid_input");
  });

  it("refuses a device name or kind with characters that reorder displayed text or are control codes", () => {
    const { registry } = fixture();
    // Written as escapes: a right-to-left override would make the approval card read differently from what was sent.
    const hostile = ["\u202e", "\u202a", "\u2066", "\u2069", "\u200e", "\u200f", "\u061c", "\u007f", "\u0085"];
    for (const [index, mark] of hostile.entries()) {
      const forName = registry.createOffer();
      rejectsCode(() => registry.requestPairing({ offerId: forName.offerId, token: forName.token, name: `내 휴대폰${mark}enohp`, platform: "ios", connectionId: `protected-connection-name-${index}` }), "invalid_input");
      const forKind = registry.createOffer();
      rejectsCode(() => registry.requestPairing({ offerId: forKind.offerId, token: forKind.token, name: "내 휴대폰", platform: `Safari${mark}`, connectionId: `protected-connection-kind-${index}` }), "invalid_input");
    }
    expect(registry.listPending()).toEqual([]);
    // Joined emoji and Korean are ordinary names: a zero-width joiner does not reorder anything.
    const offer = registry.createOffer();
    const ticket = registry.requestPairing({ offerId: offer.offerId, token: offer.token, name: "연구실 \ud83d\udc69\u200d\ud83d\udcbb 휴대폰", platform: "ios", connectionId });
    expect(registry.listPending()).toMatchObject([{ requestId: ticket.requestId, name: "연구실 \ud83d\udc69\u200d\ud83d\udcbb 휴대폰" }]);
  });

  it("reads a registry written before devices could be remembered", () => {
    const { registry, directory, clock } = fixture();
    const issued = finish(registry, pair(registry, { remember: true }).ticket);
    const waiting = pair(registry, { remember: true }, "protected-connection-two");
    registry.close();
    const file = join(directory, "devices", "registry.json");
    const older = JSON.parse(readFileSync(file, "utf8")) as { devices: { grant: Record<string, unknown> }[]; requests: Record<string, unknown>[] };
    for (const device of older.devices) delete device.grant.rememberedAt;
    for (const request of older.requests) { delete request.remember; delete request.previousDeviceId; }
    writeFileSync(file, JSON.stringify(older) + "\n", { mode: 0o600 });
    const restored = new DeviceRegistry(directory, "host-a", { now: () => clock.at });
    registries.push(restored);
    expect(restored.authenticate(issued.credential)?.rememberedAt).toBeNull();
    expect(restored.listPending()).toMatchObject([{ requestId: waiting.ticket.requestId, remember: false, previousDeviceId: null }]);
  });
});
