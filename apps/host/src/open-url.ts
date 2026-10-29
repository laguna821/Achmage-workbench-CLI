import { spawn } from "node:child_process";
import { win32 } from "node:path";

// Opening a web address in the user's browser from the gateway, with each OS's own opener and no
// shell (an address with "&" must not reach cmd.exe). The gateway runs on the computer where the
// engines log in, so the browser opens there even when the screen is on another device.
// WORKBENCH_OPEN_URL names a stand-in (a script run on Node) for checks.

/** The program and arguments that open `url` on `platform`. */
export function openerFor(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const override = env.WORKBENCH_OPEN_URL;
  if (override) return /\.(c|m)?js$/i.test(override) ? { command: process.execPath, args: [override, url] } : { command: override, args: [url] };
  if (platform === "win32") {
    // url.dll's handler opens the default browser without a console or cmd's parsing.
    const system = win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "rundll32.exe");
    return { command: system, args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Only web addresses are opened (never files or other schemes an engine might print). */
export function isWebAddress(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !/[\s"'<>`]/.test(value);
  } catch {
    return false;
  }
}

/** Open a web address; resolves whether the opener started (not whether a window appeared). */
export function openUrl(url: string): Promise<boolean> {
  if (!isWebAddress(url)) return Promise.resolve(false);
  const { command, args } = openerFor(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
