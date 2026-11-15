import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Run in a fresh Node so that the module reads the variables as a starting gateway does.
const probe = (code: string, env: Record<string, string>) => spawnSync(process.execPath, ["--input-type=module", "-e", code], {
  env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", cwd: import.meta.dirname,
});

describe("the gateway's own helper paths", () => {
  it("are read once and gone from the environment that everything the gateway starts copies", () => {
    const run = probe(`
      import { gatewayOnly, takeGatewayOnlyEnv } from "./gateway-env.ts";
      import { spawnSync } from "node:child_process";
      takeGatewayOnlyEnv();
      const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith('WORKBENCH_'))))"], { encoding: "utf8" });
      console.log(JSON.stringify({ secret: gatewayOnly("WORKBENCH_SECRET_BIN"), pty: gatewayOnly("WORKBENCH_PTY_BIN"), token: gatewayOnly("WORKBENCH_TOKEN"), child: JSON.parse(child.stdout) }));
    `, { WORKBENCH_SECRET_BIN: "/opt/wb/app", WORKBENCH_PTY_BIN: "/opt/wb/pty", WORKBENCH_TOKEN: "door", WORKBENCH_DATA_DIR: "/d" });
    expect(run.stderr).toBe("");
    const seen = JSON.parse(run.stdout.trim());
    expect(seen).toEqual({ secret: "/opt/wb/app", pty: "/opt/wb/pty", token: "door", child: ["WORKBENCH_DATA_DIR"] });
  });
});
