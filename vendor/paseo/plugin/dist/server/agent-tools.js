export function defineAgentTool(tool) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || tool.name.length > 64) {
        throw new Error(`Invalid agent tool name: ${tool.name}`);
    }
    return tool;
}
