// Shared installed-app gateway harness. Keep this independent of executable acceptance scripts.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Gateway = { url: string; token: string; dataDir: string; child: ChildProcess; stop: () => Promise<void> };

/** The app's node and gateway inside its resource folder. */
export function appLayout(app: string) {
  const node = join(app, "node", process.platform === "win32" ? "node.exe" : "node");
  const native = process.platform === "darwin" ? join(app, "..", "MacOS", "achmage-workbench") : join(app, process.platform === "win32" ? "achmage-workbench.exe" : "achmage-workbench");
  return { node: existsSync(node) ? node : process.execPath, host: join(app, "host", "host.mjs"), web: join(app, "web"), native };
}

/** Start the app's gateway on the app's Node; resolves once it accepts requests. */
export async function startGateway(app: string, env: Record<string, string>, dataDir: string): Promise<Gateway> {
  const layout = appLayout(app);
  const child = spawn(layout.node, [layout.host], {
    env: { ...process.env, ...(existsSync(layout.native) ? { WORKBENCH_APP_BIN: layout.native } : {}), ...env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: layout.web, WORKBENCH_RESOURCES_DIR: app, WORKBENCH_HOST_LABEL: "확인" },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the gateway did not start within 60 s")), 60_000);
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.startsWith("WORKBENCH_READY ")) return;
      clearTimeout(timer);
      done(JSON.parse(line.slice(16)));
    });
    child.on("exit", (code) => fail(new Error(`the gateway exited (${code})`)));
  });
  return {
    ...ready,
    dataDir,
    child,
    stop: () =>
      new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("exit", () => done());
        child.kill();
        setTimeout(done, 5000);
      }),
  };
}

export function client(gateway: Pick<Gateway, "url" | "token">) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${gateway.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const bytes = async (path: string) => {
    const response = await fetch(`${gateway.url}${path}`, { headers: { authorization: `Bearer ${gateway.token}` } });
    if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  return { call, bytes };
}
