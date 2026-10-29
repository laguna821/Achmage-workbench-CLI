#!/usr/bin/env python3
"""A vault note as the Linux app shows it, in WebKitGTK (the engine the app runs on), off screen.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display against a gateway on a
temporary data folder and a fixture vault in a temporary folder (the user's vault is never touched),
with a local server standing in for R2. Opens a note with callouts (one folded), a highlight, a
tag, a vault picture, web pictures (Markdown and `<img width>`), `<details>`, a script that must
not run, and `![[note#heading]]`; checks what WebKit drew and that the web pictures loaded without
the gateway's token. Writes a snapshot PNG and a results JSON.
Usage: python3 scripts/webkit-vault-markdown-check.py [out-dir]
"""
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-vault-markdown")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-vault-")
vault = tempfile.mkdtemp(prefix="workbench-webkit-vault-notes-")


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
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk, WebKit2  # noqa: E402


def png(rgb):
    picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 240, 140)
    picture.fill(rgb)
    return picture.save_to_bufferv("png", [], [])[1]


# ── a stand-in for R2 that remembers what each request carried ────────────────
seen = []


class Pictures(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        seen.append({"path": self.path, "authorization": self.headers.get("authorization"), "referer": self.headers.get("referer")})
        body = png(0xD85A3CFF)
        self.send_response(200)
        self.send_header("content-type", "image/png")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


remote = ThreadingHTTPServer(("127.0.0.1", 0), Pictures)
threading.Thread(target=remote.serve_forever, daemon=True).start()
web = f"http://127.0.0.1:{remote.server_address[1]}"


def put(path, data):
    full = os.path.join(vault, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb" if isinstance(data, bytes) else "w") as handle:
        handle.write(data)


put(".obsidian/app.json", "{}")
put("attachments/pic.png", png(0x2F6FDFFF))
put("20. Information/표시 검사.md", "\n".join([
    "# 표시 검사", "",
    "> [!NOTE] 회의 메모", "> 본문 ==강조== 와 #워크벤치 태그", "",
    "> [!warning]- 접힌 경고", "> 숨은 내용", "",
    "![[pic.png|120]]", "",
    f"![원격 그림|200]({web}/r2.png)", "",
    f'<img src="{web}/r2-html.png" alt="HTML 그림" width="150" onerror="window.__ran = 1">', "",
    "<details><summary>더 보기</summary>", "", "접힌 HTML 내용", "", "</details>", "",
    "<script>window.__ran = 2</script>", "",
    "![[수업 설계#목표]]", "",
]))
put("20. Information/수업 설계.md", "# 수업 설계\n\n소개 문단\n\n## 목표\n\n학생이 직접 써 본다\n\n## 평가\n\n평가 기준\n")

host = subprocess.Popen(["node", "apps/host/src/main.ts"], cwd=repo, env={**os.environ, "WORKBENCH_DATA_DIR": data_dir, "WORKBENCH_WEB_DIR": "apps/web/dist"}, stdout=subprocess.PIPE, text=True)
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

results = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1280, 900)
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


try:
    view.load_uri(f"{url}/?token={token}")
    until(lambda: js("return Boolean(document.querySelector('.vault-row[data-vault-path=\"20. Information\"]'))"), 20)
    js("document.querySelector('.vault-row[data-vault-path=\"20. Information\"]').click(); return true")
    until(lambda: js("return [...document.querySelectorAll('.pkm-card')].some((card) => card.textContent.includes('표시 검사'))"), 15)
    js("[...document.querySelectorAll('.pkm-card')].find((card) => card.textContent.includes('표시 검사')).click(); return true")
    until(lambda: js("return document.querySelectorAll('.pkm-note-body .callout').length === 2"), 15)
    until(lambda: js("return [...document.querySelectorAll('.pkm-note-body img')].filter((image) => image.complete && image.naturalWidth > 0).length === 3"), 15)
    until(lambda: js("return Boolean(document.querySelector('.pkm-note-body .note-embed-body'))"), 10)
    state = js("""
      const body = document.querySelector('.pkm-note-body');
      const folded = body.querySelector('details.callout');
      const before = folded && !folded.open;
      folded && folded.querySelector('summary').click();
      return {
        callouts: [...body.querySelectorAll('.callout')].map((node) => node.dataset.kind),
        titles: [...body.querySelectorAll('.callout-title-inner')].map((node) => node.textContent),
        icons: body.querySelectorAll('.callout-icon svg').length,
        tint: getComputedStyle(body.querySelector('.callout')).backgroundColor,
        foldedBefore: before, openAfter: Boolean(folded && folded.open),
        mark: (body.querySelector('mark') || {}).textContent || null,
        tag: (body.querySelector('.md-tag') || {}).textContent || null,
        images: [...body.querySelectorAll('img')].map((image) => ({ alt: image.alt, width: image.getAttribute('width'), loaded: image.complete && image.naturalWidth > 0 })),
        details: (body.querySelector('details:not(.callout) > summary') || {}).textContent || null,
        ran: window.__ran === undefined ? null : window.__ran,
        embed: (body.querySelector('.note-embed') || {}).textContent || '',
        text: body.textContent,
      };
    """)
    pump(0.5)
    snapshot("webkit-vault-note.png")
    check("WebKitGTK: 콜아웃이 상자로(아이콘·제목·색), 접힌 것은 눌러 펼침",
          state["callouts"] == ["note", "warning"] and state["icons"] == 2 and "회의 메모" in state["titles"] and state["tint"] not in ("rgba(0, 0, 0, 0)", "transparent") and state["foldedBefore"] and state["openAfter"] and "[!NOTE]" not in state["text"],
          f"{state['callouts']} · {state['tint']}")
    check("WebKitGTK: ==강조==·#태그", state["mark"] == "강조" and state["tag"] == "#워크벤치", f"{state['mark']} · {state['tag']}")
    widths = {image["alt"]: image["width"] for image in state["images"]}
    check("WebKitGTK: 볼트 그림과 웹 그림(마크다운·<img width>)이 모두 보이고 크기도 그대로",
          all(image["loaded"] for image in state["images"]) and widths == {"pic.png": "120", "원격 그림": "200", "HTML 그림": "150"}, json.dumps(widths, ensure_ascii=False))
    remote_requests = [entry for entry in seen if entry["path"].startswith("/r2")]
    check("WebKitGTK: 웹 그림 요청에 토큰도 referer도 없음", len(remote_requests) >= 2 and all(not entry["authorization"] and not entry["referer"] for entry in remote_requests), f"{len(remote_requests)}건")
    check("WebKitGTK: <details>는 그려지고 스크립트·onerror는 실행되지 않음", state["details"] == "더 보기" and state["ran"] is None, f"ran={state['ran']}")
    check("WebKitGTK: ![[수업 설계#목표]]는 그 제목 아래만 보임", "학생이 직접 써 본다" in state["embed"] and "평가 기준" not in state["embed"])
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error).splitlines()[0])
    try:
        snapshot("webkit-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    remote.shutdown()
    broadway.terminate()
    broadway.wait(timeout=10)
    for folder in (data_dir, vault):
        shutil.rmtree(folder, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-vault-markdown-results.json"), "w") as handle:
    json.dump(results, handle, ensure_ascii=False, indent=2)
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
