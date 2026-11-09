import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import { createLifecycleRegistration, pluginHookRegistry, } from "@getpaseo/plugin/internal/lifecycle";
import { isDeepStrictEqual } from "node:util";
import { serializeAgentTool, agentToolMetadataSchema, } from "../agent-tools.js";
import { z } from "zod";
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
const worktreeRequestFields = {
    repoRoot: z.string(),
    sourceCheckout: z.string(),
    branch: z.string().min(1),
    slug: z.string().refine((value) => validateBranchSlug(value).valid, "Invalid worktree slug"),
    path: z.string().min(1),
};
const changeRequestFields = {
    headRef: z.string().min(1),
    headRepositoryOwner: z.string().optional(),
    checkoutRefs: z
        .array(z.object({ remoteName: z.string().optional(), remoteRef: z.string() }))
        .optional(),
    pushRemoteUrl: z.string().optional(),
    trackOriginHead: z.boolean().optional(),
};
const worktreeRequestSchema = z.discriminatedUnion("kind", [
    z
        .object({ ...worktreeRequestFields, kind: z.literal("branch-off"), baseRef: z.string().min(1) })
        .strict(),
    z
        .object({
        ...worktreeRequestFields,
        kind: z.literal("checkout-branch"),
    })
        .strict(),
    z
        .object({
        ...worktreeRequestFields,
        ...changeRequestFields,
        kind: z.literal("checkout-change-request"),
        baseRef: z.string().min(1),
        forge: z.string(),
        changeRequestNumber: z.number().int().positive(),
        headRepository: z.string().optional(),
    })
        .strict(),
    z
        .object({
        ...worktreeRequestFields,
        ...changeRequestFields,
        kind: z.literal("checkout-github-pr"),
        baseRef: z.string().min(1),
        githubPrNumber: z.number().int().positive(),
    })
        .strict(),
]);
const beforeSchemas = {
    "worktree.create.before": worktreeRequestSchema,
    "agent.create.before": CreateAgentRequestMessageSchema.pick({
        config: true,
        env: true,
        metadata: true,
    }).strict(),
    "agent.open.before": z
        .object({
        agentId: z.string(),
        workspaceId: z.string().nullable(),
        provider: z.string(),
        cwd: z.string(),
        reason: z.enum(["create", "resume", "refresh", "import"]),
        purpose: z.enum(["interactive", "history"]),
        title: z.string().nullable(),
        labels: z.record(z.string(), z.string()),
        // Optional so a plugin that returns its own object keeps working; omitted means unchanged.
        metadata: z.record(z.string(), z.custom()).optional(),
        tools: z.array(agentToolMetadataSchema),
        env: z.record(z.string(), z.string()),
        mcpServers: CreateAgentRequestMessageSchema.shape.config.shape.mcpServers.unwrap(),
    })
        .strict(),
    "workspace.create.before": WorkspaceCreateRequestSchema.omit({
        type: true,
        requestId: true,
    }).strict(),
};
const sessionOpenLocalResultSchema = beforeSchemas["agent.open.before"].extend({
    tools: z.array(z.custom((tool) => typeof tool === "object" &&
        tool !== null &&
        "input" in tool &&
        "execute" in tool &&
        typeof tool.execute === "function")),
});
export function validateBeforeRequest(name, value) {
    return beforeSchemas[name].parse(value);
}
export function describeHookWorkspace(workspace) {
    return {
        id: workspace.workspaceId,
        projectId: workspace.projectId,
        cwd: workspace.cwd,
        name: workspace.title,
        archivedAt: workspace.archivedAt,
        metadata: workspace.metadata,
    };
}
export function describeHookAgent(agent) {
    return {
        id: agent.id,
        workspaceId: agent.workspaceId ?? null,
        parentAgentId: agent.labels[PARENT_AGENT_ID_LABEL] ?? null,
        provider: agent.provider,
        cwd: agent.cwd,
        title: agent.title ?? null,
        metadata: agent.metadata,
    };
}
export function publishAgentStream(lifecycle, agent, event) {
    if (event.type === "turn_started") {
        lifecycle.emit("agent.turn.before", { agent, turnId: event.turnId ?? null });
    }
    else if (event.type === "turn_completed") {
        lifecycle.emit("agent.turn.after", {
            agent,
            turnId: event.turnId ?? null,
            timeline: [],
            outcome: { kind: "completed" },
        });
    }
    else if (event.type === "turn_failed") {
        lifecycle.emit("agent.turn.after", {
            agent,
            turnId: event.turnId ?? null,
            timeline: [],
            outcome: { kind: "failed", error: { message: event.error, code: event.code } },
        });
    }
    else if (event.type === "turn_canceled") {
        lifecycle.emit("agent.turn.after", {
            agent,
            turnId: event.turnId ?? null,
            timeline: [],
            outcome: { kind: "canceled", reason: event.reason },
        });
    }
    else if (event.type === "permission_requested") {
        lifecycle.emit("agent.permission.before", { agent, request: event.request });
    }
    else if (event.type === "permission_resolved") {
        lifecycle.emit("agent.permission.after", {
            agent,
            requestId: event.requestId,
            resolution: event.resolution,
        });
    }
}
export async function validateBeforeResult(name, input, output) {
    const result = validateBeforeRequest(name, output);
    if (name === "agent.open.before") {
        const previous = beforeSchemas["agent.open.before"].parse(input);
        const next = beforeSchemas["agent.open.before"].parse(result);
        if (previous.agentId !== next.agentId ||
            previous.workspaceId !== next.workspaceId ||
            previous.provider !== next.provider ||
            previous.cwd !== next.cwd ||
            previous.reason !== next.reason ||
            previous.purpose !== next.purpose ||
            previous.title !== next.title ||
            !isDeepStrictEqual(previous.labels, next.labels) ||
            (next.metadata !== undefined && !isDeepStrictEqual(previous.metadata, next.metadata))) {
            throw new Error("agent.open.before hooks can only change env, tools, and mcpServers");
        }
        return { ...result, metadata: previous.metadata };
    }
    if (name === "agent.create.before") {
        const previous = beforeSchemas["agent.create.before"].parse(input);
        const next = beforeSchemas["agent.create.before"].parse(result);
        if (previous.config.cwd !== next.config.cwd) {
            throw new Error("agent.create.before hooks cannot change the workspace directory");
        }
        // Omitted means unchanged: the next hook sees what this one was handed.
        return { ...result, metadata: next.metadata ?? previous.metadata };
    }
    if (name === "workspace.create.before") {
        const previous = beforeSchemas["workspace.create.before"].parse(input);
        const next = beforeSchemas["workspace.create.before"].parse(result);
        // Omitted means unchanged; an explicit {} still replaces.
        return { ...result, metadata: next.metadata ?? previous.metadata };
    }
    if (name === "worktree.create.before") {
        const previous = beforeSchemas["worktree.create.before"].parse(input);
        const next = beforeSchemas["worktree.create.before"].parse(result);
        if (previous.repoRoot !== next.repoRoot || previous.sourceCheckout !== next.sourceCheckout) {
            throw new Error("worktree.create.before hooks cannot change repoRoot or sourceCheckout");
        }
    }
    return result;
}
export class PluginHookHandlers {
    handlers = new Map();
    active = new Map();
    changed;
    agentTools;
    constructor(changed, agentTools) {
        this.agentTools = agentTools;
        this.changed = changed;
        const registration = createLifecycleRegistration((name, handler) => this.register(name, handler));
        this.addHook = registration.addHook;
        this.on = registration.on;
        this.before = registration.before;
    }
    addHook;
    on;
    before;
    catalog() {
        return [...this.handlers.keys()];
    }
    async invoke(id, name, input, paseo) {
        const controller = new AbortController();
        this.active.set(id, controller);
        try {
            if (Object.hasOwn(beforeSchemas, name)) {
                const hookName = name;
                if (hookName === "agent.open.before") {
                    return await this.openSession(input, { paseo, signal: controller.signal });
                }
                let request = validateBeforeRequest(hookName, input);
                for (const handler of this.handlers.get(name) ?? []) {
                    controller.signal.throwIfAborted();
                    const result = await handler({ request: structuredClone(request) }, { paseo, signal: controller.signal });
                    if (result !== undefined)
                        request = await validateBeforeResult(hookName, request, result);
                }
                return request;
            }
            for (const handler of this.handlers.get(name) ?? []) {
                controller.signal.throwIfAborted();
                try {
                    await handler(structuredClone(input), { paseo, signal: controller.signal });
                }
                catch (error) {
                    if (Object.hasOwn(pluginHookRegistry, name) &&
                        pluginHookRegistry[name].waits)
                        throw error;
                    console.error(`Lifecycle hook ${name} failed`, error);
                }
            }
            return null;
        }
        finally {
            this.active.delete(id);
        }
    }
    async openSession(input, context) {
        let request = validateBeforeRequest("agent.open.before", input);
        this.agentTools?.detach(request.agentId);
        let tools = [];
        for (const handler of this.handlers.get("agent.open.before") ?? []) {
            context.signal.throwIfAborted();
            const result = await handler({ request: { ...structuredClone(request), tools: [...tools] } }, context);
            if (result === undefined)
                continue;
            const local = sessionOpenLocalResultSchema.parse(result);
            const metadata = local.tools.map(serializeAgentTool);
            request = await validateBeforeResult("agent.open.before", request, {
                ...local,
                tools: metadata,
            });
            tools = local.tools;
        }
        context.signal.throwIfAborted();
        if (request.purpose === "history") {
            request.tools = [];
            request.mcpServers = {};
        }
        else
            this.agentTools?.attach(request.agentId, tools);
        return request;
    }
    cancel(id) {
        this.active.get(id)?.abort();
    }
    close() {
        for (const controller of this.active.values()) {
            controller.abort();
        }
        this.handlers.clear();
    }
    register(name, handler) {
        let handlers = this.handlers.get(name);
        if (!handlers) {
            handlers = new Set();
            this.handlers.set(name, handlers);
        }
        handlers.add(handler);
        this.changed();
        return () => {
            if (!handlers.delete(handler)) {
                return;
            }
            if (handlers.size === 0) {
                this.handlers.delete(name);
            }
            this.changed();
        };
    }
}
