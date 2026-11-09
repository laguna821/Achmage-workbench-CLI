import type { PaseoApi } from "@getpaseo/client";
import type { z } from "zod";
import type { PluginHookAgent } from "./lifecycle.js";
export interface AgentToolContext {
    agent: PluginHookAgent;
    paseo: PaseoApi;
    signal: AbortSignal;
}
export interface AgentToolResult {
    text?: string;
    structuredContent?: unknown;
    isError?: boolean;
}
export interface AgentToolDefinition {
    name: string;
    title?: string;
    description: string;
    input: z.ZodType;
    execute(input: unknown, context: AgentToolContext): AgentToolResult | Promise<AgentToolResult>;
}
export declare function defineAgentTool<Input extends z.ZodType>(tool: {
    name: string;
    title?: string;
    description: string;
    input: Input;
    execute(input: z.output<Input>, context: AgentToolContext): AgentToolResult | Promise<AgentToolResult>;
}): AgentToolDefinition;
