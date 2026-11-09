import { z } from "zod";
import type { AgentToolDefinition, AgentToolResult, PluginHookContext, PluginSessionOpenRequest, PluginHookAgent } from "@getpaseo/plugin/server";
export declare const agentToolMetadataSchema: z.ZodObject<{
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodString;
    inputSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    pluginId: z.ZodOptional<z.ZodString>;
    pluginInstanceId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type AgentToolMetadata = z.infer<typeof agentToolMetadataSchema>;
export type AttachedAgentTool = AgentToolMetadata & {
    pluginId: string;
    pluginInstanceId: string;
};
export type SessionOpenWireRequest = Omit<PluginSessionOpenRequest, "tools"> & {
    tools: AgentToolMetadata[];
};
export interface PluginAgentToolsRuntime {
    isToolPluginAvailable(pluginId: string, pluginInstanceId: string): boolean;
    detachTools(agentId: string): void;
    callTool(pluginId: string, pluginInstanceId: string, agent: PluginHookAgent, name: string, input: unknown, signal?: AbortSignal): Promise<AgentToolResult>;
}
export declare function serializeAgentTool(tool: AgentToolDefinition): AgentToolMetadata;
export declare class PluginAgentTools {
    private readonly agents;
    private readonly calls;
    attach(agentId: string, tools: AgentToolDefinition[]): AgentToolMetadata[];
    detach(agentId: string): void;
    cancel(requestId: string): void;
    close(): void;
    call(requestId: string, agent: PluginHookAgent, name: string, input: unknown, paseo: PluginHookContext["paseo"]): Promise<AgentToolResult>;
}
