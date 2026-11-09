import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { patchExecutionTransport } from "../../../office/execution-transport-patch.ts";

it("waits for the original context decision and never starts a stream cancelled while that decision is pending", async () => {
  const root = realpathSync(resolve("vendor/ieumoffice")), id = root + "/packages/agent-core/src/electron-transport.ts";
  const source = patchExecutionTransport(readFileSync(id, "utf8"), id, root, "/unused.ts");
  const built = await build({ stdin: { contents: source, loader: "ts", resolveDir: dirname(id) }, bundle: true, platform: "node", format: "cjs", write: false });
  const module = { exports: {} as { createIpcTransport(options: unknown): { stream(request: unknown, callbacks: unknown): { cancel(): void } } } };
  new Function("module", "exports", built.outputFiles[0]!.text)(module, module.exports);
  const request = { system: "긴 원문".repeat(5000), messages: [{ role: "user", content: "요청" }], tools: [], runId: "context-run" };
  for (const cancelled of [false, true]) {
    let decide!: (answer: boolean) => void, listener: (chunk: unknown) => void = () => {};
    const done = vi.fn(), error = vi.fn(), start = vi.fn((input: { requestId: string }) => listener({ requestId: input.requestId, type: "done" }));
    const options = { getSettings: () => ({}), unknownErrorText: () => "문맥 확인", contextLimit: () => ({ limit: 100, known: true }),
      confirmContext: () => new Promise<boolean>(resolve => { decide = resolve; }), onStream: (fn: typeof listener) => { listener = fn; return () => {}; }, start, cancel: vi.fn() };
    const handle = module.exports.createIpcTransport(options).stream(request, { onDone: done, onError: error, onDelta: vi.fn(), onToolCall: vi.fn() });
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    if (cancelled) handle.cancel();
    decide(true); await new Promise(resolve => setTimeout(resolve, 0));
    expect(start).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    expect(done).toHaveBeenCalledOnce(); expect(error).not.toHaveBeenCalled();
  }
});
