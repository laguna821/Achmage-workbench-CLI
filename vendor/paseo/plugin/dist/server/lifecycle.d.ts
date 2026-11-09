import type { AgentToolDefinition } from "./agent-tools.js";
import type { AgentPermissionRequest, AgentPermissionResponse, AgentTimelineItem, AgentSessionConfig, JsonValue } from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
export interface PluginHookContext {
    paseo: PaseoApi;
    signal: AbortSignal;
}
export interface PluginHookWorkspace {
    id: string;
    projectId: string;
    cwd: string;
    name: string | null;
    archivedAt: string | null;
    /** Data plugins stored on the workspace. Paseo never reads a key. */
    metadata: Record<string, JsonValue>;
}
export interface PluginHookWorktree {
    path: string;
    branch: string;
    sourceCheckout: string;
}
/** Resolved creation options before Git fetches refs or chooses a unique branch name. */
export type PluginWorktreeCreateRequest = {
    readonly repoRoot: string;
    readonly sourceCheckout: string;
    branch: string;
    slug: string;
    path: string;
} & ({
    kind: "branch-off";
    baseRef: string;
} | {
    kind: "checkout-branch";
} | {
    kind: "checkout-change-request";
    baseRef: string;
    forge: string;
    changeRequestNumber: number;
    headRef: string;
    headRepositoryOwner?: string;
    headRepository?: string;
    checkoutRefs?: {
        remoteName?: string;
        remoteRef: string;
    }[];
    pushRemoteUrl?: string;
    trackOriginHead?: boolean;
} | {
    kind: "checkout-github-pr";
    baseRef: string;
    githubPrNumber: number;
    headRef: string;
    headRepositoryOwner?: string;
    checkoutRefs?: {
        remoteName?: string;
        remoteRef: string;
    }[];
    pushRemoteUrl?: string;
    trackOriginHead?: boolean;
});
export interface PluginHookAgent {
    id: string;
    workspaceId: string | null;
    parentAgentId: string | null;
    provider: string;
    cwd: string;
    title: string | null;
    /** Data plugins stored on the agent. Paseo never reads a key. */
    metadata: Record<string, JsonValue>;
}
export interface PluginSessionOpenRequest {
    agentId: string;
    workspaceId: string | null;
    provider: string;
    cwd: string;
    reason: "create" | "resume" | "refresh" | "import";
    purpose: "interactive" | "history";
    readonly title: string | null;
    readonly labels: Readonly<Record<string, string>>;
    readonly metadata: Readonly<Record<string, JsonValue>>;
    tools: AgentToolDefinition[];
    env: Record<string, string>;
    mcpServers: NonNullable<AgentSessionConfig["mcpServers"]>;
}
export type PluginTurnOutcome = {
    kind: "completed";
} | {
    kind: "failed";
    error: {
        message: string;
        code?: string;
    };
} | {
    kind: "canceled";
    reason: string;
};
export interface PluginHookEvents {
    "agent.turn.before": {
        agent: PluginHookAgent;
        turnId: string | null;
    };
    "agent.turn.after": {
        agent: PluginHookAgent;
        turnId: string | null;
        outcome: PluginTurnOutcome;
        /**
         * @deprecated Always empty. Fetch history on demand with
         * context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 }).
         */
        timeline: readonly AgentTimelineItem[];
    };
    "agent.permission.before": {
        agent: PluginHookAgent;
        request: AgentPermissionRequest;
    };
    "agent.permission.after": {
        agent: PluginHookAgent;
        requestId: string;
        resolution: AgentPermissionResponse;
    };
    "agent.archive.after": {
        agent: PluginHookAgent;
        archivedAt: string;
    };
    "agent.create.after": {
        agent: PluginHookAgent;
    };
    "agent.close.after": {
        agent: PluginHookAgent;
    };
    "workspace.create.after": {
        workspace: PluginHookWorkspace;
    };
    "workspace.archive.after": {
        workspace: PluginHookWorkspace;
    };
}
export interface PluginHookRequests {
    "worktree.create.before": PluginWorktreeCreateRequest;
    "agent.create.before": {
        config: AgentSessionConfig;
        env?: Record<string, string>;
        /** Stored on the new agent. Always present in the payload; return it changed to change it. */
        metadata?: Record<string, JsonValue>;
    };
    "agent.open.before": PluginSessionOpenRequest;
    "workspace.create.before": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}
/** What a hook may return. An omitted `metadata` stays as it was. */
type PluginHookRequestResults = Omit<PluginHookRequests, "agent.open.before"> & {
    "agent.open.before": Omit<PluginSessionOpenRequest, "metadata"> & {
        metadata?: Readonly<Record<string, JsonValue>>;
    };
};
export type PluginHooks = {
    [Name in keyof PluginHookRequests]: {
        request: PluginHookRequests[Name];
        result: PluginHookRequestResults[Name];
    };
} & {
    [Name in keyof PluginHookEvents]: {
        payload: PluginHookEvents[Name];
    };
} & {
    "worktree.create.after": {
        payload: {
            worktree: PluginHookWorktree;
        };
    };
};
export type PluginHookPayload<Name extends keyof PluginHooks> = {
    [Key in keyof PluginHooks]: PluginHooks[Key] extends {
        request: infer Request;
    } ? {
        request: Request;
    } : PluginHooks[Key] extends {
        payload: infer Payload;
    } ? Payload : never;
}[Name];
export type PluginHookResult<Name extends keyof PluginHooks> = {
    [Key in keyof PluginHooks]: PluginHooks[Key] extends {
        result: infer Result;
    } ? Result | void : void;
}[Name];
type HookHandlers = {
    [Name in keyof PluginHooks]: (payload: PluginHookPayload<Name>, context: PluginHookContext) => Promise<PluginHookResult<Name>>;
};
export interface PluginLifecycleRegistration {
    addHook<Name extends keyof PluginHooks>(name: Name, handler: HookHandlers[Name]): () => void;
    /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
    on<Name extends keyof PluginLifecycleEvents>(name: Name, handler: (event: PluginLifecycleEvents[Name], context: PluginHookContext) => void | Promise<void>): () => void;
    /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
    before<Name extends keyof PluginBeforeRequests>(name: Name, handler: (input: {
        request: PluginBeforeRequests[Name];
    }, context: PluginHookContext) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>): () => void;
}
/** @internal Lifecycle policy shared by the daemon and plugin process. */
export declare const pluginHookRegistry: {
    readonly "workspace.create.before": {
        readonly waits: true;
    };
    readonly "workspace.create.after": {
        readonly waits: false;
    };
    readonly "workspace.archive.after": {
        readonly waits: false;
    };
    readonly "worktree.create.before": {
        readonly waits: true;
    };
    readonly "worktree.create.after": {
        readonly waits: true;
    };
    readonly "agent.create.before": {
        readonly waits: true;
    };
    readonly "agent.create.after": {
        readonly waits: false;
    };
    readonly "agent.open.before": {
        readonly waits: true;
    };
    readonly "agent.close.after": {
        readonly waits: false;
    };
    readonly "agent.archive.after": {
        readonly waits: false;
    };
    readonly "agent.turn.before": {
        readonly waits: false;
    };
    readonly "agent.turn.after": {
        readonly waits: false;
    };
    readonly "agent.permission.before": {
        readonly waits: false;
    };
    readonly "agent.permission.after": {
        readonly waits: false;
    };
};
declare const legacyEvents: {
    readonly "workspace.created": "workspace.create.after";
    readonly "workspace.archived": "workspace.archive.after";
    readonly "agent.created": "agent.create.after";
    readonly "agent.closed": "agent.close.after";
    readonly "agent.archived": "agent.archive.after";
    readonly "agent.turn_started": "agent.turn.before";
    readonly "agent.turn_ended": "agent.turn.after";
    readonly "agent.permission_requested": "agent.permission.before";
    readonly "agent.permission_resolved": "agent.permission.after";
};
declare const legacyRequests: {
    readonly "workspace.create": "workspace.create.before";
    readonly "agent.create": "agent.create.before";
    readonly "agent.session_open": "agent.open.before";
};
export type PluginLifecycleEvents = {
    [Name in keyof typeof legacyEvents]: PluginHookEvents[(typeof legacyEvents)[Name]];
};
export type PluginBeforeRequests = {
    [Name in keyof typeof legacyRequests]: PluginHookRequests[(typeof legacyRequests)[Name]];
};
/** @internal SDK adapter for the daemon's hook registry. */
export declare function createLifecycleRegistration(register: (name: keyof PluginHooks, handler: (input: never, context: PluginHookContext) => unknown) => () => void): PluginLifecycleRegistration;
export {};
