import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

// The picture on the desktop clipboard, read when the user pastes and the page sees nothing:
// WebKitGTK (the Linux app's engine) gives a page the clipboard's text and copied files, never
// picture data, and refuses navigator.clipboard.read(). Read only on that paste, only picture
// types, through the desktop's own tool: wl-paste (wl-clipboard) on Wayland, xclip on X11.

const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];
export const MAX_CLIPBOARD_PICTURE = 50_000_000;

function findTool(name: string, env: NodeJS.ProcessEnv) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

function run(command: string, args: string[], timeout: number, maxBuffer: number, env: NodeJS.ProcessEnv) {
  return new Promise<Buffer>((resolve, reject) =>
    execFile(command, args, { encoding: "buffer", timeout, maxBuffer, env, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

type Tool = { list: [string, string[]]; read: (type: string) => [string, string[]] };

function desktopTool(env: NodeJS.ProcessEnv = process.env): Tool | null {
  if (env.WAYLAND_DISPLAY) {
    const wlPaste = env.WORKBENCH_WL_PASTE || findTool("wl-paste", env);
    if (wlPaste) return { list: [wlPaste, ["--list-types"]], read: (type) => [wlPaste, ["--no-newline", "--type", type]] };
  }
  if (env.DISPLAY) {
    const xclip = findTool("xclip", env);
    if (xclip) return { list: [xclip, ["-selection", "clipboard", "-t", "TARGETS", "-o"]], read: (type) => [xclip, ["-selection", "clipboard", "-t", type, "-o"]] };
  }
  return null;
}

/** The clipboard's picture (its bytes and type), or null when it holds none or this desktop has no tool for it. */
export async function clipboardPicture(env: NodeJS.ProcessEnv = process.env): Promise<{ data: Buffer; type: string } | null> {
  const tool = desktopTool(env);
  if (!tool) return null;
  let offered: string[];
  try {
    offered = (await run(tool.list[0], tool.list[1], 3000, 256 * 1024, env)).toString("utf8").split(/\r?\n/).map((line) => line.trim());
  } catch {
    // An empty clipboard is an error to wl-paste.
    return null;
  }
  const type = PICTURE_TYPES.find((candidate) => offered.includes(candidate));
  if (!type) return null;
  const [command, args] = tool.read(type);
  const data = await run(command, args, 10_000, MAX_CLIPBOARD_PICTURE, env).catch(() => null);
  return data?.length ? { data, type } : null;
}
