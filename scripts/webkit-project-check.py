#!/usr/bin/env python3
"""Projects as notes in WebKitGTK (the engine the Linux app runs on), off screen.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display against a gateway on a
temporary data folder with two works in temporary folders (nothing of the user's is touched):
the project page opens from the conversation header and the stage written from its menu lands in
the note file; home "프로젝트" shows the table, the kanban (a card moved with pointer events in
WebKit lands in "진행중" and in the note) and the graph's points. Writes snapshots and a results JSON.
Usage: python3 scripts/webkit-project-check.py [out-dir]
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

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-project")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-project-")
folders = tempfile.mkdtemp(prefix="workbench-webkit-project-folders-")


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


request("PUT", "/api/prefs", {"prefs": {"onboarding": "done", "startScreen": "last", "homeMode": "projects"}})
works = []
for title in ("가을 특강", "안녕"):
    folder = os.path.join(folders, title)
    os.makedirs(folder)
    work = request("POST", "/api/works", {"title": title, "cwd": folder})
    request("POST", f"/api/works/{work['id']}/sessions", {"provider": "codex", "purpose": "준비", "access": "auto"})
    works.append(work)
note_path = request("GET", f"/api/projects/{works[1]['id']}")["note"]["path"]

results = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1280, 900)
content = WebKit2.UserContentManager()
content.add_script(WebKit2.UserScript("localStorage.setItem('workbench.lastWork', %s);" % json.dumps(works[1]["id"]), WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
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


def read_note():
    try:
        with open(note_path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


try:
    view.load_uri(f"{url}/?token={token}")
    until(lambda: js("return Boolean(document.querySelector('.project-link'))"), 20)
    js("document.querySelector('.project-link').click(); return true")
    until(lambda: js("return Boolean(document.querySelector('.project-view .project-stage'))"), 15)
    js("document.querySelector('.project-stage').click(); return true")
    until(lambda: js("return [...document.querySelectorAll('.context-menu-item')].some((item) => item.textContent.includes('진행중'))"), 10)
    js("[...document.querySelectorAll('.context-menu-item')].find((item) => item.textContent.includes('진행중')).click(); return true")
    written = until(lambda: "단계: 진행중" in read_note(), 10)
    pump(0.4)
    snapshot("webkit-project-page.png")
    look = js("const pill = document.querySelector('.project-stage'); return { text: pill.textContent, color: getComputedStyle(pill).borderColor }")
    check("WebKitGTK: 대화 머리 → 프로젝트 페이지, 단계 메뉴로 고른 '진행중'이 노트 파일에", written and "진행중" in (look or {}).get("text", ""), json.dumps(look, ensure_ascii=False))

    # Home "프로젝트": table, kanban (pointer events dispatched in WebKit), graph.
    js("document.querySelector('.topbar .brand').click(); return true")
    until(lambda: js("return Boolean(document.querySelector('.home-modes.mode-projects'))"), 10)
    js("[...document.querySelectorAll('.projects-layouts button')].find((b) => b.textContent === '표').click(); return true")
    rows = until(lambda: js("return document.querySelectorAll('.projects-table tbody tr').length"), 10) or 0
    check("WebKitGTK: 프로젝트 표에 프로젝트마다 한 줄", rows == 2, f"{rows}줄")
    # The kanban is the view "단계" now (a board by stage).
    js("[...document.querySelectorAll('.projects-layouts button')].find((b) => b.textContent === '단계').click(); return true")
    until(lambda: js("return Boolean(document.querySelector('.kanban-card'))"), 10)
    moved_id = works[0]["id"]
    js("""
      const card = document.querySelector('.kanban-card[data-work=%s]');
      const target = document.querySelector('.kanban-column[data-stage-column="진행중"]').getBoundingClientRect();
      const box = card.getBoundingClientRect();
      const at = (type, x, y, on) => on.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
      at('pointerdown', box.left + 20, box.top + 10, card);
      window.__steps = [[box.left + 60, box.top + 30], [target.left + target.width / 2, target.top + 40]];
      return true;
    """ % json.dumps(moved_id))
    pump(0.3)
    js("for (const [x, y] of window.__steps) window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x, clientY: y })); return true")
    pump(0.3)
    js("const [x, y] = window.__steps[1]; window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y })); return true")
    staged = until(lambda: any(entry["workId"] == moved_id and entry["stage"] == "진행중" for entry in request("GET", "/api/projects/")), 10)
    pump(0.5)
    snapshot("webkit-kanban.png")
    check("WebKitGTK: 칸반 카드를 '진행중'으로 옮기면 그 프로젝트 노트에 단계", staged)
    js("[...document.querySelectorAll('.projects-layouts button')].find((b) => b.textContent === '그래프').click(); return true")
    points = until(lambda: js("return document.querySelectorAll('.graph-node.project').length"), 10) or 0
    pump(0.3)
    snapshot("webkit-graph.png")
    check("WebKitGTK: 그래프에 프로젝트 점", points == 2, f"{points}점")
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error).splitlines()[0])
    try:
        snapshot("webkit-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    broadway.terminate()
    broadway.wait(timeout=10)
    for folder in (data_dir, folders):
        shutil.rmtree(folder, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-project-results.json"), "w") as handle:
    json.dump(results, handle, ensure_ascii=False, indent=2)
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
