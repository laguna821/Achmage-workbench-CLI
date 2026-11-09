import type { PluginHookPayload } from "@getpaseo/plugin/server";
import type { PluginWireBeforeRequests, PluginBeforeResults } from "./lifecycle/index.js";
import type { UsageScope } from "@getpaseo/plugin/server/usage";
import { type ProviderStatus, type ProviderStatusRequest } from "@getpaseo/plugin/server/provider";
import type { PluginHookEvents, PluginHookAgent, AgentToolResult } from "@getpaseo/plugin/server";
import type pino from "pino";
import { type ProviderConnectRequest, type ProviderCatalogOptions, type ProviderConnection } from "@getpaseo/plugin/server/provider";
import type { PluginLogEntry } from "@getpaseo/protocol/messages";
import type { PluginRequirements } from "@getpaseo/protocol/messages";
import type { PluginProcessRequest, PluginProviderMetadata, PluginUsageSourceMetadata } from "./plugin-process-protocol.js";
import { type PluginRuntimeSubscription } from "./runtime-subscription.js";
import { PluginSessionSocket } from "./session-socket.js";
interface PluginOutputStream {
    on(event: "data", listener: (chunk: Buffer | string) => void): this;
}
interface PluginChild {
    connected: boolean;
    killed: boolean;
    stdout?: PluginOutputStream | null;
    stderr?: PluginOutputStream | null;
    send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean;
    kill(signal?: NodeJS.Signals): boolean;
    disconnect(): void;
    on(event: "message", listener: (message: unknown) => void): this;
    on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}
interface PluginRuntimeDependencies {
    settingsDirectory?: string;
    onSettingsChanged?: (pluginId: string, settingsId: string) => void;
    spawnChild?: () => PluginChild;
    sessionHost?: PluginPaseoSessionHost;
}
export interface PluginPaseoSessionHost {
    attachPluginSocket(pluginId: string, socket: PluginSessionSocket): Promise<{
        closed: Promise<void>;
    }>;
}
export declare class PluginRuntime {
    private readonly daemonVersion;
    private readonly dependencies;
    private readonly plugins;
    private readonly pendingEvents;
    private readonly logTails;
    private readonly logger;
    private readonly spawnChild;
    private sessionHost;
    private readonly listeners;
    private readonly sessionOpenListeners;
    constructor(logger: pino.Logger, daemonVersion: string, dependencies?: PluginRuntimeDependencies);
    bindPaseoSessionHost(sessionHost: PluginPaseoSessionHost): void;
    subscribe(listener: (pluginId: string, error?: string) => void): () => void;
    subscribeSessionOpenChanges(listener: () => void): () => void;
    private notifySessionOpenChange;
    startPlugin(pluginId: string, configuredPath: string, canPublish?: () => boolean): Promise<void>;
    startBuiltinPlugin(_input: {
        id: string;
        directory: string;
    }): Promise<void>;
    validatePlugin(configuredPath: string): Promise<void>;
    stopPluginById(pluginId: string): Promise<boolean>;
    catalog(): Array<{
        id: string;
        clientBundle: string;
        clientBundleHash: string;
        requirements?: PluginRequirements;
    }>;
    getProviderRegistrations(pluginId: string): readonly PluginProviderMetadata[];
    getUsageSourceRegistrations(pluginId: string): readonly PluginUsageSourceMetadata[];
    fetchUsage(pluginId: string, sourceId: string, input: unknown): Promise<unknown>;
    discoverUsage(pluginId: string, sourceId: string, scope: UsageScope): Promise<unknown>;
    getProviderStatus(pluginId: string, providerId: string, request: ProviderStatusRequest): Promise<ProviderStatus>;
    connectProvider(pluginId: string, providerId: string, request: ProviderConnectRequest): Promise<ProviderConnection>;
    getLogs(pluginId: string): PluginLogEntry[];
    clearLogs(pluginId: string): void;
    invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
    /** Starts one subscriber's handler in the plugin process. */
    startSubscription(pluginId: string, method: string, input: unknown): PluginRuntimeSubscription;
    emit<Name extends keyof PluginHookEvents>(name: Name, event: PluginHookEvents[Name]): void;
    drainEvents(): Promise<void>;
    wait(name: "worktree.create.after", payload: PluginHookPayload<"worktree.create.after">): Promise<void>;
    before<Name extends keyof PluginWireBeforeRequests>(name: Name, input: PluginWireBeforeRequests[Name]): Promise<PluginBeforeResults[Name]>;
    getProviderCatalogCacheKey(pluginId: string, providerId: string, options: ProviderCatalogOptions): Promise<string | undefined>;
    private collectMcpServers;
    private collectAgentTools;
    isToolPluginAvailable(pluginId: string, pluginInstanceId: string): boolean;
    detachTools(agentId: string): void;
    callTool(pluginId: string, pluginInstanceId: string, agent: PluginHookAgent, name: string, input: unknown, signal?: AbortSignal): Promise<AgentToolResult>;
    private request;
    stopAll(): Promise<void>;
    private loadDirectoryPlugin;
    private launchPlugin;
    /**
     * Frames still in flight belong to the closed session; only a fresh hello
     * means the child redialled and wants a new one. Attaching on the close
     * instead would leave a socket nobody speaks to until the host's hello
     * timeout closed it, and that close would attach another.
     */
    private routePluginFrame;
    private reattachPluginSession;
    /**
     * A published plugin whose process is still up. Anything else is either still
     * loading or being torn down, and must not get a new session.
     */
    private canReattachPluginSession;
    private handleChildMessage;
    private handleProviderMessage;
    private finishProviderConnect;
    private abandonProviderConnect;
    private sendProviderInput;
    private closeProviderConnection;
    private publishProviderEvent;
    private failProviderConnection;
    private trackAcceptedProviderInput;
    private handleMalformedChildMessage;
    private failRemoteProviderConnection;
    private rejectProviderSends;
    private handleChildClose;
    private stopPlugin;
    /** Rejects in-flight requests and closes open subscriptions with the reason. */
    private rejectPending;
    private appendLog;
    private notify;
}
export {};
