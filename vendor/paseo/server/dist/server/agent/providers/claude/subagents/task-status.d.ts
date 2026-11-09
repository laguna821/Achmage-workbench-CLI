import type { ProviderSubagentStatus } from "../../../provider-subagents/ports.js";
/**
 * The descriptor has no paused or pending state, and neither is terminal, so both read as
 * running. `killed` is a cancellation, not a failure — the child was stopped, it did not error.
 */
export declare function mapTaskStatus(status: string | undefined): ProviderSubagentStatus | undefined;
