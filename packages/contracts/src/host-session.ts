export * from "./protocol.ts";
import { withParticle } from "./korean.ts";
import type { ProtocolDescriptor, ProtocolHandshake } from "./protocol.ts";
/** A process incarnation, separate from the durable host and its sessions. */
export type HostInstance = {
  hostId: string;
  instanceId: string;
  ownerPid: number;
  ownerStartedAt: string;
  protocolVersion: number;
  protocol?: ProtocolDescriptor;
  mode: "service" | "shell";
  version: string;
  buildId: string;
};
export type EventCursor = { epoch: string; seq: number };
/** The gateway's vault as the OS vault helper answered it (sec-vault round 2): `message` says why and what to do; never a secret. */
export type HostVaultStatus = { state: "unknown" | "open" | "refused"; reason: string | null; message: string | null };
export type HostStatus = { instance: HostInstance; cursor: EventCursor; state: "running" | "stopping"; activeTasks: number; compatibility?: ProtocolHandshake; update?: HostUpdateStatus; vault?: HostVaultStatus };
export type StopReceipt = { instanceId: string; state: "stopping" | "stopped"; requestedAt: number };

export type HostUpdateBlocker = { kind: "task" | "office" | "terminal"; id: string; label: string };
export type HostUpdateStatus = { state: "running" | "draining" | "ready" | "stopping"; requestedAt: number | null; blockers: HostUpdateBlocker[]; backupPath: string | null; schemaVersion: number };

/** How this copy of the app was installed; decides the asset and the install step (app-update). */
export type AppInstallKind = "nsis" | "msi" | "dmg" | "appimage" | "deb" | "pacman" | "user-folder" | "none";
/**
 * 설정 › 정보 › 업데이트 (app-update). Only the PC's own window asks; the gateway decides the address,
 * the file and the version from the verified manifest. `message` is one sentence with what to do.
 */
export type AppUpdateState = "idle" | "checking" | "latest" | "available" | "downloading" | "verifying" | "blocked" | "waiting" | "installing" | "saved" | "failed";
export type AppUpdateStatus = {
  state: AppUpdateState;
  installed: string;
  kind: AppInstallKind;
  /** False: the key saves the checked installer to the downloads folder (the fallback) instead of installing. */
  installable: boolean;
  /** The newer published version (only from a verified manifest). */
  available: { version: string; published: string | null; notes: string; releaseUrl: string } | null;
  /** 0–100 while downloading. */
  progress: number | null;
  /** The drain's own blocker labels while something is running or unsaved. */
  blockers: HostUpdateBlocker[];
  /** The fallback: where the checked installer was saved, and what to do with it. */
  saved: { path: string; instruction: string } | null;
  message: string | null;
  autoCheck: boolean;
  lastCheckedAt: number | null;
  /** The helper's line from the last install, shown once after the restart ("0.5.3으로 업데이트했습니다"). */
  lastResult: { ok: boolean; message: string; at: number } | null;
};
export type AppUpdateAction = "check" | "install" | "wait" | "cancel" | "dismiss" | "auto-on" | "auto-off";
/**
 * A version number read aloud in Korean ends in the last digit's sound: 영/삼/육 take 으로 and 이; 일/칠/팔
 * end in ㄹ (로, 이); 이/사/오/구 end in a vowel (로, 가). "0.5.3으로 업데이트했습니다", "0.5.2가 나왔습니다".
 */
export function versionWith(version: string, particle: "으로" | "이"): string {
  // Digits read in Korean, as the shared helper reads them (korean.ts).
  return withParticle(version, particle === "으로" ? "으로/로" : "이/가");
}
