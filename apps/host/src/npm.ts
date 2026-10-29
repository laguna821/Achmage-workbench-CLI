import { existsSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { commandNames, launchFor, pathDirs, realFs } from "./engine-locate.ts";
import { shipped } from "./resources.ts";

// The npm that installs engines: the one shipped next to the app's Node (release builds), else
// the one of the Node running the gateway (the Arch package uses the system's), else npm on PATH.
// It always runs on the gateway's Node, so no shell and no `node` on PATH are needed.

/** npm's command line script (npm-cli.js), or null. */
export function npmCli(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WORKBENCH_NPM_CLI) return existsSync(env.WORKBENCH_NPM_CLI) ? env.WORKBENCH_NPM_CLI : null;
  const node = process.execPath;
  const beside = [
    // Release builds: node/node(.exe) with node/npm/ beside it.
    join(dirname(node), "npm", "bin", "npm-cli.js"),
    // Node's own layouts: Windows keeps npm next to node.exe, others in ../lib/node_modules.
    join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = beside.find((path) => existsSync(path)) ?? shipped(join("node", "npm", "bin", "npm-cli.js"));
  if (found) return found;
  const ctx = { platform: platform(), arch: arch(), env, home: homedir(), fs: realFs, node };
  for (const dir of pathDirs(env, ctx.platform)) {
    for (const name of commandNames("npm", ctx)) {
      const file = join(dir, name);
      if (realFs.kind(file) !== "file") continue;
      const launch = launchFor(file, "path", ctx);
      if (launch?.kind === "node" && launch.args[0]?.endsWith("npm-cli.js")) return launch.args[0];
    }
  }
  return null;
}
