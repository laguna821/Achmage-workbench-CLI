#!/usr/bin/env python3
"""The design screenshots in WebKitGTK (the engine the Linux app runs on), off screen.

Driven by scripts/design-shots.ts, which seeds a gateway (stand-in engines, fixture vault) and
writes a scenario: the gateway's address, the screens and, for each, the steps that reach it (the
same scripts the Chromium pass runs inside the page). Runs on a private GTK Broadway display with
GPU compositing off, in a window made active as the app's window is while in use. Writes
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
window = Gtk.OffscreenWindow()
window.set_default_size(viewport["width"], viewport["height"])
view = WebKit2.WebView()
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
    window.resize(size["width"], size["height"])
    view.set_size_request(size["width"], size["height"])
    pump(0.4)


def snapshot(name):
    box = {}

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
    if entry.get("wait"):
        until(entry["wait"])
    if entry.get("pause"):
        pump(entry["pause"] / 1000)
    if entry.get("assert"):
        name = entry["assert"]
        result = js(f"return {scenario['invariants'][name]}") or {}
        passed = bool(result.get("ok"))
        print(f"{'PASS' if passed else 'FAIL'} WebKitGTK {current_theme[0]} {name}" + (f" — {result.get('detail')}" if result.get("detail") else ""), flush=True)
        if not passed:
            failures.append(f"{current_theme[0]} {name}: {result.get('detail')}")


def load():
    view.load_uri(scenario["url"])
    until(scenario["appReady"], 25)


current_theme = [None]

try:
    for theme in scenario["themes"]:
        current_theme[0] = theme
        set_prefs({"theme": theme})
        load()
        for screen in scenario["screens"]:
            name = f"webkit-{theme}-{screen['name']}.png"
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
