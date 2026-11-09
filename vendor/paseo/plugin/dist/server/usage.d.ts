import { z, type ZodType } from "zod";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
export interface UsageWindow {
    id: string;
    label: string;
    /**
     * A few characters naming the window where space is tight, e.g. "5h" or "wk". An empty string
     * shows the percent alone; leaving it out shows `label`.
     */
    shortLabel?: string;
    /** Shown in the usage summary until the user pins windows of their own. */
    summary?: boolean;
    usedPct?: number | null;
    remainingPct?: number | null;
    resetsAt?: string | null;
    runsOutAt?: string | null;
    shortfallPct?: number | null;
    tone?: "default" | "ok" | "warning" | "danger";
}
export interface UsageBalance {
    id: string;
    label: string;
    used?: number | null;
    remaining?: number | null;
    limit?: number | null;
    unit: "usd" | "credits" | "requests" | "tokens";
    resetsAt?: string | null;
    tone?: UsageWindow["tone"];
}
export interface UsageDetail {
    id: string;
    label: string;
    value: string;
    tone?: UsageWindow["tone"];
}
export type UsageProblem = {
    kind: "expired";
    expiresAt: string;
    refreshedBy?: string;
} | {
    kind: "rejected";
    status: number;
    refreshedBy?: string;
} | {
    kind: "no_quota";
    detail: string;
};
export type UsageReport = {
    status: "available";
    planLabel?: string;
    windows: UsageWindow[];
    balances?: UsageBalance[];
    details?: UsageDetail[];
} | {
    status: "unavailable";
    problem: UsageProblem;
} | {
    status: "error";
    error: string;
};
export interface UsageAccount {
    /** Stable across token rotation; [A-Za-z0-9._-]{1,128}. Never a credential or raw email. */
    key: string;
    label?: string;
    /** Harness owning this login, e.g. Codex, OpenCode, Pi or OMP. */
    harness?: string;
    /** Store locator, opaque to the daemon. */
    input: JsonValue;
}
export declare const UsageScopeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"global">;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"session">;
    provider: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    env: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strip>], "kind">;
export type UsageScope = z.infer<typeof UsageScopeSchema>;
export interface UsageSourceRegistration {
    id: string;
    label: string;
    icon?: string;
    input: ZodType;
    /** Accounts for this scope only. The same key in any scope identifies the same account. */
    discover(scope: UsageScope): Promise<UsageAccount[]>;
    /** Re-reads the login store; never writes it. */
    fetch(input: unknown): Promise<UsageReport>;
}
export declare function windowFromUsedPct(input: {
    id: string;
    label: string;
    shortLabel?: string;
    summary?: boolean;
    utilizationPct: number | null | undefined;
    resetsAt?: string | null;
    tone?: UsageWindow["tone"];
}): UsageWindow;
/**
 * Numeric provider windows have one identity and vocabulary, independent of response slots.
 * Pass null when the provider omits the duration; reset countdowns are not window lengths.
 * Named API fields (weekly, monthly, etc.) use windowFromUsedPct instead.
 */
export declare function windowFromReportedDuration(input: {
    durationSeconds: number | null;
    /** Stable quota identity and provider name for a model- or feature-scoped limit. */
    scope?: {
        id: string;
        label: string;
    };
    /** Neutral identity and names when the provider does not report a positive duration. */
    unknown: {
        id: string;
        label: string;
        shortLabel: string;
    };
    utilizationPct: number | null | undefined;
    resetsAt?: string | null;
    summary?: boolean;
    tone?: UsageWindow["tone"];
}): UsageWindow;
/**
 * The tone scale for anything measured against a known limit, windows and balances alike.
 *
 * Thresholds match `deriveTone` in the app's provider-usage/tone.ts, which is what the
 * client falls back to when a window arrives without a tone. Healthy is "ok" rather than
 * "default" because that is what every provider setting a tone has always sent, and it is
 * what the bars render today below their thresholds.
 */
export declare function toneFromUsedPct(usedPct: number | null | undefined): UsageWindow["tone"];
/**
 * Tone for a balance with no known limit, where a percentage cannot be computed and the
 * only signal is whether anything is left. Prefer `toneFromUsedPct` when a limit exists:
 * this one stays "ok" until the balance is completely spent.
 */
export declare function balanceToneFromRemaining(remaining: number | null | undefined): UsageBalance["tone"];
/** Percentage of a limit consumed, or null when either side is unknown. */
export declare function usedPctOf(used: number | null | undefined, limit: number | null | undefined): number | null;
export declare function hashAccountKey(value: string): string;
export declare function unavailable(problem: UsageProblem): UsageReport;
