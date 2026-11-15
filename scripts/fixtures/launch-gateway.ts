// How checks start the gateway since sec-vault round 2. With the app's REAL binary as the vault helper,
// the gateway must be started the way the app starts it — by that binary's launcher
// (`--host-runtime`), which registers it with the vault and hands it its per-run ticket; a gateway
// started any other way is refused by the helper (and says so). The launcher runs only the install's
// own `host/host.mjs` beside it, so a throwaway install folder is made: a copy of the binary and the
// built host bundle (a link, or a copy with `copyHost`). With the stand-in helper
// (scripts/fixtures/fake-secret.mjs) the gateway runs directly, as before.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type GatewayLaunch = { command: string; args: string[]; env: Record<string, string>; root: string | null; cleanup: () => void };

/**
 * `entry`: the built host.mjs. `binary`: the real app binary (launch through it) or a stand-in
 * helper script (run directly). The returned env holds the variables the launch needs; merge it
 * last. WORKBENCH_HOST_MODE=shell keeps the gateway printing its address on stdout (the launcher
 * passes those lines through).
 */
export function gatewayLaunch(entry: string, binary: string | undefined, options: { copyHost?: boolean; under?: string } = {}): GatewayLaunch {
  const real = binary && !/\.(mjs|js|ts)$/.test(binary);
  if (!real) return { command: process.execPath, args: [entry], env: binary ? { WORKBENCH_SECRET_BIN: binary } : {}, root: null, cleanup: () => {} };
  const root = mkdtempSync(join(options.under ?? tmpdir(), "wb-install-"));
  const app = join(root, "app");
  mkdirSync(app, { recursive: true });
  // Its own name (achmage-workbench, or .exe on Windows) beside host/ and web/, as an install has it.
  const native = join(app, basename(binary));
  copyFileSync(binary, native);
  const host = dirname(resolve(entry));
  if (options.copyHost) cpSync(host, join(app, "host"), { recursive: true });
  else symlinkSync(host, join(app, "host"));
  // The web bundle the launcher points the gateway at (web/ beside the binary): the built one if there.
  const web = resolve(host, "../../web/dist");
  if (existsSync(join(web, "index.html"))) symlinkSync(web, join(app, "web"));
  else { mkdirSync(join(app, "web")); writeFileSync(join(app, "web/index.html"), "<!doctype html><title>check</title>"); }
  return {
    command: native, args: ["--host-runtime"],
    env: { WORKBENCH_HOST_MODE: "shell" }, root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
