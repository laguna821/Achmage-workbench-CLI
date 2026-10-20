#!/usr/bin/env python3
"""Memory cost of the design editor in WebKitGTK (the Linux app's engine), off screen.

Loads the real Workbench UI, then adds the design page the way the document view does, then removes
it again, and reports the proportional set size (PSS) of the WebKit processes at each step.
Usage: python3 scripts/webkit-design-memory.py
"""
import json
import os
import subprocess
import tempfile
import time
import urllib.request

os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-mem-")
cwd = tempfile.mkdtemp(prefix="workbench-mem-cwd-")
host = subprocess.Popen(
    ["node", os.environ.get("HOST_ENTRY", "apps/host/dist/host.mjs")],
    cwd=repo,
    env={**os.environ, "WORKBENCH_DATA_DIR": data_dir, "WORKBENCH_WEB_DIR": "apps/web/dist"},
    stdout=subprocess.PIPE,
    text=True,
)
for line in host.stdout:
    if line.startswith("WORKBENCH_READY "):
        ready = json.loads(line[len("WORKBENCH_READY "):])
        break
url, token = ready["url"], ready["token"]


def api(method, path, body=None):
    request = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())


work = api("POST", "/api/works", {"title": "메모리", "folderId": None, "cwd": cwd})
design = api("POST", f"/api/works/{work['id']}/designs", {"name": "포스터", "preset": "portrait"})


def pss_kib(pid):
    try:
        with open(f"/proc/{pid}/smaps_rollup") as handle:
            for line in handle:
                if line.startswith("Pss:"):
                    return int(line.split()[1])
    except OSError:
        return 0
    return 0


def webkit_children():
    me = os.getpid()
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as handle:
                parent = int(handle.read().rsplit(")", 1)[1].split()[1])
            with open(f"/proc/{entry}/comm") as handle:
                name = handle.read().strip()
        except OSError:
            continue
        if parent == me and name.startswith("WebKit"):
            found.append((int(entry), name))
    return found


def measure(label):
    processes = webkit_children()
    total = sum(pss_kib(pid) for pid, _ in processes) + pss_kib(os.getpid())
    parts = ", ".join(f"{name} {pss_kib(pid) // 1024}MB" for pid, name in processes)
    print(f"{label}: {total // 1024} MB (웹 프로세스들: {parts}; 이 스크립트 셸 {pss_kib(os.getpid()) // 1024}MB)", flush=True)
    return total


window = Gtk.OffscreenWindow()
window.set_default_size(1440, 900)
view = WebKit2.WebView()
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
window.add(view)
window.show_all()
view.load_uri(f"{url}/?token={token}")
loop = GLib.MainLoop()


def js(script):
    view.evaluate_javascript(script, -1, None, None, None, None)


steps = []


def step_baseline():
    steps.append(measure("1. Workbench 화면만"))
    js(f"""window.__m = [];
      window.addEventListener('message', (e) => {{ window.__m.push(e.data.type);
        if (e.data.type === 'design:ready') e.source.postMessage({{ type: 'design:init', token: {json.dumps(token)}, artifactId: {json.dumps(design['id'])}, revision: null, readOnly: false, theme: 'light' }}, location.origin); }});
      const f = document.createElement('iframe'); f.id = 'mem-design'; f.src = '/design/'; f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:99';
      document.body.appendChild(f);""")
    GLib.timeout_add(9000, step_open)
    return False


def step_open():
    steps.append(measure("2. 디자인 편집기 열림"))
    js("document.getElementById('mem-design').remove();")
    GLib.timeout_add(15000, step_closed)
    return False


def step_closed():
    steps.append(measure("3. 편집기 닫은 뒤 15초"))
    loop.quit()
    return False


GLib.timeout_add(6000, step_baseline)
GLib.timeout_add(90_000, loop.quit)
try:
    loop.run()
finally:
    host.terminate()
if len(steps) == 3:
    print(f"편집기 증가분 {(steps[1] - steps[0]) // 1024} MB, 닫은 뒤 남은 증가분 {(steps[2] - steps[0]) // 1024} MB")
