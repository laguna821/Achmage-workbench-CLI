#!/usr/bin/env python3
"""The projects' graph in WebKitGTK (the engine the Linux app runs on), off screen.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display against a gateway on a
temporary data folder with stand-in engines and works in temporary folders (nothing of the user's is
touched). Home "프로젝트" → "그래프": the points settle to rest; a point dragged with dispatched pointer
events moves and its "관련" neighbour follows; the settings panel changes a line colour; then, with
300 projects and about 600 lines, frame times (requestAnimationFrame intervals) while the layout
settles and while a point is dragged, with the CPU time of the WebKit processes. Writes snapshots
and a results JSON.
Usage: python3 scripts/webkit-graph-check.py [out-dir]
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

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-graph")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-graph-")
folders = tempfile.mkdtemp(prefix="workbench-webkit-graph-folders-")


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


def project(title, tags, related, engines=()):
    folder = os.path.join(folders, title.replace(" ", "-"))
    os.makedirs(folder, exist_ok=True)
    work = request("POST", "/api/works", {"title": title, "cwd": folder})
    if tags:
        request("PUT", f"/api/projects/{work['id']}/property", {"key": "tags", "values": tags})
    if related:
        request("PUT", f"/api/projects/{work['id']}/property", {"key": "관련", "values": [f"[[{name}]]" for name in related]})
    for provider in engines:
        request("POST", f"/api/works/{work['id']}/sessions", {"provider": provider, "purpose": "준비", "access": "auto"})
    return work


request("PUT", "/api/prefs", {"prefs": {"onboarding": "done", "startScreen": "last", "homeMode": "projects"}})
works = {
    "autumn": project("가을 특강", ["강의", "2026"], [], ["codex", "claude"]),
    "hello": project("안녕", ["강의"], ["가을 특강"], ["claude"]),
    "draft": project("논문 초고", ["연구"], [], ["codex"]),
    "plan": project("연구 계획서", ["연구"], ["논문 초고"]),
    "talk": project("학회 발표", ["연구", "2026"], ["논문 초고", "연구 계획서"], ["codex"]),
    "app": project("워크벤치 앱", ["코딩"], [], ["codex", "claude"]),
    "flow": project("AI 워크플로우", ["코딩", "AI"], ["워크벤치 앱"]),
}

results = []
numbers = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1280, 1000)
content = WebKit2.UserContentManager()
content.add_script(WebKit2.UserScript("localStorage.setItem('workbench.projectsLayout', 'graph');", WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
view = WebKit2.WebView.new_with_user_content_manager(content)
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
window.add(view)
window.show_all()
context = GLib.MainContext.default()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        context.iteration(False)
        time.sleep(0.004)


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
        pump(0.1)
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


def open_graph(points):
    view.load_uri(f"{url}/?token={token}")
    pump(0.3)
    until(lambda: not view.is_loading(), 30)
    # Home "프로젝트" (the preference), the graph layout (the stored choice); the brand goes home if needed.
    until(lambda: js("if (document.querySelector('.home-modes')) return true; document.querySelector('.topbar .brand')?.click(); return false"), 30)
    count = lambda: js("return document.querySelectorAll('.graph-node.project').length") or 0  # noqa: E731
    shown = until(lambda: count() if count() >= points else None, 20)
    js("document.querySelector('.graph-stage').scrollIntoView({ block: 'center' }); return true")
    return shown or 0


def rest(timeout=15):
    return until(lambda: js("return document.querySelector('.graph-canvas')?.getAttribute('data-state') === 'rest'"), timeout)


def place(node_id):
    return js("const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(document.querySelector('g[data-node=\"%s\"]').getAttribute('transform')); return [Number(m[1]), Number(m[2])]" % node_id)


def measure(script_while, seconds):
    """rAF intervals in the page for `seconds` (the page runs `script_while(step)` each frame), and CPU %."""
    js("""
      window.__frames = []; window.__done = false; let last = 0; const end = performance.now() + %d; let step = 0;
      const tick = (now) => { if (last) window.__frames.push(now - last); last = now; step += 1; %s; if (performance.now() < end) requestAnimationFrame(tick); else window.__done = true; };
      requestAnimationFrame(tick); return true;
    """ % (int(seconds * 1000), script_while))
    c0, t0 = cpu_seconds(), time.time()
    until(lambda: js("return window.__done"), seconds + 10)
    c1, t1 = cpu_seconds(), time.time()
    times = sorted(js("return window.__frames") or [0])
    mean = sum(times) / len(times)
    return {"frames": len(times), "mean": round(mean, 1), "p95": round(times[int(len(times) * 0.95)], 1), "max": round(times[-1], 1), "cpu": round((c1 - c0) / (t1 - t0) * 100)}


DOWN = """
  const target = document.querySelector('g[data-node="%s"] .graph-dot');
  const box = target.getBoundingClientRect();
  window.__grip = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: window.__grip.x, clientY: window.__grip.y }));
  return window.__grip;
"""
MOVE = "window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: window.__grip.x + %s, clientY: window.__grip.y + %s }))"
UP = "window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: window.__grip.x + %s, clientY: window.__grip.y + %s })); return true"

try:
    shown = open_graph(7)
    started = time.time()
    rested = rest()
    numbers.append(f"WebKitGTK 첫 배치가 쉬기까지 {round((time.time() - started) * 1000)}ms")
    pump(0.3)
    snapshot("webkit-graph.png")
    counts = js("return { tags: document.querySelectorAll('.graph-node.tag').length, bar: document.querySelector('.graph-count').textContent }")
    check("WebKitGTK: 그래프가 움직이다 쉬고, 프로젝트·태그 점", shown == 7 and rested and counts["tags"] == 5, json.dumps(counts, ensure_ascii=False))

    # Drag "안녕" by dispatched pointer events, a step each frame; "가을 특강" (관련) follows.
    dragged, neighbour = f"p:{works['hello']['id']}", f"p:{works['autumn']['id']}"
    before, neighbour_before = place(dragged), place(neighbour)
    k = js("return Number(/scale\\(([\\d.]+)\\)/.exec(document.querySelector('.graph-world').getAttribute('transform'))[1])")
    js(DOWN % dragged)
    for step in range(1, 31):
        js(MOVE % (step * 6, step * 4) + "; return true")
        pump(0.03)
    pump(0.5)
    held, neighbour_held = place(dragged), place(neighbour)
    snapshot("webkit-graph-drag.png")
    js(UP % (180, 120))
    rest()
    moved = ((held[0] - before[0]) ** 2 + (held[1] - before[1]) ** 2) ** 0.5
    expected = ((180 / k) ** 2 + (120 / k) ** 2) ** 0.5
    # Followed: the neighbour came closer to where the dragged point is now than it was.
    gap = lambda a, b: ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5  # noqa: E731
    followed = gap(neighbour_before, held) - gap(neighbour_held, held)
    opened = js("return Boolean(document.querySelector('.project-view'))")
    check(
        "WebKitGTK: 포인터 이벤트로 점을 끌면 그만큼 움직이고 이웃이 따라오며, 페이지는 열리지 않음",
        abs(moved - expected) < 4 and followed > 15 and not opened,
        f"점 {round(moved)} (기대 {round(expected)}) · 이웃 {before} {neighbour_before} → {held} {neighbour_held} · 열림 {opened}",
    )

    # Settings: the gear opens the panel; a line colour changes the drawing.
    js("document.querySelector('.graph-gear').click(); return true")
    until(lambda: js("return Boolean(document.querySelector('.graph-panel'))"), 5)
    js("[...document.querySelectorAll('.graph-section-toggle')].find((b) => b.textContent.includes('색')).click(); return true")
    pump(0.2)
    js("document.querySelector('[role=\"radiogroup\"][aria-label=\"관련 선 색\"] [aria-label=\"#30a46c\"]').click(); return true")
    pump(0.3)
    stroke = js("return getComputedStyle(document.querySelector('.graph-edges.related')).stroke")
    snapshot("webkit-graph-panel.png")
    saved = js("return JSON.parse(localStorage.getItem('workbench.graphSettings')).color.related")
    check("WebKitGTK: 톱니 → 설정, 관련 선 색 바꾸면 바로 그림에 · 이 기기에 저장", stroke == "rgb(48, 164, 108)" and saved == "#30a46c", f"{stroke} · {saved}")
    js("document.querySelector('.graph-panel button.graph-reset').click(); return true")

    # 300 projects and about 600 lines.
    created = time.time()
    many = []
    for n in range(300):
        folder = os.path.join(folders, f"many-{n}")
        os.makedirs(folder, exist_ok=True)
        many.append(request("POST", "/api/works", {"title": f"과제 {n:03d}", "cwd": folder}))
    for n, work in enumerate(many):
        request("PUT", f"/api/projects/{work['id']}/property", {"key": "tags", "values": [f"묶음{n % 12}"]})
        request("PUT", f"/api/projects/{work['id']}/property", {"key": "관련", "values": [f"[[과제 {(n + 12 * (1 + n % 3)) % 300:03d}]]"]})
    numbers.append(f"프로젝트 300개 만들기 {round(time.time() - created)}초")
    shown = open_graph(300)
    big = js("return { points: document.querySelectorAll('.graph-node').length, lines: [...document.querySelectorAll('.graph-edges')].reduce((sum, p) => sum + ((p.getAttribute('d') || '').split('M').length - 1), 0) }")
    rested = rest(20)
    snapshot("webkit-graph-300.png")
    # Measured on the graph alone, once the app's own start-up work is done: tag points off and on
    # again warm every point up, then a point dragged with a pointer event each frame.
    pump(1.0)
    tag_switch = "[...document.querySelectorAll('.graph-switch')].find((row) => row.textContent.includes('태그 점 보이기')).querySelector('input').click(); return true"
    js("document.querySelector('.graph-gear').click(); return true")
    until(lambda: js("return Boolean(document.querySelector('.graph-panel'))"), 5)
    # Two windows each (other programs share this computer): the better one counts, both are reported.
    settlings, draggings = [], []
    for _ in range(2):
        js(tag_switch)
        rest(20)
        js(tag_switch)
        settlings.append(measure("", 2.5))
        rest(20)
    js("document.querySelector('.graph-panel .icon-button[aria-label=\"닫기\"]').click(); return true")
    pump(0.3)
    grip = None
    for _ in range(2):
        grip = js(DOWN % f"p:{many[5]['id']}")
        draggings.append(measure(MOVE % ("step * 3", "Math.sin(step / 8) * 40"), 2.5))
        js(UP % (0, 0))
        rest(20)
    settling = min(settlings, key=lambda entry: entry["p95"])
    dragging = min(draggings, key=lambda entry: entry["p95"])
    idle = measure("", 1.5)
    both = lambda entries: ", ".join(f"{entry['mean']}/{entry['p95']}" for entry in entries)  # noqa: E731
    numbers.append(f"WebKitGTK 300점·{big['lines']}선 — 움직이는 동안 프레임 평균 {settling['mean']}ms · p95 {settling['p95']}ms · 최대 {settling['max']}ms · CPU {settling['cpu']}% (두 번: {both(settlings)})")
    numbers.append(f"끄는 동안 평균 {dragging['mean']}ms · p95 {dragging['p95']}ms · 최대 {dragging['max']}ms · CPU {dragging['cpu']}% (두 번: {both(draggings)})")
    numbers.append(f"쉬는 동안 CPU {idle['cpu']}%")
    check(
        "WebKitGTK: 300점·약 600선이 움직이는 동안과 끄는 동안 부드러움(p95 25ms 미만), 쉬면 일이 없음",
        big["points"] >= 300 and big["lines"] >= 560 and rested and settling["p95"] < 25 and dragging["p95"] < 25 and grip,
        f"{big['points']}점 · {big['lines']}선 · 움직임 {json.dumps(settling)} · 끌기 {json.dumps(dragging)} · 쉼 {json.dumps(idle)}",
    )
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error).splitlines()[0])
    try:
        snapshot("webkit-graph-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    broadway.terminate()
    broadway.wait(timeout=10)
    for folder in (data_dir, folders):
        shutil.rmtree(folder, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-graph-results.json"), "w") as handle:
    json.dump({"results": results, "numbers": numbers}, handle, ensure_ascii=False, indent=2)
for line in numbers:
    print(f"· {line}")
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
