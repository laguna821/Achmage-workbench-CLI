/** Where AI assistants reach this Doory (the MCP server behind the same origin as the app). */
export function mcpUrl(): string {
  return `${window.location.origin}/mcp`
}

/** The command that connects Claude Code; other clients take the same URL and header. */
export function claudeCodeCommand(token: string): string {
  return `claude mcp add --transport http doory ${mcpUrl()} --header "Authorization: Bearer ${token}"`
}
