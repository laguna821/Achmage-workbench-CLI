import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export default function contribute(server) {
  server.handle(defineRpc({ name: "echo", input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) }), input => ({ text: input.text }));
  server.handle(defineRpc({ name: "read-text", input: z.object({ path: z.string() }), output: z.string() }), (input, context) => context.paseo.workbench.readText(input.path));
  server.registerProvider({ id: "example-echo", label: "로컬 예제 공급자", status: async () => ({ available: true, diagnostic: "Local deterministic example; no model account or network" }),
    async connect() {
      const listeners = new Set();
      const emit = event => { for (const listener of listeners) listener(event); };
      return { version: 1, capabilities: ["prompt.message"],
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async close() { listeners.clear(); },
        async send(input) {
          if (input.type === "catalog") emit({ type: "catalog", requestId: input.requestId, catalog: { models: [{ id: "local-echo", label: "로컬 에코 예제" }], modes: [] } });
          else if (input.type === "session.open") {
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, cwd: input.config.cwd, capabilities: ["prompt.message"], restoration: "core" });
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.prompt") {
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "completed" } });
          } else if (input.requestId) emit({ type: "request.failed", requestId: input.requestId, error: { message: "Operation unsupported by local example" } });
        },
      };
    },
  });
}
