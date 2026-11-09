/** @internal Lifecycle policy shared by the daemon and plugin process. */
export const pluginHookRegistry = {
    "workspace.create.before": { waits: true },
    "workspace.create.after": { waits: false },
    "workspace.archive.after": { waits: false },
    "worktree.create.before": { waits: true },
    "worktree.create.after": { waits: true },
    "agent.create.before": { waits: true },
    "agent.create.after": { waits: false },
    "agent.open.before": { waits: true },
    "agent.close.after": { waits: false },
    "agent.archive.after": { waits: false },
    "agent.turn.before": { waits: false },
    "agent.turn.after": { waits: false },
    "agent.permission.before": { waits: false },
    "agent.permission.after": { waits: false },
};
// COMPAT(pluginHookNames): added in v0.14, remove after 2027-04-30
const legacyEvents = {
    "workspace.created": "workspace.create.after",
    "workspace.archived": "workspace.archive.after",
    "agent.created": "agent.create.after",
    "agent.closed": "agent.close.after",
    "agent.archived": "agent.archive.after",
    "agent.turn_started": "agent.turn.before",
    "agent.turn_ended": "agent.turn.after",
    "agent.permission_requested": "agent.permission.before",
    "agent.permission_resolved": "agent.permission.after",
};
const legacyRequests = {
    "workspace.create": "workspace.create.before",
    "agent.create": "agent.create.before",
    "agent.session_open": "agent.open.before",
};
/** @internal SDK adapter for the daemon's hook registry. */
export function createLifecycleRegistration(register) {
    const names = new Set(Object.keys(pluginHookRegistry));
    return {
        addHook(name, handler) {
            if (!names.has(name))
                throw new Error(`Unknown lifecycle hook: ${name}`);
            return register(name, handler);
        },
        on(name, handler) {
            if (!Object.hasOwn(legacyEvents, name))
                throw new Error(`Unknown lifecycle event: ${name}`);
            return register(legacyEvents[name], handler);
        },
        before(name, handler) {
            if (!Object.hasOwn(legacyRequests, name))
                throw new Error(`Unknown before hook: ${name}`);
            return register(legacyRequests[name], handler);
        },
    };
}
