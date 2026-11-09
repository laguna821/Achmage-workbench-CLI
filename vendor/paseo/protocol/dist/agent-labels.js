export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";
export function getOpenAgentTabLabel(clientId) {
    return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}
export function isOpenAgentTabLabel(label) {
    return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}
export function getParentAgentIdFromLabels(labels) {
    const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
    return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
        ? parentAgentId.trim()
        : null;
}
export function isDelegatedAgent(agent) {
    return getParentAgentIdFromLabels(agent.labels) !== null;
}
export function hasOpenAgentTab(labels) {
    return Object.entries(labels ?? {}).some(([label, value]) => isOpenAgentTabLabel(label) && value === "true");
}
// Absent parent server label means the same host.
export function getParentAddressFromLabels(labels, serverId) {
    const agentId = getParentAgentIdFromLabels(labels);
    if (!agentId)
        return null;
    const parentServerId = labels?.[PARENT_SERVER_ID_LABEL];
    return {
        serverId: typeof parentServerId === "string" && parentServerId.trim()
            ? parentServerId.trim()
            : serverId,
        agentId,
    };
}
export function parentAddressLabels(parent) {
    return { [PARENT_AGENT_ID_LABEL]: parent.agentId, [PARENT_SERVER_ID_LABEL]: parent.serverId };
}
