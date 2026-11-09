#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkbenchClient } from "./index.ts";
import { connection } from "./config.ts";
import { createAutomationServer } from "./mcp-server.ts";

const at = process.argv.indexOf("--fixture-transport");
try {
  const server = createAutomationServer(new WorkbenchClient(connection(at >= 0 ? process.argv[at + 1] : undefined)));
  await server.connect(new StdioServerTransport());
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
