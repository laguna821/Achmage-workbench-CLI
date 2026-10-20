#!/usr/bin/env python3
"""Check the design page in WebKitGTK (the engine the Linux app runs on), off screen.

Starts a gateway on a temporary data folder, creates a design, loads a same-origin parent page that
answers the design page like the Workbench window, then: the editor opens, an added heading is saved
as revision 2, and the hidden renderer draws a thumbnail. Writes a snapshot PNG.
Usage: python3 scripts/webkit-design-check.py [out-dir]
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

# Off screen there is no GL context: draw without GPU compositing (canvas 2D is what the editor uses).
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-design")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-")
cwd = tempfile.mkdtemp(prefix="workbench-webkit-cwd-")

host = subprocess.Popen(
    ["node", os.environ.get("HOST_ENTRY", "apps/host/src/main.ts")],
    cwd=repo,
    env={**os.environ, "WORKBENCH_DATA_DIR": data_dir, "WORKBENCH_WEB_DIR": "apps/web/dist"},
    stdout=subprocess.PIPE,
    text=True,
)
ready = None
for line in host.stdout:
    if line.startswith("WORKBENCH_READY "):
        ready = json.loads(line[len("WORKBENCH_READY "):])
        break
url, token = ready["url"], ready["token"]


def api(method, path, body=None):
    request = urllib.request.Request(
        url + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())


work = api("POST", "/api/works", {"title": "WebKit 확인", "folderId": None, "cwd": cwd})
design = api("POST", f"/api/works/{work['id']}/designs", {"name": "포스터", "preset": "portrait"})

harness = f"""<!doctype html><html><body style="margin:0">
<iframe id="editor" style="border:0;width:1400px;height:880px"></iframe>
<iframe id="render" src="/design/?mode=render" style="display:none"></iframe>
<script>
  window.messages = [];
  window.init = {{ type: "design:init", token: {json.dumps(token)}, artifactId: {json.dumps(design['id'])}, revision: null, readOnly: false, theme: "light" }};
  window.addEventListener("message", (event) => {{
    window.messages.push(event.data);
    if (event.data.type === "design:ready") event.source.postMessage(window.init, location.origin);
    if (event.data.type === "render:ready") event.source.postMessage({{ type: "render:init", token: window.init.token }}, location.origin);
  }});
  document.getElementById("editor").src = "/design/";
</script></body></html>"""

results = []
window = Gtk.OffscreenWindow()
window.set_default_size(1400, 880)
view = WebKit2.WebView()
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
window.add(view)
window.show_all()
view.load_html(harness, url + "/")
loop = GLib.MainLoop()


def evaluate(script, done):
    def finished(source, result):
        try:
            value = source.evaluate_javascript_finish(result)
            done(json.loads(value.to_string()) if value and not value.is_undefined() else None)
        except Exception as error:  # noqa: BLE001
            done({"error": str(error)})

    view.evaluate_javascript(f"JSON.stringify((() => {{ {script} }})())", -1, None, None, None, finished)


def check(name, ok, detail=""):
    results.append({"step": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


state = {"phase": "open", "deadline": time.time() + 60}


def snapshot_then_quit():
    def saved(source, result):
        surface = source.get_snapshot_finish(result)
        surface.write_to_png(os.path.join(out_dir, "webkit-editor.png"))
        loop.quit()

    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, saved)


def tick():
    if time.time() > state["deadline"]:
        check(f"시간 안에 끝남 ({state['phase']})", False)
        snapshot_then_quit()
        return False

    def on_state(value):
        if not value:
            return
        types = value.get("types", [])
        if state["phase"] == "open" and "design:opened" in types and value.get("canvas", 0) > 0:
            check("WebKitGTK에서 편집기 열림", True, f"canvas {value['canvas']}개")
            state["phase"] = "edit"
            state["deadline"] = time.time() + 30
            evaluate(
                """const doc = document.getElementById('editor').contentDocument;
                   const rail = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '글자');
                   rail && rail.click(); return { clicked: Boolean(rail) };""",
                lambda v: None,
            )
            GLib.timeout_add(1200, lambda: evaluate(
                """const doc = document.getElementById('editor').contentDocument;
                   const add = [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('제목 추가'));
                   add && add.click(); return { clicked: Boolean(add) };""",
                lambda v: None,
            ) and False)
        elif state["phase"] == "edit" and "design:saved" in types:
            latest = api("GET", f"/api/artifacts/{design['id']}/text")
            heading = [o for o in json.loads(latest["text"])["pages"][0]["objects"] if o.get("type") == "textbox"]
            check("편집이 r2로 저장", latest["revision"] == 2 and heading, f"r{latest['revision']} {heading[0].get('fontFamily') if heading else ''}")
            state["phase"] = "render"
            state["deadline"] = time.time() + 30
            text = json.dumps(latest["text"])
            evaluate(
                f"""document.getElementById('render').contentWindow.postMessage({{ type: 'render:request', id: 'w1', artifactId: {json.dumps(design['id'])}, document: {text}, page: 0, width: 300 }}, location.origin);
                    return {{ sent: true }};""",
                lambda v: None,
            )
        elif state["phase"] == "render":
            result = value.get("render")
            if result:
                check("WebKitGTK 썸네일 렌더", bool(result.get("dataUrl")), result.get("error") or f"{len(result.get('dataUrl') or '')} bytes")
                state["phase"] = "done"
                snapshot_then_quit()
        if value.get("errors"):
            state.setdefault("errors", set()).update(value["errors"])

    evaluate(
        """const doc = document.getElementById('editor').contentDocument;
           const render = window.messages.find((m) => m.type === 'render:result');
           return { types: window.messages.map((m) => m.type), canvas: doc ? doc.querySelectorAll('canvas').length : 0,
                    render: render ? { dataUrl: render.dataUrl ? render.dataUrl.slice(0, 64) + '…' + render.dataUrl.length : null, error: render.error } : null,
                    errors: window.messages.filter((m) => m.type === 'design:error').map((m) => m.message) };""",
        on_state,
    )
    return state["phase"] != "done"


GLib.timeout_add(700, tick)
GLib.timeout_add(150_000, lambda: (check("전체 시간 초과", False), loop.quit()))
try:
    loop.run()
finally:
    host.terminate()
if state.get("errors"):
    check("편집기 오류 없음", False, " / ".join(state["errors"]))
with open(os.path.join(out_dir, "webkit-results.json"), "w") as handle:
    json.dump(results, handle, ensure_ascii=False, indent=2)
host.terminate()
failed = [r for r in results if not r["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
