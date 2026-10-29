#!/usr/bin/env python3
"""Home's grouped views in WebKitGTK (the engine the Linux app runs on), off screen.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display against a gateway on a
temporary data folder (nothing of the user's is touched), projects with stages, 중요도, 마감일 and
the vault's "DIKM_단계:" written through /api/projects/:id/property. It checks: the board by stage
draws each column with its colour (the band on top, the outline); a card moved with pointer events
dispatched in WebKit from one column to another writes the stage into the note; on "마감 × 중요도"
a card moved down a row writes 중요도, and one moved across date periods is refused and says why;
grouping by DIKM colours the columns by their emoji; with 300 projects on the board, frame times
while a card is dragged and while home scrolls, with the CPU time of the WebKit processes.
Writes snapshots and a results JSON.
Usage: python3 scripts/webkit-groups-check.py [out-dir]
"""
import datetime
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-groups")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-groups-")
folders = tempfile.mkdtemp(prefix="workbench-webkit-groups-folders-")


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


def day(offset):
    return (datetime.date.today() + datetime.timedelta(days=offset)).isoformat()


request("PUT", "/api/prefs", {"prefs": {"onboarding": "done", "startScreen": "last", "homeMode": "projects"}})


def project(title, stage, importance, due, dikm, engines):
    folder = os.path.join(folders, title.replace(" ", "-"))
    os.makedirs(folder)
    work = request("POST", "/api/works", {"title": title, "cwd": folder})
    request("PATCH", f"/api/works/{work['id']}", {"title": title})
    if stage:
        request("PUT", f"/api/projects/{work['id']}/stage", {"stage": stage})
    request("PUT", f"/api/projects/{work['id']}/property", {"key": "중요도", "values": [importance], "type": "text"})
    request("PUT", f"/api/projects/{work['id']}/property", {"key": "마감일", "values": [due], "type": "date"})
    request("PUT", f"/api/projects/{work['id']}/property", {"key": "DIKM_단계:", "values": [dikm], "type": "list"})
    for provider in engines:
        request("POST", f"/api/works/{work['id']}/sessions", {"provider": provider, "purpose": "준비", "access": "auto"})
    return work


works = {
    "autumn": project("가을 특강", "진행중", "높음", day(1), "🟢 D", ["codex", "claude"]),
    "draft": project("논문 초고", "할일", "보통", day(-1), "🔵 I", ["claude"]),
    "talk": project("학회 발표", "진행중", "보통", day(0), "🟣 K", ["codex"]),
    "budget": project("예산 보고", "보류", "낮음", day(1), "🟠 M", ["codex"]),
    "minutes": project("회의록 정리", None, "보통", day(120), "⬜ 보류", ["claude"]),
}


def summary(work_id):
    return next(entry for entry in request("GET", "/api/projects/") if entry["workId"] == work_id)


def prop(work_id, key):
    return next((entry["values"] for entry in summary(work_id)["properties"] if entry["key"] == key), [])


results = []
numbers = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1280, 1000)
view = WebKit2.WebView()
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


def measure(script_while, seconds):
    """rAF intervals in the page for `seconds` (the page runs `script_while` each frame, with `step`), and CPU %."""
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


def open_home():
    view.load_uri(f"{url}/?token={token}")
    pump(0.3)
    until(lambda: not view.is_loading(), 30)
    until(lambda: js("if (document.querySelector('.home-modes.mode-projects')) return true; document.querySelector('.topbar .brand')?.click(); return false"), 30)


def tab(name):
    js("[...document.querySelectorAll('.home-modes .view-tab')].find((b) => b.textContent === %s).click(); return true" % json.dumps(name))
    return until(lambda: js("return document.querySelector('.home-modes .view-tab.on')?.textContent === %s" % json.dumps(name)), 10)


# A card held at its middle-left, moved in two steps (past the threshold, then onto the target), released there.
DRAG = """
  const card = document.querySelector(%s);
  const target = document.querySelector(%s);
  card.scrollIntoView({ block: 'center' });
  const box = card.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const at = (type, x, y, on) => on.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
  at('pointerdown', box.left + 20, box.top + 10, card);
  window.__steps = [[box.left + 50, box.top + 30], [to.left + to.width / 2, to.top + Math.min(40, to.height / 2)]];
  return true;
"""
MOVES = "for (const [x, y] of window.__steps) window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x, clientY: y })); return { over: document.querySelectorAll('.group-board .over').length, refuse: document.querySelectorAll('.group-board .refuse').length }"
UP = "const [x, y] = window.__steps[1]; window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y })); return true"


def drag(card, target):
    js(DRAG % (json.dumps(card), json.dumps(target)))
    pump(0.2)
    hovered = js(MOVES)
    pump(0.2)
    js(UP)
    return hovered


try:
    open_home()
    tab("단계")
    until(lambda: js("return document.querySelectorAll('.kanban-column[data-stage-column] .kanban-card').length >= 5"), 15)
    pump(0.3)
    snapshot("webkit-groups-stage.png")
    look = js("""
      const column = document.querySelector('.kanban-column[data-stage-column="진행중"]');
      return { band: getComputedStyle(column).boxShadow, dot: getComputedStyle(column.querySelector('.group-dot')).backgroundColor, group: getComputedStyle(column).getPropertyValue('--group').trim() };
    """)
    check("WebKitGTK: 단계 보드의 열마다 그 단계 색(위 띠·테두리·점)", "rgb(62, 99, 221)" in look["band"] and "3px" in look["band"] and look["dot"] == "rgb(62, 99, 221)" and look["group"] == "#3e63dd", json.dumps(look, ensure_ascii=False))

    hovered = drag(f".kanban-column[data-stage-column=\"할일\"] .kanban-card[data-work=\"{works['draft']['id']}\"]", '.kanban-column[data-stage-column="완료"]')
    staged = until(lambda: summary(works["draft"]["id"])["stage"] == "완료", 10)
    moved = until(lambda: js("return Boolean(document.querySelector('.kanban-column[data-stage-column=\"완료\"] .kanban-card[data-work=\"%s\"]'))" % works["draft"]["id"]), 8)
    pump(0.4)
    snapshot("webkit-groups-stage-moved.png")
    check("WebKitGTK: 포인터로 카드를 할일 → 완료 열로 끌면 노트에 단계, 카드도 그 열로", staged and moved and hovered["over"] == 1, json.dumps(hovered))

    tab("마감 × 중요도")
    until(lambda: js("return document.querySelectorAll('.group-board.lanes .kanban-lane').length >= 3"), 15)
    pump(0.3)
    snapshot("webkit-groups-due.png")
    talk = works["talk"]["id"]
    hovered = drag(f".kanban-cell[data-col=\"today\"][data-lane=\"보통\"] .kanban-card[data-work=\"{talk}\"]", '.kanban-cell[data-col="today"][data-lane="높음"]')
    importance = until(lambda: prop(talk, "중요도") == ["높음"], 10)
    check("WebKitGTK: '마감 × 중요도'에서 카드를 보통 → 높음 줄로 끌면 노트에 중요도", importance and hovered["over"] == 1, json.dumps(hovered))
    autumn = works["autumn"]["id"]
    hovered = drag(f".kanban-cell[data-col=\"tomorrow\"] .kanban-card[data-work=\"{autumn}\"]", '.kanban-cell[data-col="today"][data-lane="높음"]')
    told = until(lambda: "끌어서 정할 수 없습니다" in (js("return document.querySelector('.toast')?.textContent || ''") or ""), 6)
    check("WebKitGTK: 날짜 기간 열 사이로는 옮기지 않고(놓을 자리 거절 표시) 까닭을 알림, 마감일 그대로", told and hovered["refuse"] == 1 and prop(autumn, "마감일") == [day(1)], json.dumps(hovered))

    # Grouped by the vault's DIKM key: the columns take their emoji's colour.
    js("[...document.querySelectorAll('.home-modes .view-tool')].find((b) => b.textContent.startsWith('하위 묶기')).click(); return true")
    until(lambda: js("return Boolean(document.querySelector('.view-pop'))"), 5)
    js("[...document.querySelectorAll('.view-pop .menu-item')].find((b) => b.textContent === '없음').click(); return true")
    js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true")
    js("[...document.querySelectorAll('.home-modes .view-tool')].find((b) => b.textContent.startsWith('묶기')).click(); return true")
    until(lambda: js("return Boolean(document.querySelector('.view-pop'))"), 5)
    js("[...document.querySelectorAll('.view-pop .menu-item')].find((b) => b.textContent === 'DIKM_단계').click(); return true")
    js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true")
    colors = until(lambda: js("const columns = [...document.querySelectorAll('.group-board .kanban-column')]; return columns.length >= 5 ? columns.map((c) => [c.dataset.col, getComputedStyle(c).getPropertyValue('--group').trim()]) : null"), 10) or []
    pump(0.3)
    snapshot("webkit-groups-dikm.png")
    check(
        "WebKitGTK: DIKM_단계로 묶으면 🟢 D · 🔵 I · 🟣 K · 🟠 M · ⬜ 보류 순서와 그 색",
        colors[:5] == [["🟢 D", "#30a46c"], ["🔵 I", "#3e63dd"], ["🟣 K", "#8e4ec6"], ["🟠 M", "#f76b15"], ["⬜ 보류", "#8b8d98"]],
        json.dumps(colors, ensure_ascii=False),
    )

    # 300 projects on the board by stage: dragging a card and scrolling home, frame by frame.
    created = time.time()
    stages = ["할일", "진행중", "완료", "보류"]
    for n in range(300):
        folder = os.path.join(folders, f"many-{n}")
        os.makedirs(folder, exist_ok=True)
        work = request("POST", "/api/works", {"title": f"과제 {n:03d}", "cwd": folder})
        request("PUT", f"/api/projects/{work['id']}/stage", {"stage": stages[n % 4]})
        request("PUT", f"/api/projects/{work['id']}/property", {"key": "중요도", "values": [["높음", "보통", "낮음"][n % 3]], "type": "text"})
    numbers.append(f"프로젝트 300개 만들기 {round(time.time() - created)}초")
    open_home()
    tab("단계")
    cards = until(lambda: (lambda count: count if count >= 300 else None)(js("return document.querySelectorAll('.group-board .kanban-card').length")), 30) or 0
    pump(1.0)
    snapshot("webkit-groups-300.png")
    draggings, scrollings = [], []
    for _ in range(2):
        js("""
          const card = document.querySelector('.kanban-column[data-stage-column="진행중"] .kanban-card');
          const box = card.getBoundingClientRect();
          window.__grip = { x: box.left + 20, y: box.top + 10 };
          card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: window.__grip.x, clientY: window.__grip.y }));
          return true;
        """)
        draggings.append(measure("window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: window.__grip.x + step * 5, clientY: window.__grip.y + Math.sin(step / 9) * 60 }))", 2.5))
        js("window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'mouse' })); return true")
        pump(0.5)
        js("document.querySelector('.start-view').scrollTop = 0; return true")
        scrollings.append(measure("document.querySelector('.start-view').scrollBy(0, step % 120 < 60 ? 12 : -12)", 2.5))
        pump(0.5)
    dragging = min(draggings, key=lambda entry: entry["p95"])
    scrolling = min(scrollings, key=lambda entry: entry["p95"])
    both = lambda entries: ", ".join(f"{entry['mean']}/{entry['p95']}" for entry in entries)  # noqa: E731
    numbers.append(f"WebKitGTK 300장 보드 — 끄는 동안 프레임 평균 {dragging['mean']}ms · p95 {dragging['p95']}ms · 최대 {dragging['max']}ms · CPU {dragging['cpu']}% (두 번: {both(draggings)})")
    numbers.append(f"홈을 굴리는 동안 평균 {scrolling['mean']}ms · p95 {scrolling['p95']}ms · 최대 {scrolling['max']}ms · CPU {scrolling['cpu']}% (두 번: {both(scrollings)})")
    check(
        "WebKitGTK: 300장 보드를 끄는 동안과 굴리는 동안 부드러움(p95 25ms 미만)",
        cards >= 300 and dragging["p95"] < 25 and scrolling["p95"] < 25,
        f"{cards}장 · 끌기 {json.dumps(dragging)} · 굴리기 {json.dumps(scrolling)}",
    )
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error).splitlines()[0])
    try:
        snapshot("webkit-groups-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    broadway.terminate()
    broadway.wait(timeout=10)
    for folder in (data_dir, folders):
        shutil.rmtree(folder, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-groups-results.json"), "w") as handle:
    json.dump({"results": results, "numbers": numbers}, handle, ensure_ascii=False, indent=2)
for line in numbers:
    print(f"· {line}")
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
