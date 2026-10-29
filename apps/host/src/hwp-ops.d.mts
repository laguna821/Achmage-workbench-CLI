import type { HwpFormat } from "../../../packages/contracts/src/hwp.ts";
export interface HwpOpResult { index: number; op: string; output: string; changed: boolean }
export interface HwpOpFailure { index: number; op: string; error: string; reason: string }
export interface HwpEditOutcome {
  bytes: Uint8Array; results: HwpOpResult[]; failures: HwpOpFailure[]; skipped: number;
  changed: boolean; trackingDropped: boolean;
}
export function editHwp(bytes: Uint8Array, format: HwpFormat, ops: unknown[], options?: { dryRun?: boolean; mode?: "atomic" | "best_effort" | "stop_on_error" }): Promise<HwpEditOutcome>;
export function hwpCatalog(): Promise<{ domain: string; fingerprint: string; groups: { name: string; summary?: string; ops: string[] }[]; ops: { op: string; signature: string; note?: string; schema?: unknown }[] }>;
