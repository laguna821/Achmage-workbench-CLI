import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
export const agentToolMetadataSchema = z
    .object({
    name: z
        .string()
        .regex(/^[a-z][a-z0-9_]*$/)
        .max(64),
    title: z.string().optional(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    pluginId: z.string().optional(),
    pluginInstanceId: z.string().optional(),
})
    .strict();
export function serializeAgentTool(tool) {
    return agentToolMetadataSchema.parse({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: toJsonSchemaCompat(tool.input, { strictUnions: true, pipeStrategy: "input" }),
    });
}
// This store lives only in the plugin process. Definitions and parsed values never cross IPC.
export class PluginAgentTools {
    agents = new Map();
    calls = new Map();
    attach(agentId, tools) {
        const names = new Set();
        const metadata = tools.map((tool) => {
            const serialized = serializeAgentTool(tool);
            if (names.has(tool.name))
                throw new Error(`Duplicate agent tool: ${tool.name}`);
            names.add(tool.name);
            return serialized;
        });
        this.agents.set(agentId, tools);
        return metadata;
    }
    detach(agentId) {
        this.agents.delete(agentId);
        for (const call of this.calls.values()) {
            if (call.agentId === agentId)
                call.controller.abort();
        }
    }
    cancel(requestId) {
        this.calls.get(requestId)?.controller.abort();
    }
    close() {
        for (const call of this.calls.values())
            call.controller.abort();
        this.agents.clear();
    }
    async call(requestId, agent, name, input, paseo) {
        const controller = new AbortController();
        this.calls.set(requestId, { agentId: agent.id, controller });
        try {
            const tool = this.agents.get(agent.id)?.find((definition) => definition.name === name);
            if (!tool)
                throw new Error(`Agent tool not attached: ${name}`);
            const parsed = await tool.input.parseAsync(input);
            controller.signal.throwIfAborted();
            const result = await tool.execute(parsed, { agent, paseo, signal: controller.signal });
            controller.signal.throwIfAborted();
            return result;
        }
        catch (error) {
            return { isError: true, text: error instanceof Error ? error.message : String(error) };
        }
        finally {
            this.calls.delete(requestId);
        }
    }
}
