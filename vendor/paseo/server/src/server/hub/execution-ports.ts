// Type-only extraction from the pinned DaemonExecutions public port.
import type { AgentSnapshotPayload, AgentStreamEventPayload, CreateAgentWorktreeTarget, HubExecutionControlAction } from "@getpaseo/protocol/messages";
import type { ProviderOptions, ToolPolicy, McpServerConfig } from "@getpaseo/protocol/agent-types";
export interface HubExecutionAgentCreateInput {
  executionId: string;
  provider: string;
  cwd: string;
  prompt: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  providerOptions?: ProviderOptions;
  toolPolicy?: ToolPolicy;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  worktree?: CreateAgentWorktreeTarget;
}

export interface HubExecutionControlInput {
  requestId: string;
  executionId: string;
  action: HubExecutionControlAction;
}

export interface OwnedAgentSnapshot {
  executionId: string;
  agent: AgentSnapshotPayload;
}

export type OwnedAgentEvent =
  | { type: "update"; executionId: string; agent: AgentSnapshotPayload }
  | {
      type: "stream";
      executionId: string;
      agentId: string;
      event: AgentStreamEventPayload;
    };

export interface HubExecutionAgents {
  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot>;
  control(input: HubExecutionControlInput): Promise<void>;
  subscribe(listener: (event: OwnedAgentEvent) => void): () => void;
  invalidateAuthority(): Promise<void>;
}

