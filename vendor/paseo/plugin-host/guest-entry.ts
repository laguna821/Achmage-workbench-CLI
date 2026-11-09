// The original pure SDK exports execute inside QuickJS, never the Node host.
import * as shared from "../plugin/src/index.js";
import * as provider from "../plugin/src/server/provider.js";
import { defineAgentTool } from "../plugin/src/server/agent-tools.js";
import { createLifecycleRegistration } from "../plugin/src/server/lifecycle.js";
import * as zod from "zod";
const server = { defineAgentTool };
export { shared, provider, server, createLifecycleRegistration, zod };
