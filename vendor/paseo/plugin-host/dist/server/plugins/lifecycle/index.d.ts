import { type SessionOpenWireRequest, type PluginAgentTools } from "../agent-tools.js";
import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent, PluginHookPayload, PluginHookContext, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import type { PluginHookRequests, PluginHookWorkspace, PluginHookEvents } from "@getpaseo/plugin/server";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";
export type PluginWireBeforeRequests = Omit<PluginHookRequests, "agent.open.before"> & {
    "agent.open.before": SessionOpenWireRequest;
};
/** Daemon-only results; ownership never crosses the plugin process boundary. */
export type PluginBeforeResults = PluginWireBeforeRequests & {
    "agent.open.before": SessionOpenWireRequest & {
        mcpServerOwners?: Record<string, string>;
    };
};
export interface PluginLifecycle {
    wait(name: "worktree.create.after", payload: PluginHookPayload<"worktree.create.after">): Promise<void>;
    emit<Name extends keyof PluginHookEvents>(name: Name, event: PluginHookEvents[Name]): void;
    before<Name extends keyof PluginWireBeforeRequests>(name: Name, request: PluginWireBeforeRequests[Name]): Promise<PluginBeforeResults[Name]>;
}
export declare function validateBeforeRequest<Name extends keyof PluginWireBeforeRequests>(name: Name, value: unknown): PluginWireBeforeRequests[Name];
export declare function describeHookWorkspace(workspace: PersistedWorkspaceRecord): PluginHookWorkspace;
export declare function describeHookAgent(agent: {
    id: string;
    workspaceId?: string;
    provider: string;
    cwd: string;
    title?: string | null;
    labels: Record<string, string>;
    metadata: Record<string, JsonValue>;
}): PluginHookAgent;
export declare function publishAgentStream(lifecycle: PluginLifecycle, agent: PluginHookAgent, event: AgentStreamEvent): void;
export declare function validateBeforeResult<Name extends keyof PluginWireBeforeRequests>(name: Name, input: PluginWireBeforeRequests[Name], output: unknown): Promise<PluginWireBeforeRequests[Name]>;
export declare class PluginHookHandlers implements PluginLifecycleRegistration {
    private readonly handlers;
    private readonly active;
    private readonly changed;
    private readonly agentTools;
    constructor(changed: () => void, agentTools?: PluginAgentTools);
    readonly addHook: PluginLifecycleRegistration["addHook"];
    readonly on: PluginLifecycleRegistration["on"];
    readonly before: PluginLifecycleRegistration["before"];
    catalog(): string[];
    invoke(id: string, name: string, input: unknown, paseo: PluginHookContext["paseo"]): Promise<unknown>;
    private openSession;
    cancel(id: string): void;
    close(): void;
    private register;
}
