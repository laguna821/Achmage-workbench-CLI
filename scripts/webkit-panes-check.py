#!/usr/bin/env python3
"""Two panes in WebKitGTK (the engine the Linux app runs on), off screen.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display against a gateway on a
temporary data folder with stand-in engines and a fixture vault in a temporary folder (nothing of
the user's is touched). Everything is dragged with pointer events dispatched in WebKit (the app
drags with pointer events, not HTML drag and drop): a pinned vault note dragged onto the right half
of the main area shows where it lands and opens there beside the session; the divider dragged the
same way resizes the panes; the note pane's header dropped on the session's input attaches the note
there (no drop zone takes it). Writes snapshots and a results JSON.
Usage: python3 scripts/webkit-panes-check.py [out-dir]
"""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-panes")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-panes-")
folders = tempfile.mkdtemp(prefix="workbench-webkit-panes-works-")
vault = tempfile.mkdtemp(prefix="workbench-webkit-panes-vault-")
fixture = pathlib.Path(repo, "scripts/fixtures/pkm-vault.ts").as_uri()
subprocess.run(["node", "--input-type=module", "-e", f"const m = await import({json.dumps(fixture)}); m.makePkmVault({json.dumps(vault)});"], cwd=repo, check=True)


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


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

host = subprocess.Popen(
    ["node", "apps/host/src/main.ts"],
    cwd=repo,
    env={**os.environ, "WORKBENCH_DATA_DIR": data_dir, "WORKBENCH_WEB_DIR": "apps/web/dist", "WORKBENCH_CODEX_BIN": os.path.join(repo, "scripts/fixtures/fake-codex.mjs"), "WORKBENCH_CLAUDE_BIN": os.path.join(repo, "scripts/fixtures/fake-claude.mjs")},
    stdout=subprocess.PIPE,
    text=True,
)
ready = None
for line in host.stdout:
    if line.startswith("WORKBENCH_READY "):
        ready = json.loads(line[len("WORKBENCH_READY "):])
        break
url, token = ready["url"], ready["token"]


def request(method, path, body=None):
    req = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read())


request("PUT", "/api/prefs", {"prefs": {"onboarding": "done", "startScreen": "last"}})
request("PUT", "/api/pkm/vault", {"path": vault})
folder = os.path.join(folders, "두 칸")
os.makedirs(folder)
work = request("POST", "/api/works", {"title": "두 칸", "cwd": folder})
session = request("POST", f"/api/works/{work['id']}/sessions", {"provider": "codex", "purpose": "대화", "access": "auto"})

results = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1440, 900)
content = WebKit2.UserContentManager()
content.add_script(WebKit2.UserScript("localStorage.setItem('workbench.lastWork', %s);" % json.dumps(work["id"]), WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
view = WebKit2.WebView.new_with_user_content_manager(content)
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
window.add(view)
window.show_all()
context = GLib.MainContext.default()


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

    view.evaluate_javascript(f"JSON.stringify((() => {{ {script} }})())", -1, None, None, None, finished)
    while "value" not in box:
        context.iteration(True)
    return box["value"]


def until(test, timeout):
    end = time.time() + timeout
    while time.time() < end:
        value = test()
        if value:
            return value
        pump(0.2)
    return None


def snapshot(name):
    box = {}

    def saved(source, result):
        source.get_snapshot_finish(result).write_to_png(os.path.join(out_dir, name))
        box["done"] = True

    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, saved)
    until(lambda: box.get("done"), 10)


# Pointer events as a mouse sends them: down on the element, moves and up on the window.
POINTER = """
window.__at = (type, x, y, on) => (on || window).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
"""


def press(selector_script, dx=20):
    """Press on an element (found by a script returning it), remembering where."""
    return js(POINTER + f"""
      const element = ({selector_script})();
      if (!element) return null;
      element.scrollIntoView({{ block: 'center' }});
      const box = element.getBoundingClientRect();
      const x = box.left + Math.min({dx}, box.width / 2), y = box.top + box.height / 2;
      window.__at('pointerdown', x, y, element);
      window.__from = [x, y];
      return [x, y];
    """)


def move_to(x, y, steps=8):
    js(f"""
      const [x0, y0] = window.__from;
      for (let step = 1; step <= {steps}; step += 1) window.__at('pointermove', x0 + ({x} - x0) * step / {steps}, y0 + ({y} - y0) * step / {steps});
      window.__from = [{x}, {y}];
      return true;
    """)


def release():
    js("const [x, y] = window.__from; window.__at('pointerup', x, y); return true;")


try:
    view.load_uri(f"{url}/?token={token}")
    until(lambda: js("return Boolean(document.querySelector('.work-view .composer-input') && document.querySelector('.vault-tree .vault-row'))"), 25)
    js("const pins = document.querySelector('.vault-pins'); if (pins && pins.getAttribute('aria-expanded') !== 'true') pins.click(); return true")
    until(lambda: js("return [...document.querySelectorAll('.vault-note')].some((note) => note.textContent.includes('AI 글쓰기 수업 설계'))"), 10)
    pump(0.3)

    # A pinned vault note dragged onto the right half: a preview, then two panes.
    press("() => [...document.querySelectorAll('.vault-note')].find((note) => note.textContent.includes('AI 글쓰기 수업 설계'))")
    area = js("const box = document.querySelector('.panes').getBoundingClientRect(); return [box.left, box.top, box.width, box.height]")
    move_to(area[0] + area[2] * 0.5, area[1] + area[3] * 0.5)
    move_to(area[0] + area[2] * 0.8, area[1] + area[3] * 0.45, 6)
    pump(0.3)
    preview = js("const label = document.querySelector('.pane-drop-zone.right .pane-drop-label'); return label ? label.textContent : ''")
    snapshot("webkit-panes-drag.png")
    release()
    opened = until(lambda: js("return Boolean(document.querySelector('.panes.two .pane.right .pkm-note-view .pkm-note-body') && document.querySelector('.panes.two .pane.left .work-view'))"), 10)
    pump(0.5)
    snapshot("webkit-panes-two.png")
    check("WebKitGTK: 볼트 노트를 포인터로 오른쪽 반에 끌면 놓을 자리가 보이고 두 칸(왼쪽 대화, 오른쪽 노트)", opened and "오른쪽에 열기" in (preview or ""), preview or "")

    # The divider, dragged with pointer events.
    before = js("return document.querySelector('.pane.left').getBoundingClientRect().width")
    press("() => document.querySelector('.pane-divider')", 3)
    start = js("return window.__from")
    move_to(start[0] + 150, start[1] + 10)
    release()
    pump(0.4)
    after = js("return document.querySelector('.pane.left').getBoundingClientRect().width")
    remembered = until(lambda: request("GET", "/api/snapshot")["prefs"].get("paneRatio", 0) > 0.55, 5)
    check("WebKitGTK: 가운데 막대를 포인터로 끌어 너비 조절(기억됨)", after > before + 100 and remembered, f"{round(before)} → {round(after)}px")

    # The note pane's header onto the session's input: attached there, no drop zone.
    press("() => document.querySelector('.pane.right .pane-head-title')")
    target = js("const box = document.querySelector('.pane.left .composer').getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]")
    move_to(target[0], target[1])
    pump(0.3)
    held = js("return { over: document.querySelectorAll('.pane.left .composer-area.note-over').length, zones: document.querySelectorAll('.pane-drop-zone').length }")
    snapshot("webkit-panes-note-on-input.png")
    release()
    attached = until(lambda: js("const chip = document.querySelector('.pane.left .composer-area .note-chip'); return chip ? chip.textContent : ''"), 5)
    pump(0.3)
    snapshot("webkit-panes-attached.png")
    check("WebKitGTK: 노트 칸 머리를 대화 입력창에 놓으면 노트가 붙음(놓을 자리 표시 없음)", held and held["over"] == 1 and held["zones"] == 0 and "AI 글쓰기 수업 설계" in (attached or ""), json.dumps(held, ensure_ascii=False))
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error).splitlines()[0])
    try:
        snapshot("webkit-panes-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    broadway.terminate()
    broadway.wait(timeout=10)
    for path in (data_dir, folders, vault):
        shutil.rmtree(path, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-panes-results.json"), "w") as handle:
    json.dump(results, handle, ensure_ascii=False, indent=2)
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
