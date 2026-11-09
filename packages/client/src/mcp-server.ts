import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SubmitCommand, TaskCommand } from "@workbench/contracts";
import type { WorkbenchClient } from "./index.ts";

const string = { type: "string" } as const;
export function createAutomationServer(client: WorkbenchClient) {
  const server = new Server({ name: "achmage-workbench", version: "0.4.0" }, { capabilities: { tools: {} }, instructions: "Use snapshot/tasks to select exact host, workspace, session and run. Submitting or controlling a task requires a unique commandId. After a lost response, look up the receipt; do not repeat the external action. Native child tasks may be observation-only." });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "workbench_snapshot", description: "List projects, workspaces and sessions on the connected host.", inputSchema: { type: "object", properties: {} } },
    { name: "workbench_tasks", description: "Read independent session, document AI and native child task states.", inputSchema: { type: "object", properties: { workId: string } } },
    { name: "workbench_profiles", description: "List reusable role profiles and available settings.", inputSchema: { type: "object", properties: {} } },
    { name: "workbench_submit", description: "Send, queue or steer a request through the existing session and durable receipt.", inputSchema: { type: "object", required: ["commandId", "hostId", "workspaceId", "sessionId", "text"], properties: { commandId: string, hostId: string, workspaceId: string, sessionId: string, text: string, mode: { enum: ["auto", "queue", "steer"] }, profileId: { type: ["string", "null"] } } } },
    { name: "workbench_command", description: "Stop, approve or control a queued task using the exact TaskRef returned by tasks.", inputSchema: { type: "object", required: ["commandId", "target", "kind"], properties: { commandId: string, target: { type: "object" }, kind: { enum: ["stop", "approve", "cancel_queue", "send_queue"] }, itemId: string, decision: { enum: ["accept", "decline"] }, queuedId: string } } },
    { name: "workbench_receipt", description: "Look up a command after response loss. outcome_unknown does not authorize automatic replay.", inputSchema: { type: "object", required: ["commandId"], properties: { commandId: string } } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const input = request.params.arguments ?? {};
    try {
      const result = request.params.name === "workbench_snapshot" ? await client.snapshot()
        : request.params.name === "workbench_tasks" ? await client.tasks(typeof input.workId === "string" ? input.workId : undefined)
        : request.params.name === "workbench_profiles" ? await client.profiles()
        : request.params.name === "workbench_submit" ? await client.submit(input as unknown as SubmitCommand)
        : request.params.name === "workbench_command" ? await client.command(input as unknown as TaskCommand)
        : request.params.name === "workbench_receipt" ? await client.receipt(String(input.commandId ?? ""))
        : (() => { throw Error("Unknown Workbench tool"); })();
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
  });
  return server;
}
