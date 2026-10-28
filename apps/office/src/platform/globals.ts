// What IeumOffice's editor code (written for Node inside Electron) expects to find globally, for
// running it in the editor page's worker. Imported first by the worker so it is in place before
// any of that code loads.
import { Buffer } from "buffer";

const scope = globalThis as unknown as Record<string, unknown>;
scope.global ??= globalThis;
scope.Buffer ??= Buffer;
scope.process ??= {
  platform: "linux",
  arch: "x64",
  env: {},
  argv: [],
  versions: { node: "24.0.0" },
  version: "v24.0.0",
  pid: 1,
  resourcesPath: "/resources",
  cwd: () => "/",
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
  emitWarning: () => undefined,
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
};
scope.setImmediate ??= (fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 0, ...args);
scope.clearImmediate ??= (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);
