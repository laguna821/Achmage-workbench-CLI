import { createHash } from "node:crypto";
import { z } from "zod";
export const UsageScopeSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }),
    z.object({
        kind: z.literal("session"),
        provider: z.string(),
        model: z.string().optional(),
        env: z.record(z.string(), z.string()),
    }),
]);
export function windowFromUsedPct(input) {
    const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
    const window = {
        id: input.id,
        label: input.label,
        usedPct,
        remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
        resetsAt: input.resetsAt ?? null,
    };
    if (input.shortLabel !== undefined)
        window.shortLabel = input.shortLabel;
    if (input.summary)
        window.summary = true;
    if (input.tone)
        window.tone = input.tone;
    return window;
}
/**
 * Numeric provider windows have one identity and vocabulary, independent of response slots.
 * Pass null when the provider omits the duration; reset countdowns are not window lengths.
 * Named API fields (weekly, monthly, etc.) use windowFromUsedPct instead.
 */
export function windowFromReportedDuration(input) {
    const duration = input.durationSeconds;
    const name = duration !== null && Number.isFinite(duration) && duration > 0
        ? durationWindowName(duration)
        : input.unknown;
    const scope = input.scope;
    return windowFromUsedPct({
        id: scope ? `${scope.id}:${name.id}` : name.id,
        label: scope ? `${scope.label} · ${name.label}` : name.label,
        shortLabel: scope
            ? `${scope.label}${name.shortLabel ? ` ${name.shortLabel}` : ""}`
            : name.shortLabel,
        utilizationPct: input.utilizationPct,
        resetsAt: input.resetsAt,
        summary: input.summary,
        tone: input.tone,
    });
}
function durationWindowName(seconds) {
    if (seconds === 604800)
        return { id: "weekly", label: "Weekly", shortLabel: "wk" };
    const id = seconds === 18000 ? "five_hour" : `${seconds}s`;
    const units = [
        [86400, "day", "d"],
        [3600, "hour", "h"],
        [60, "minute", "m"],
        [1, "second", "s"],
    ];
    const unit = units.find(([size]) => seconds % size === 0) ?? units[units.length - 1];
    const amount = seconds / unit[0];
    return { id, label: `${amount}-${unit[1]}`, shortLabel: `${amount}${unit[2]}` };
}
/**
 * The tone scale for anything measured against a known limit, windows and balances alike.
 *
 * Thresholds match `deriveTone` in the app's provider-usage/tone.ts, which is what the
 * client falls back to when a window arrives without a tone. Healthy is "ok" rather than
 * "default" because that is what every provider setting a tone has always sent, and it is
 * what the bars render today below their thresholds.
 */
export function toneFromUsedPct(usedPct) {
    if (typeof usedPct !== "number")
        return "default";
    if (usedPct > 90)
        return "danger";
    if (usedPct >= 70)
        return "warning";
    return "ok";
}
/**
 * Tone for a balance with no known limit, where a percentage cannot be computed and the
 * only signal is whether anything is left. Prefer `toneFromUsedPct` when a limit exists:
 * this one stays "ok" until the balance is completely spent.
 */
export function balanceToneFromRemaining(remaining) {
    if (typeof remaining !== "number")
        return "default";
    if (remaining <= 0)
        return "danger";
    return "ok";
}
/** Percentage of a limit consumed, or null when either side is unknown. */
export function usedPctOf(used, limit) {
    if (typeof used !== "number" || typeof limit !== "number" || limit <= 0)
        return null;
    return (used / limit) * 100;
}
export function hashAccountKey(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function unavailable(problem) {
    return { status: "unavailable", problem };
}
