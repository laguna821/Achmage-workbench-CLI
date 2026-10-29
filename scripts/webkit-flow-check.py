#!/usr/bin/env python3
"""Home "흐름" as a calendar in WebKitGTK (the engine the Linux app runs on), off screen.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display against a gateway on a
temporary data folder seeded with known requests (scripts/seed-flow.ts) and a calendar feed served
by a local HTTP server (nothing of the user's is touched), in Asia/Seoul: the week view (Monday
first, the real dates, cells and calendar events laid out, ← → by week with WebKit key events) and
the month view (whole weeks, other months dimmed, work lines and events). Writes snapshots and a
results JSON.
Usage: python3 scripts/webkit-flow-check.py [out-dir]
"""
import datetime
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from zoneinfo import ZoneInfo

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-flow")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-flow-")
works_dir = tempfile.mkdtemp(prefix="workbench-webkit-flow-works-")
os.environ["TZ"] = "Asia/Seoul"
time.tzset()
seoul = ZoneInfo("Asia/Seoul")
today = datetime.datetime.now(seoul).date()
yesterday = today - datetime.timedelta(days=1)
monday = yesterday - datetime.timedelta(days=yesterday.weekday())
WD = "월화수목금토일"


def key(day):
    return day.isoformat()


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# A calendar to subscribe to: a weekly class (Monday and Wednesday) and a meeting yesterday.
SECRET = "private-" + "0123456789abcdef" * 2
stamp = lambda day, hour: day.strftime("%Y%m%d") + f"T{hour:02d}0000"  # noqa: E731
ICS = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:학과 일정", "X-WR-TIMEZONE:Asia/Seoul",
    "BEGIN:VEVENT", "UID:class@webkit", f"DTSTART;TZID=Asia/Seoul:{stamp(monday - datetime.timedelta(days=7), 16)}", "DURATION:PT1H30M", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12", "SUMMARY:미디어와 사회", "END:VEVENT",
    "BEGIN:VEVENT", "UID:meeting@webkit", f"DTSTART;TZID=Asia/Seoul:{stamp(yesterday, 10)}", f"DTEND;TZID=Asia/Seoul:{stamp(yesterday, 11)}", "SUMMARY:학과 회의", "END:VEVENT",
    "BEGIN:VEVENT", "UID:trip@webkit", f"DTSTART;VALUE=DATE:{yesterday.strftime('%Y%m%d')}", f"DTEND;VALUE=DATE:{today.strftime('%Y%m%d')}", "SUMMARY:학회", "END:VEVENT",
    "END:VCALENDAR",
])


class Calendar(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = ICS.encode() if SECRET in self.path else b"not found"
        self.send_response(200 if SECRET in self.path else 404)
        self.send_header("content-type", "text/calendar; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


calendar_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Calendar)
threading.Thread(target=calendar_server.serve_forever, daemon=True).start()
feed_url = f"http://127.0.0.1:{calendar_server.server_address[1]}/calendar/ical/webkit%40example.com/{SECRET}/basic.ics"

seeded = subprocess.run(["node", "scripts/seed-flow.ts", data_dir, works_dir], cwd=repo, capture_output=True, text=True, check=True)
requests = json.loads([line for line in seeded.stdout.splitlines() if line.startswith("{")][-1])["requests"]

display = f":{free_port() % 1000 + 100}"
broadway = subprocess.Popen(["broadwayd", "--address", "127.0.0.1", "--port", str(free_port()), display], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
for name in ("WAYLAND_DISPLAY", "DISPLAY"):
    os.environ.pop(name, None)
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


feed = request("POST", "/api/calendar/feeds", {"url": feed_url, "name": "학과 일정", "color": "#0F8C84"})

results = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


check("캘린더 연결(게이트웨이): 응답에 주소 없음", SECRET not in json.dumps(feed), f"{feed['host']} {feed['hint']}")

Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1440, 1000)
content = WebKit2.UserContentManager()
state = json.dumps({"v": 2, "view": "week", "anchor": key(yesterday), "on": key(today)})
content.add_script(WebKit2.UserScript("localStorage.setItem('workbench.homeFlow.v2', %s);" % json.dumps(state), WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
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

    view.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, saved)
    until(lambda: box.get("done"), 10)


def scroll_to(selector):
    js("const element = document.querySelector(%s); if (element) element.scrollIntoView({ block: 'start' }); return true" % json.dumps(selector))
    pump(0.3)


try:
    view.load_uri(f"{url}/?token={token}")
    until(lambda: js("return Boolean(document.querySelector('.topbar .brand'))"), 20)
    js("document.querySelector('.topbar .brand').click(); return true")
    until(lambda: js("return document.querySelector('.flow-cal')?.getAttribute('data-view')"), 15)

    # The week holding yesterday: headers, cells, events.
    morning = next(entry for entry in requests if entry["id"] == "user-morning")
    hour = datetime.datetime.fromtimestamp(morning["start"] / 1000, seoul).hour
    week = until(lambda: js("""
      const cell = document.querySelector('.flow-col[data-day="%s"] .flow-cell[data-hour="%d"]');
      const events = [...document.querySelectorAll('.flow-week .flow-event')];
      if (!cell || !events.length) return null;
      const box = (element) => { const rect = element.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)]; };
      return {
        title: document.querySelector('.flow-title > span').textContent,
        heads: [...document.querySelectorAll('.flow-week-day')].map((head) => head.querySelector('.flow-wd').textContent + head.querySelector('.flow-date').textContent),
        today: document.querySelector('.flow-week-day.today .flow-date')?.textContent ?? null,
        cell: cell.textContent, cellBox: box(cell),
        cellBackground: getComputedStyle(cell).backgroundColor,
        events: events.map((event) => event.textContent),
        eventBox: box(events[0]), eventBackground: getComputedStyle(events[0]).backgroundColor,
        chips: [...document.querySelectorAll('.flow-week .flow-chip')].map((chip) => chip.textContent),
      };
    """ % (key(yesterday), hour)), 15) or {}
    expected_heads = [WD[(monday + datetime.timedelta(days=index)).weekday()] + (f"{(monday + datetime.timedelta(days=index)).month}/1" if (monday + datetime.timedelta(days=index)).day == 1 else str((monday + datetime.timedelta(days=index)).day)) for index in range(7)]
    scroll_to(".flow-cal")
    snapshot("webkit-flow-week.png")
    check("WebKitGTK 주: 월요일부터 실제 날짜, 어제 칸에 작업과 요청 수", week.get("heads") == expected_heads and "Codex 달력" in week.get("cell", ""), f"{week.get('title')} · {' '.join(week.get('heads', []))} · {week.get('cell')}")
    check("WebKitGTK 주: 칸과 일정의 크기·색(color-mix, calc로 나눈 폭)", (week.get("cellBox") or [0, 0])[0] > 40 and (week.get("eventBox") or [0, 0])[0] > 40 and week.get("eventBackground", "rgba(0, 0, 0, 0)") not in ("rgba(0, 0, 0, 0)", "transparent"), f"칸 {week.get('cellBox')} {week.get('cellBackground')} · 일정 {week.get('eventBox')} {week.get('eventBackground')}")
    check("WebKitGTK 주: 매주 수업·회의·종일 학회", any("미디어와 사회" in text for text in week.get("events", [])) and any("학과 회의" in text for text in week.get("events", [])) and "학회" in week.get("chips", []), " | ".join(week.get("events", [])))

    # ← → by week, as WebKit delivers keys (focus out of the home input first).
    before = js("document.activeElement?.blur(); return document.querySelector('.flow-title > span').textContent")
    js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true })); return true")
    pump(0.3)
    back = js("return document.querySelector('.flow-title > span').textContent")
    js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true })); return true")
    pump(0.3)
    again = js("return document.querySelector('.flow-title > span').textContent")
    check("WebKitGTK: ← → 로 한 주씩", back != before and again == before, f"{before} → {back} → {again}")

    # The month.
    js("[...document.querySelectorAll('.flow-views button')].find((button) => button.textContent === '달').click(); return true")
    month = until(lambda: js("""
      const days = [...document.querySelectorAll('.flow-month-day')];
      const work = document.querySelectorAll('.flow-month .flow-line.work').length;
      const events = document.querySelectorAll('.flow-month .flow-line.event').length;
      if (!days.length || !work || !events) return null;
      return {
        title: document.querySelector('.flow-title > span').textContent,
        count: days.length,
        first: days[0].getAttribute('data-day'),
        other: days.filter((day) => day.classList.contains('other')).length,
        today: document.querySelector('.flow-month-day.today')?.getAttribute('data-day') ?? null,
        work, events,
        yesterday: document.querySelector('.flow-month-day[data-day="%s"]')?.textContent ?? '',
        label: document.querySelector('.flow-month-day[data-day="%s"]')?.getAttribute('aria-label') ?? '',
        rows: getComputedStyle(document.querySelector('.flow-month-body')).gridTemplateColumns.split(' ').length,
      };
    """ % (key(yesterday), key(yesterday))), 15) or {}
    first_of_month = yesterday.replace(day=1)
    grid_first = first_of_month - datetime.timedelta(days=first_of_month.weekday())
    scroll_to(".flow-cal")
    snapshot("webkit-flow-month.png")
    check(
        "WebKitGTK 달: 월요일 시작 달력, 일곱 칸, 앞뒤 달은 흐리게, 오늘 표시",
        month.get("first") == key(grid_first) and month.get("count") in (28, 35, 42) and month.get("rows") == 7 and month.get("today") in (key(today), None),
        f"{month.get('title')} · {month.get('count')}칸 · 첫날 {month.get('first')} · 흐린 날 {month.get('other')}",
    )
    # Four lines a day (two events first); what does not fit is "외 N", and the day's label names all.
    label = month.get("label", "")
    check("WebKitGTK 달: 어제 칸에 일정과 작업(넘치면 '외 N', 설명에는 모두)", "학회" in month.get("yesterday", "") and "외 " in month.get("yesterday", "") and all(name in label for name in ("Codex 달력", "Claude 달력", "학과 회의", "학회")), month.get("yesterday", "")[:120])
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error).splitlines()[0])
    try:
        snapshot("webkit-flow-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    broadway.terminate()
    broadway.wait(timeout=10)
    calendar_server.shutdown()
    for folder in (data_dir, works_dir):
        shutil.rmtree(folder, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-flow-results.json"), "w") as handle:
    json.dump(results, handle, ensure_ascii=False, indent=2)
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
