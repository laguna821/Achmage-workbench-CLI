import type { AgentAddress } from "./addresses.js";
export declare const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
export declare const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export declare function getOpenAgentTabLabel(clientId: string): string;
export declare function isOpenAgentTabLabel(label: string): boolean;
export interface AgentLabelSource {
    labels?: Record<string, unknown> | null;
}
export declare function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined): string | null;
export declare function isDelegatedAgent(agent: AgentLabelSource): boolean;
export declare function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean;
export declare function getParentAddressFromLabels(labels: Record<string, unknown> | null | undefined, serverId: string): AgentAddress | null;
export declare function parentAddressLabels(parent: AgentAddress): Record<string, string>;
