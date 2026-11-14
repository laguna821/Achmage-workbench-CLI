#!/usr/bin/env python3
"""The design screenshots in WebKitGTK (the engine the Linux app runs on), off screen.

Driven by scripts/design-shots.ts, which seeds a gateway (stand-in engines, fixture vault) and
writes a scenario: the gateway's address, the screens and, for each, the steps that reach it (the
same scripts the Chromium pass runs inside the page). Runs on a private GTK Broadway display with
GPU compositing off, in a window made active as the app's window is while in use. Writes a motion
`burst` step as webkit-<theme>-<screen>-<name>-NN.png; `reducedMotion` emulates reduced motion. Writes
webkit-<theme>-<screen>.png into the scenario's out folder.
Usage: python3 scripts/webkit-design-shots.py <scenario.json>
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

with open(sys.argv[1]) as handle:
    scenario = json.load(handle)
out_dir = scenario["outDir"]


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# A private display; nothing of it shows on the desktop.
display = f":{free_port() % 1000 + 100}"
broadway = subprocess.Popen(["broadwayd", "--address", "127.0.0.1", "--port", str(free_port()), display], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
for key in ("WAYLAND_DISPLAY", "DISPLAY"):
    os.environ.pop(key, None)
os.environ.update({"GDK_BACKEND": "broadway", "BROADWAY_DISPLAY": display, "WEBKIT_DISABLE_COMPOSITING_MODE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1"})

import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402

failures = []


def request(method, path, body=None):
    req = urllib.request.Request(scenario["base"] + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"authorization": f"Bearer {scenario['token']}", "content-type": "application/json"})
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read())


Gdk.Screen.get_default().set_resolution(96.0)
viewport = scenario["viewport"]
# WebKitGTK answers prefers-reduced-motion from GTK's animation setting.
if scenario.get("reducedMotion"):
    Gtk.Settings.get_default().set_property("gtk-enable-animations", False)
window = Gtk.OffscreenWindow()
window.set_default_size(viewport["width"], viewport["height"])
view = WebKit2.WebView()

# The private display has a touchscreen and no mouse, so the engine answers `pointer: coarse` and
# `hover: none`, and the app would draw its touch sizes and layout. The app runs on a desktop with a
# mouse: answer the pointer and hover media features as that desktop does (width queries untouched).
DESKTOP_POINTER = r"""
(() => {
  const YES = '(min-width: 0px)', NO = '(max-width: 0px)';
  const answers = [
    [/\(\s*(any-)?pointer\s*:\s*fine\s*\)/g, YES], [/\(\s*(any-)?pointer\s*:\s*(coarse|none)\s*\)/g, NO],
    [/\(\s*(any-)?hover\s*:\s*hover\s*\)/g, YES], [/\(\s*(any-)?hover\s*:\s*none\s*\)/g, NO],
  ];
  const rewrite = (query) => answers.reduce((text, [pattern, value]) => text.replace(pattern, value), String(query));
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => real(rewrite(query));
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.media && /pointer|hover/.test(rule.media.mediaText)) rule.media.mediaText = rewrite(rule.media.mediaText);
      if (rule.cssRules) visit(rule.cssRules);
    }
  };
  window.__desktopPointer = () => {
    for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch (error) { /* another origin */ } }
    return true;
  };
  new MutationObserver(() => window.__desktopPointer()).observe(document, { childList: true, subtree: true });
  addEventListener('load', () => window.__desktopPointer(), true);
})();
"""
if os.environ.get("DESIGN_SHOTS_TOUCH") != "1":
    view.get_user_content_manager().add_script(WebKit2.UserScript(DESKTOP_POINTER, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
    print("POINTER desktop (emulated: the private display has only a touchscreen)", flush=True)
else:
    print("POINTER touch (as the private display reports)", flush=True)

# The web tab is a native child window the off-screen engine cannot show. With `nativeStub` the
# page gets a stand-in for the desktop shell's bridge, answering only the shared-browser commands
# (list, create, present, close, execute), so the real web-tab frame renders around an empty page
# area. Everything else the bridge is asked for is refused.
NATIVE_STUB = r"""
(() => {
  const pages = new Map();
  const title = (url) => { try { const u = new URL(url); return u.hostname.includes('example.ac.kr') ? 'AI 글쓰기 평가 루브릭 안내 — 교수학습센터' : u.hostname; } catch (error) { return url; } };
  const shared = (command) => {
    if (command.kind === 'list') return [...pages.values()];
    if (command.kind === 'create') {
      const page = { pageId: command.pageId, profileId: command.profileId, navigationRevision: 1, capabilities: ['observe', 'navigate', 'dom_actions', 'persistent_profile'], url: command.url, title: title(command.url), loading: false, control: command.control, popups: [], error: null };
      pages.set(page.pageId, page); return page;
    }
    if (command.kind === 'close') { pages.delete(command.pageId); return null; }
    if (command.kind === 'present') { window.__nativePlacements = command.pages ?? command.placements ?? null; return null; }
    if (command.kind === 'execute') {
      const job = command.job, page = pages.get(job.pageId);
      if (!page) return { id: job.id, pageId: job.pageId, error: 'no page' };
      const next = { ...page, control: job.control };
      if (job.action.kind === 'control') next.control = job.action.control;
      if (job.action.kind === 'navigate') { next.url = job.action.url; next.title = title(job.action.url); next.navigationRevision += 1; }
      pages.set(next.pageId, next);
      return { id: job.id, pageId: job.pageId, page: next, observation: { target: { pageId: next.pageId, profileId: next.profileId, navigationRevision: next.navigationRevision, capabilities: next.capabilities }, documentNonce: 'stub-' + next.navigationRevision, observedAt: Date.now(), text: next.title } };
    }
    return null;
  };
  let callbacks = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback(callback) { const id = ++callbacks; window['_' + id] = callback; return id; },
    unregisterCallback() {},
    convertFileSrc: (path) => path,
    invoke: async (name, args) => {
      if (name === 'shared_browser') return shared(args.command);
      if (String(name).startsWith('plugin:event|')) return 0;
      throw new Error('unsupported');
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
"""
if scenario.get("nativeStub"):
    view.get_user_content_manager().add_script(WebKit2.UserScript(NATIVE_STUB, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
    print("NATIVE stand-in bridge (shared-browser commands only)", flush=True)
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
window.add(view)
window.show_all()
context = GLib.MainContext.default()

# An offscreen window is never the active window, so the page would never have focus. Make it
# active, as the app's window is while in use.
view.grab_focus()
focus_in = Gdk.Event.new(Gdk.EventType.FOCUS_CHANGE)
focus_in.focus_change.window = window.get_window()
focus_in.focus_change.send_event = 1
focus_in.focus_change.in_ = 1
window.event(focus_in)


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        context.iteration(False)
        time.sleep(0.01)


def js(script):
    box = {}

    def finished(source, result):
        try:
            value = source.evaluate_javascript_finish(result)
            box["value"] = json.loads(value.to_string()) if value and not value.is_undefined() else None
        except Exception as error:  # noqa: BLE001
            box["value"] = {"error": str(error)}

    view.evaluate_javascript(f"JSON.stringify((() => {{ {scenario['prelude']}; {script} }})())", -1, None, None, None, finished)
    while "value" not in box:
        context.iteration(True)
    return box["value"]


def until(expression, timeout=12):
    end = time.time() + timeout
    while time.time() < end:
        value = js(f"return Boolean({expression})")
        if value is True:
            return True
        pump(0.15)
    raise TimeoutError(f"waited for {expression}")


def resize(size):
    # An offscreen window is at least its default size and its child's request: set both, so a
    # screen with a narrower viewport (u27-narrow) gets narrow, not only a wider one.
    view.set_size_request(size["width"], size["height"])
    window.set_default_size(size["width"], size["height"])
    window.resize(size["width"], size["height"])
    pump(0.4)


def snapshot(name):
    box = {}
    # Style sheets that arrived since the last pass (lazy chunks) get the same pointer answers.
    js("return window.__desktopPointer ? window.__desktopPointer() : false")
    pump(0.05)

    def saved(source, result):
        source.get_snapshot_finish(result).write_to_png(os.path.join(out_dir, name))
        box["done"] = True

    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, saved)
    end = time.time() + 10
    while not box.get("done") and time.time() < end:
        context.iteration(True)


def set_prefs(patch):
    # PUT /api/prefs replaces the whole set: merge into what is there.
    prefs = request("GET", "/api/snapshot")["prefs"]
    request("PUT", "/api/prefs", {"prefs": {**prefs, **patch}})


def step(entry):
    if entry.get("prefs"):
        set_prefs(entry["prefs"])
    if entry.get("reload"):
        view.reload()
        pump(0.5)
    if entry.get("js"):
        js(f"{entry['js']}; return true")
    if entry.get("press"):
        # A real key through GTK (not a DOM event), so default actions such as a dialog's cancel run.
        keyval = Gdk.keyval_from_name(entry["press"])
        keyboard = Gdk.Display.get_default().get_default_seat().get_keyboard()
        for kind in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE):
            event = Gdk.Event.new(kind)
            event.key.window = view.get_window()
            event.key.send_event = 1
            event.key.keyval = keyval
            keys = Gdk.Keymap.get_for_display(Gdk.Display.get_default()).get_entries_for_keyval(keyval)
            event.key.hardware_keycode = keys[1][0].keycode if keys[0] else 0
            event.key.time = Gtk.get_current_event_time()
            event.set_device(keyboard)
            view.event(event)
            pump(0.05)
        pump(0.3)
    if entry.get("wait"):
        until(entry["wait"])
    if entry.get("pause"):
        pump(entry["pause"] / 1000)
    if entry.get("probe"):
        value = js(f"return ({entry['probe']})")
        print(f"PROBE {current_theme[0]} {current_screen[0]}: {json.dumps(value, ensure_ascii=False)}", flush=True)
    if entry.get("burst"):
        burst(entry["burst"])
    if entry.get("assert"):
        name = entry["assert"]
        result = js(f"return {scenario['invariants'][name]}") or {}
        passed = bool(result.get("ok"))
        print(f"{'PASS' if passed else 'FAIL'} WebKitGTK {current_theme[0]} {name}" + (f" — {result.get('detail')}" if result.get("detail") else ""), flush=True)
        if not passed:
            failures.append(f"{current_theme[0]} {name}: {result.get('detail')}")


def burst(spec):
    """A motion as a run of snapshots `every` ms apart (default 40), after `js` starts it."""
    if spec.get("until"):
        end = time.time() + 12
        while js(f"return Boolean({spec['until']})") is not True:
            if time.time() > end:
                raise TimeoutError(f"waited for {spec['until']}")
            context.iteration(False)
    if spec.get("js"):
        js(f"{spec['js']}; return true")
    start = time.time()
    stamps = []
    for index in range(spec.get("frames", 10)):
        due = start + index * spec.get("every", 40) / 1000
        while time.time() < due:
            context.iteration(False)
        stamps.append(round((time.time() - start) * 1000))
        snapshot(f"webkit-{current_theme[0]}-{current_screen[0]}-{spec.get('name', 'burst')}-{index:02d}.png")
    print(f"BURST {current_theme[0]} {current_screen[0]} {spec.get('name', 'burst')} at ms {stamps}", flush=True)


def load():
    view.load_uri(scenario["url"])
    until(scenario["appReady"], 25)


current_theme = [None]
current_screen = [None]

try:
    for theme in scenario["themes"]:
        current_theme[0] = theme
        set_prefs({"theme": theme})
        load()
        for screen in scenario["screens"]:
            name = f"webkit-{theme}-{screen['name']}.png"
            current_screen[0] = screen["name"]
            try:
                resize(screen.get("viewport") or viewport)
                for entry in screen["steps"]:
                    step(entry)
                pump((screen.get("settle") or 500) / 1000)
                snapshot(name)
                for entry in screen.get("cleanup") or []:
                    step(entry)
                print(f"PASS WebKitGTK {theme} {screen['name']}", flush=True)
            except Exception as error:  # noqa: BLE001
                failures.append(f"{theme} {screen['name']}: {error}")
                print(f"FAIL WebKitGTK {theme} {screen['name']} — {error}", flush=True)
                try:
                    snapshot(f"webkit-{theme}-{screen['name']}-failure.png")
                    load()
                except Exception:  # noqa: BLE001
                    pass
finally:
    broadway.terminate()
    broadway.wait(timeout=10)

sys.exit(1 if failures else 0)
