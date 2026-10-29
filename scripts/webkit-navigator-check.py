#!/usr/bin/env python3
"""The sidebar's two-pane navigator in WebKitGTK (the engine the Linux app runs on), off screen.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display against a gateway on a
temporary data folder with stand-in engines and 300 projects in three folders (nothing of the
user's is touched). Pointer events are dispatched in WebKit (the app drags with pointer events, not
HTML drag and drop): the two panes render side by side; a project dragged from the list onto a
folder moves into it; the divider between the panes moves the split and is remembered; the list of
300 projects scrolls to its end with frame times measured (requestAnimationFrame intervals) and
the CPU of the WebKit processes. Writes snapshots and a results JSON.
Usage: python3 scripts/webkit-navigator-check.py [out-dir]
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-navigator")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-navigator-")
folders_dir = tempfile.mkdtemp(prefix="workbench-webkit-navigator-works-")


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
folders = [request("POST", "/api/folders", {"name": name, "parentId": None}) for name in ("강의", "연구", "행정")]
works = []
for index in range(300):
    cwd = os.path.join(folders_dir, f"p{index}")
    os.makedirs(cwd)
    work = request("POST", "/api/works", {"title": f"프로젝트 {index + 1:03d}", "folderId": None if index % 4 == 3 else folders[index % 3]["id"], "cwd": cwd})
    works.append(request("PATCH", f"/api/works/{work['id']}", {"title": f"프로젝트 {index + 1:03d}"}))
loose = next(work for work in works if work["folderId"] is None)

results = []
numbers = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1440, 900)
view = WebKit2.WebView()
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


def cpu_seconds():
    """CPU time of this process's children (the WebKit web and network processes) and itself."""
    total = 0
    me = os.getpid()
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat") as handle:
                stat = handle.read()
            fields = stat[stat.rindex(")") + 2:].split()
            if int(pid) == me or int(fields[1]) == me:
                total += int(fields[11]) + int(fields[12])
        except (OSError, ValueError, IndexError):
            continue
    return total / os.sysconf("SC_CLK_TCK")


# Pointer events as a mouse sends them: down on the element, moves and up on the window.
POINTER = """
window.__at = (type, x, y, on) => (on || window).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
"""


def press(selector_script, dx=40):
    return js(POINTER + f"""
      const element = ({selector_script})();
      if (!element) return null;
      element.scrollIntoView({{ block: 'center' }});
      const box = element.getBoundingClientRect();
      const x = box.left + Math.min({dx}, box.width / 2), y = box.top + Math.min(14, box.height / 2);
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
    shown = until(lambda: js("return document.querySelectorAll('.sidebar.nav-dual .list-rows .nav-project').length >= 300 && Boolean(document.querySelector('.start-view .composer-input'))"), 30)
    pump(0.6)
    boxes = js("const nav = document.querySelector('.nav-pane').getBoundingClientRect(); const list = document.querySelector('.list-pane').getBoundingClientRect(); return { nav: [nav.left, nav.width], list: [list.left, list.width], rows: document.querySelectorAll('.list-rows .nav-project').length }")
    snapshot("webkit-navigator-dual.png")
    check(
        "WebKitGTK: 두 칸 내비게이터(탐색 | 목록)와 프로젝트 300개 목록이 그려지고 앱은 새 세션 준비로 열림",
        shown and boxes and boxes["nav"][0] + boxes["nav"][1] <= boxes["list"][0] + 1 and boxes["rows"] >= 300,
        json.dumps(boxes),
    )

    # A project from the list onto a folder in the navigation pane, with pointer events.
    target_folder = folders[1]
    press(f"() => document.querySelector('.list-rows [data-row-id=\"{loose['id']}\"]')")
    folder_at = js(f"const box = document.querySelector('.nav-folder-tree [data-row-id=\"{target_folder['id']}\"]').getBoundingClientRect(); return [box.left + 60, box.top + box.height / 2]")
    move_to(folder_at[0] - 120, folder_at[1] + 30, 4)
    move_to(folder_at[0], folder_at[1], 8)
    pump(0.2)
    marked = js(f"return {{ inside: Boolean(document.querySelector('.nav-folder-tree [data-row-id=\"{target_folder['id']}\"].drop-inside')), ghost: document.querySelector('.drag-ghost')?.textContent ?? '' }}")
    snapshot("webkit-navigator-drag.png")
    release()
    moved = until(lambda: next(work for work in request("GET", "/api/snapshot")["works"] if work["id"] == loose["id"])["folderId"] == target_folder["id"], 8)
    check("WebKitGTK: 목록의 프로젝트를 포인터로 끌어 폴더 줄에 놓으면 그 폴더로(놓을 자리 표시)", moved and marked and marked["inside"], json.dumps(marked, ensure_ascii=False))

    # The divider between the panes, dragged the same way: the split moves and is remembered.
    before = js("return Math.round(document.querySelector('.nav-pane').getBoundingClientRect().width)")
    press("() => document.querySelector('.nav-divider')", 0)
    start = js("return window.__from")
    move_to(start[0] + 50, start[1] + 10, 6)
    release()
    pump(0.4)
    after = js("return Math.round(document.querySelector('.nav-pane').getBoundingClientRect().width)")
    remembered = until(lambda: (request("GET", "/api/snapshot")["prefs"].get("navigator") or {}).get("navWidth") == after, 5)
    check("WebKitGTK: 두 칸 사이 막대를 포인터로 끌어 나눔 조절(기억됨)", after >= before + 45 and remembered, f"{before} → {after}px")

    # Scrolling 300 projects: a step each frame, frame times and CPU of the WebKit processes.
    js("document.querySelector('.nav-folder-tree [data-row-id=\"nav:root\"]').click(); return true")
    pump(0.6)
    js("""
      const scroller = document.querySelector('.list-scroll');
      scroller.scrollTop = 0;
      window.__frames = []; window.__done = false; let last = 0;
      const tick = (now) => {
        if (last) window.__frames.push(now - last);
        last = now;
        scroller.scrollTop += 48;
        if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) requestAnimationFrame(tick); else window.__done = true;
      };
      requestAnimationFrame(tick);
      return true;
    """)
    c0, t0 = cpu_seconds(), time.time()
    until(lambda: js("return window.__done"), 60)
    c1, t1 = cpu_seconds(), time.time()
    times = sorted(js("return window.__frames") or [0])
    mean = sum(times) / len(times)
    stats = {"frames": len(times), "mean": round(mean, 1), "p95": round(times[int(len(times) * 0.95)], 1), "max": round(times[-1], 1), "cpu": round((c1 - c0) / (t1 - t0) * 100)}
    end = js("const scroller = document.querySelector('.list-scroll').getBoundingClientRect(); const last = [...document.querySelectorAll('.list-rows .nav-project')].at(-1).getBoundingClientRect(); return last.bottom <= scroller.bottom + 1")
    pump(0.3)
    snapshot("webkit-navigator-scrolled.png")
    numbers.append(f"WebKitGTK 300개 스크롤: {stats['frames']}프레임 평균 {stats['mean']}ms · p95 {stats['p95']}ms · 최대 {stats['max']}ms · CPU {stats['cpu']}%")
    check("WebKitGTK: 프로젝트 300개 목록을 끝까지 스크롤(p95 25ms 미만)", end and stats["p95"] < 25, json.dumps(stats))
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error).splitlines()[0])
    try:
        snapshot("webkit-navigator-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    broadway.terminate()
    broadway.wait(timeout=10)
    for path in (data_dir, folders_dir):
        shutil.rmtree(path, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-navigator-results.json"), "w") as handle:
    json.dump({"results": results, "numbers": numbers}, handle, ensure_ascii=False, indent=2)
for line in numbers:
    print(line)
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
