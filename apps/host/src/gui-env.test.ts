import { describe, expect, it } from "vitest";
import { createGuiEnvironment, parseSessionEnvironment, SESSION_NAMES } from "./gui-env.ts";

const SESSION = [
  "HOME=/home/someone",
  "PATH=/usr/bin",
  "WAYLAND_DISPLAY=wayland-1",
  "DISPLAY=:0",
  "XAUTHORITY=/run/user/1000/xauth_abc",
  "XDG_SESSION_TYPE=wayland",
  "XDG_CURRENT_DESKTOP=niri",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
  "LD_PRELOAD=/tmp/evil.so",
  "SECRET_TOKEN=abc",
].join("\n");

const make = (session: string | null, extra: Parameters<typeof createGuiEnvironment>[0] = {}) => {
  let reads = 0;
  const env = createGuiEnvironment({ platform: "linux", readSession: () => { reads += 1; return session; }, sockets: () => [], ...extra });
  return { env, reads: () => reads };
};

describe("guiEnvironment", () => {
  it("keeps the gateway's own display and never asks the session", () => {
    const { env, reads } = make(SESSION);
    const out = env({ WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", FOO: "1" });
    expect(out).toEqual({ WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", FOO: "1" });
    expect(reads()).toBe(0);
    expect(env({ DISPLAY: ":1" })).toEqual({ DISPLAY: ":1" });
  });

  it("fills the display from the session when its own is empty (the login-unit case)", () => {
    const { env } = make(SESSION);
    const out = env({ XDG_RUNTIME_DIR: "/run/user/1000", XDG_SESSION_TYPE: "tty" });
    expect(out).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000", XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0",
      XAUTHORITY: "/run/user/1000/xauth_abc", XDG_CURRENT_DESKTOP: "niri", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" });
  });

  it("takes nothing but the allowed names", () => {
    const parsed = parseSessionEnvironment(SESSION);
    expect(Object.keys(parsed).sort()).toEqual([...SESSION_NAMES].sort());
    const out = make(SESSION).env({});
    expect(out.LD_PRELOAD).toBeUndefined(); expect(out.SECRET_TOKEN).toBeUndefined(); expect(out.HOME).toBeUndefined(); expect(out.PATH).toBeUndefined();
  });

  it("parses strictly: refuses escaped, odd or injected values", () => {
    expect(parseSessionEnvironment([
      "WAYLAND_DISPLAY=$'wayland-1\\n'", "DISPLAY=:0; rm -rf /", "XAUTHORITY=relative/path", "XDG_SESSION_TYPE=Wayland Session",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus $(id)", " DISPLAY=:2", "DISPLAY", "=x",
    ].join("\n"))).toEqual({});
    expect(parseSessionEnvironment("DISPLAY=localhost:10.0\nWAYLAND_DISPLAY=/run/user/1000/wayland-9")).toEqual({ DISPLAY: "localhost:10.0", WAYLAND_DISPLAY: "/run/user/1000/wayland-9" });
  });

  it("is read at spawn time, cached briefly", () => {
    let session: string | null = "";
    let t = 0;
    const env = createGuiEnvironment({ platform: "linux", readSession: () => session, sockets: () => [], now: () => t, cacheMs: 2000 });
    expect(env({}).WAYLAND_DISPLAY).toBeUndefined();
    session = "WAYLAND_DISPLAY=wayland-1";
    t = 1000; expect(env({}).WAYLAND_DISPLAY).toBeUndefined();
    t = 2500; expect(env({}).WAYLAND_DISPLAY).toBe("wayland-1");
  });

  it("looks for a socket last: Wayland in the runtime folder, then X11", () => {
    const listing: Record<string, string[]> = { "/run/user/7": ["wayland-1.lock", "niri.wayland-1.9.sock", "wayland-1", "bus"], "/x11": ["X3", "X1"] };
    const env = createGuiEnvironment({ platform: "linux", readSession: () => null, sockets: dir => listing[dir] ?? [], x11Dir: "/x11" });
    expect(env({ XDG_RUNTIME_DIR: "/run/user/7" })).toEqual({ XDG_RUNTIME_DIR: "/run/user/7", WAYLAND_DISPLAY: "wayland-1" });
    env.reset();
    expect(env({ XDG_RUNTIME_DIR: "/run/user/8" })).toEqual({ XDG_RUNTIME_DIR: "/run/user/8", DISPLAY: ":1" });
  });

  it("returns the base unchanged when there is no screen anywhere", () => {
    const env = createGuiEnvironment({ platform: "linux", readSession: () => "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1/bus", sockets: () => [] });
    expect(env({ A: "1" })).toEqual({ A: "1" });
  });

  it("leaves Windows and macOS untouched", () => {
    for (const platform of ["win32", "darwin"] as const) {
      let reads = 0;
      const env = createGuiEnvironment({ platform, readSession: () => { reads += 1; return SESSION; }, sockets: () => { reads += 1; return ["wayland-0"]; } });
      expect(env({ A: "1" })).toEqual({ A: "1" });
      expect(reads).toBe(0);
    }
  });
});
