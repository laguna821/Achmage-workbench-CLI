import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The environment a program the gateway starts needs to reach the person's screen.
//
// A gateway started at login by its user unit can start BEFORE the compositor has told systemd its
// display (2026-11-17: the unit's environment had no WAYLAND_DISPLAY and no DISPLAY, so every document
// executor — a GTK/WebKit process — exited at once). So the display is read at the time of each
// spawn: the gateway's own variables when it has them; else, on Linux, what the user's session knows
// NOW (`systemctl --user show-environment`, only the names below, parsed strictly); else the usual
// sockets as a last look. Never a shell string.
//
// Windows: a GUI child joins the logged-in desktop through its window station, not an environment
// variable — nothing to add. macOS: GUI programs reach WindowServer through the per-user launchd
// session, not an environment variable — nothing to add. Both get `base` back unchanged.

/** The only names taken from the session's environment. */
export const SESSION_NAMES = ["WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS"] as const;
type Name = (typeof SESSION_NAMES)[number];
type Found = Partial<Record<Name, string>>;

const SHAPE: Record<Name, RegExp> = {
  // A socket name in XDG_RUNTIME_DIR (wayland-1) or an absolute socket path.
  WAYLAND_DISPLAY: /^(?:\/[A-Za-z0-9._\/-]{1,200}|[A-Za-z0-9._-]{1,100})$/,
  // [host]:display[.screen]
  DISPLAY: /^[A-Za-z0-9._\/-]{0,100}:\d{1,4}(?:\.\d{1,3})?$/,
  XAUTHORITY: /^\/[^\0\n\r]{1,400}$/,
  XDG_SESSION_TYPE: /^[a-z0-9-]{1,20}$/,
  XDG_CURRENT_DESKTOP: /^[A-Za-z0-9_:.-]{1,100}$/,
  DBUS_SESSION_BUS_ADDRESS: /^[a-z][a-z0-9-]*:[A-Za-z0-9=,;\/._%-]{1,400}$/,
};
const ALLOWED = new Set<string>(SESSION_NAMES);

/** `systemctl --user show-environment` output → only the allowed names, each value checked against its shape.
 * systemd prints `NAME=value` (shell-escaped as `$'…'` when the value needs it: such values are refused). */
export function parseSessionEnvironment(text: string): Found {
  const out: Found = {};
  for (const line of text.slice(0, 256 * 1024).split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const name = line.slice(0, at), value = line.slice(at + 1);
    if (!ALLOWED.has(name) || !SHAPE[name as Name].test(value)) continue;
    out[name as Name] = value;
  }
  return out;
}

export const hasDisplay = (env: NodeJS.ProcessEnv) => Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);

type Options = {
  platform?: NodeJS.Platform;
  /** The session manager's environment as text, or null when it cannot be read. */
  readSession?: () => string | null;
  /** Socket names in a folder (empty when it cannot be read). */
  sockets?: (dir: string) => string[];
  x11Dir?: string;
  now?: () => number;
  cacheMs?: number;
};

function listSockets(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => { try { return statSync(join(dir, name)).isSocket(); } catch { return false; } });
  } catch { return []; }
}

function readSystemdSession(): string | null {
  try {
    // By name on PATH, argv only; a short bound so a stuck manager never holds a spawn.
    return execFileSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", timeout: 1500, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch { return null; }
}

export function createGuiEnvironment(options: Options = {}) {
  const platform = options.platform ?? process.platform;
  const readSession = options.readSession ?? readSystemdSession;
  const sockets = options.sockets ?? listSockets;
  const x11Dir = options.x11Dir ?? "/tmp/.X11-unix";
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 2000;
  let cached: { at: number; key: string; found: Found } | null = null;

  const look = (runtimeDir: string | undefined): Found => {
    const key = runtimeDir ?? "";
    if (cached && cached.key === key && now() - cached.at < cacheMs) return cached.found;
    let found = parseSessionEnvironment(readSession() ?? "");
    if (!found.WAYLAND_DISPLAY && !found.DISPLAY) {
      // Last look: a compositor's socket in the runtime folder, an X server's in /tmp/.X11-unix.
      const wayland = runtimeDir && runtimeDir.startsWith("/") ? sockets(runtimeDir).filter((name) => /^wayland-\d{1,3}$/.test(name)).sort()[0] : undefined;
      const x11 = sockets(x11Dir).map((name) => /^X(\d{1,4})$/.exec(name)?.[1]).filter((n): n is string => Boolean(n)).sort((a, b) => Number(a) - Number(b))[0];
      found = { ...(found.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: found.DBUS_SESSION_BUS_ADDRESS } : {}),
        ...(wayland ? { WAYLAND_DISPLAY: wayland } : x11 !== undefined ? { DISPLAY: `:${x11}` } : {}) };
    }
    cached = { at: now(), key, found };
    return found;
  };

  /** The child environment for a program that needs a screen: `base` with the display names filled in. */
  const environment = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
    if (platform !== "linux" || hasDisplay(base)) return { ...base };
    const found = look(base.XDG_RUNTIME_DIR);
    if (!found.WAYLAND_DISPLAY && !found.DISPLAY) return { ...base };
    const out: NodeJS.ProcessEnv = { ...base };
    // The gateway's own values win; the session only fills what is missing.
    for (const name of SESSION_NAMES) if (found[name] && !out[name]) out[name] = found[name];
    return out;
  };
  return Object.assign(environment, { reset() { cached = null; } });
}

/** The gateway's one reader. `WORKBENCH_X11_DIR` only moves the last-look X11 folder (checks use an empty one). */
export const guiEnvironment = createGuiEnvironment({ x11Dir: process.env.WORKBENCH_X11_DIR || undefined });
