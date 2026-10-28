#!/usr/bin/env python3
"""Pictures pasted into documents in WebKitGTK (the engine the Linux app runs on), with real key presses.

Runs the real Workbench UI in WebKitGTK on a private GTK Broadway display (its own clipboard: the
user's clipboard is never read or changed), against a gateway on a temporary data folder whose
desktop clipboard tool is a stand-in wl-paste. A picture is put on the Broadway clipboard and real
Ctrl+V key events are sent:
  - Word: WebKitGTK gives the page's paste no picture (checked), the editor asks the window for the
    desktop clipboard's picture and embeds it; Ctrl+S → r2 with word/media.
  - PowerPoint: Ctrl+V on the slide (outside a text box) reaches the page's paste (WebKit asks the
    page first), the desktop picture goes on the slide; a picture copied inside the editor (Ctrl+C)
    pastes as itself; Ctrl+S → r2 with ppt/media.
  - Markdown: Ctrl+V → `![image](assets/…)` in the work folder; the preview shows it.
Writes snapshot PNGs and a results JSON.
Usage: python3 scripts/webkit-doc-images-check.py [out-dir]
"""
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from xml.sax.saxutils import escape

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-doc-images")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-images-")
cwd = tempfile.mkdtemp(prefix="workbench-webkit-images-cwd-")
scratch = tempfile.mkdtemp(prefix="workbench-webkit-images-tmp-")


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# A private display with its own clipboard; nothing of it shows on the desktop.
display = f":{free_port() % 1000 + 100}"
broadway = subprocess.Popen(["broadwayd", "--address", "127.0.0.1", "--port", str(free_port()), display], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
desktop_env = {key: os.environ[key] for key in ("WAYLAND_DISPLAY", "DISPLAY") if key in os.environ}
for key in desktop_env:
    del os.environ[key]
os.environ.update({"GDK_BACKEND": "broadway", "BROADWAY_DISPLAY": display, "WEBKIT_DISABLE_COMPOSITING_MODE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1"})

import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk, WebKit2  # noqa: E402

# ── documents and the stand-in desktop clipboard tool ──────────────────────
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def make_docx(path, texts):
    body = "".join('<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % escape(t) for t in texts)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>' % (W, body))


make_docx(os.path.join(cwd, "계획.docx"), ["가을 특강 계획", "질문에서 시작하는 글쓰기"])
shutil.copyfile(os.path.join(repo, "scripts", "fixtures", "cover.pptx"), os.path.join(cwd, "표지.pptx"))
with open(os.path.join(cwd, "노트.md"), "w") as handle:
    handle.write("# 노트\n\n도식은 아래에.\n")

# The picture on the "desktop clipboard": a PNG drawn by GdkPixbuf; the stand-in wl-paste hands it out.
picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 160, 96)
picture.fill(0x2E86ABFF)
ok, png = picture.save_to_bufferv("png", [], [])
desktop_png = os.path.join(scratch, "desktop.png")
with open(desktop_png, "wb") as handle:
    handle.write(png)
wl_paste = os.path.join(scratch, "wl-paste")
with open(wl_paste, "w") as handle:
    handle.write('#!/bin/sh\nif [ "$1" = "--list-types" ]; then printf \'image/png\\n\'; exit 0; fi\nif [ "$3" = "image/png" ]; then cat "%s"; exit 0; fi\nexit 1\n' % desktop_png)
os.chmod(wl_paste, 0o755)

host = subprocess.Popen(
    ["node", "apps/host/src/main.ts"],
    cwd=repo,
    env={**os.environ, **desktop_env, "WORKBENCH_DATA_DIR": data_dir, "WORKBENCH_WEB_DIR": "apps/web/dist", "WAYLAND_DISPLAY": "wayland-check", "WORKBENCH_WL_PASTE": wl_paste},
    stdout=subprocess.PIPE,
    text=True,
)
ready = None
for line in host.stdout:
    if line.startswith("WORKBENCH_READY "):
        ready = json.loads(line[len("WORKBENCH_READY "):])
        break
url, token = ready["url"], ready["token"]


def request(method, path, body=None, raw=False):
    req = urllib.request.Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    with urllib.request.urlopen(req) as response:
        data = response.read()
        return data if raw else json.loads(data)


def media(artifact_id, revision):
    data = request("GET", f"/api/artifacts/{artifact_id}/raw?revision={revision}", raw=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return [name for name in z.namelist() if "/media/" in name and not name.endswith("/")]


request("PUT", "/api/prefs", {"prefs": {"onboarding": "done", "startScreen": "last"}})
work = request("POST", "/api/works", {"title": "WebKit 그림", "folderId": None, "cwd": cwd})
docs = {name: request("POST", f"/api/works/{work['id']}/artifacts", {"path": name}) for name in ("계획.docx", "표지.pptx", "노트.md")}

# ── the window, and helpers in every frame ───────────────────────────────
WINDOW_SCRIPT = """
(() => {
  if (window.top !== window) return;
  localStorage.setItem("workbench.lastWork", %s);
  window.__frames = {};
  window.addEventListener("message", (event) => {
    if (event.data && event.data.__test === "state") window.__frames[event.data.kind] = event.data;
  });
})();
""" % json.dumps(work["id"])
# Before the page's own scripts: what each paste event carried, as the page saw it.
FRAME_EARLY = """
(() => {
  window.__pastes = [];
  window.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    window.__pastes.push({ trusted: event.isTrusted, files: data ? data.files.length : -1, types: data ? [...data.types] : [] });
  }, true);
})();
"""
FRAME_SCRIPT = """
(() => {
  if (window.top === window || !location.pathname.startsWith("/office/")) return;
  const kind = location.pathname.split("/").pop().replace(".html", "");
  const mainStage = () => {
    const stages = (window.Konva && window.Konva.stages) || [];
    return stages.length ? stages.reduce((a, b) => (b.width() > a.width() ? b : a)) : null;
  };
  setInterval(() => {
    const editor = document.querySelector(".ProseMirror");
    const stage = mainStage();
    window.parent.postMessage({ __test: "state", kind, text: editor ? editor.textContent : stage ? stage.find("Text").map((n) => n.text()).join("") : "",
      images: editor ? editor.querySelectorAll("img").length : stage ? stage.find("Image").length : -1, pastes: window.__pastes }, "*");
  }, 300);
  const press = (target, init) => {
    for (const type of ["mousedown", "mouseup", "click"]) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0, view: window, ...init }));
  };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || !data.__test || event.source !== window.parent) return;
    if (data.__test === "caret-end") {
      const paragraph = document.querySelector(".ProseMirror p");
      paragraph.closest(".ProseMirror").focus();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    if (data.__test === "blur") {
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      document.body.focus();
    }
    if (data.__test === "select-picture") {
      // Click the newest picture on the slide, as a mouse would.
      const stage = mainStage();
      const node = stage.find("Image").slice(-1)[0];
      const rect = node.getClientRect();
      const box = stage.container().getBoundingClientRect();
      const scale = box.width / stage.width();
      const x = box.left + (rect.x + rect.width / 2) * scale, y = box.top + (rect.y + rect.height / 2) * scale;
      press(document.elementFromPoint(x, y), { clientX: x, clientY: y, buttons: 1 });
    }
    if (data.__test === "save") {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true }));
    }
  });
})();
"""

results = []


def check(name, passed, detail=""):
    results.append({"step": name, "ok": bool(passed), "detail": detail})
    print(("PASS " if passed else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


# Broadway without a viewer reports no screen resolution, and WebKit would lay pages out with a
# negative pixel ratio: give it the usual 96 dpi.
Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow()
window.set_default_size(1440, 920)
content = WebKit2.UserContentManager()
content.add_script(WebKit2.UserScript(WINDOW_SCRIPT, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
content.add_script(WebKit2.UserScript(FRAME_EARLY, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
content.add_script(WebKit2.UserScript(FRAME_SCRIPT, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.END, None, None))
view = WebKit2.WebView.new_with_user_content_manager(content)
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
window.add(view)
window.show_all()
view.grab_focus()
focus_in = Gdk.Event.new(Gdk.EventType.FOCUS_CHANGE)
focus_in.focus_change.window = window.get_window()
focus_in.focus_change.send_event = 1
focus_in.focus_change.in_ = 1
window.event(focus_in)
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


def frame(kind):
    return js("return (window.__frames || {})[%s] || null" % json.dumps(kind)) or {}


def to_frame(message):
    js("const f = document.querySelector('iframe.office-frame'); if (f) { f.focus(); f.contentWindow.postMessage(%s, '*'); } return Boolean(f);" % json.dumps(message))


def key(keyval, ctrl=False):
    """A real key press and release, as the keyboard sends them (WebKit runs its own key bindings on them)."""
    seat = Gdk.Display.get_default().get_default_seat()
    found, keys = Gdk.Keymap.get_for_display(Gdk.Display.get_default()).get_entries_for_keyval(keyval)
    for kind in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE):
        event = Gdk.Event.new(kind)
        event.key.window = window.get_window()
        event.key.send_event = 1
        event.key.keyval = keyval
        event.key.hardware_keycode = keys[0].keycode if found and keys else 0
        event.key.state = Gdk.ModifierType.CONTROL_MASK if ctrl else 0
        event.key.time = Gtk.get_current_event_time()
        event.set_device(seat.get_keyboard())
        Gtk.main_do_event(event)
    pump(0.2)


def status():
    return js("return (document.querySelector('.save-state') || {}).textContent || ''") or ""


def open_doc(name):
    js("""const back = document.querySelector('.doc-tab.conversation'); if (back) back.click(); return true;""")
    pump(0.6)
    js("""document.querySelector('.docs-button').click();
          setTimeout(() => { const item = [...document.querySelectorAll('.docs-menu *')].find((el) => el.children.length === 0 && el.textContent.trim() === %s); item && item.click(); }, 300);
          return true;""" % json.dumps(name))


def snapshot(name):
    box = {}

    def saved(source, result):
        source.get_snapshot_finish(result).write_to_png(os.path.join(out_dir, name))
        box["done"] = True

    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, saved)
    while "done" not in box:
        context.iteration(True)


clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
try:
    view.load_uri(f"{url}/?token={token}")
    if not until(lambda: js("return Boolean(document.querySelector('.docs-button'))"), 60):
        raise RuntimeError("the work view did not open")

    # ── Word ───────────────────────────────────────────────────────────────
    started = time.time()
    open_doc("계획.docx")
    opened = until(lambda: "가을 특강" in (frame("docs").get("text") or "") and "r1 저장됨" in status(), 90)
    check("WebKitGTK: 워드 편집기 열림", opened, f"{time.time() - started:.1f}s")
    pump(1.5)
    clipboard.set_image(picture)
    to_frame({"__test": "caret-end"})
    pump(0.4)
    key(Gdk.KEY_v, ctrl=True)
    inserted = until(lambda: frame("docs").get("images", 0) >= 1, 15)
    pastes = frame("docs").get("pastes") or []
    first = next((entry for entry in pastes if entry.get("trusted")), None)
    check("Ctrl+V: WebKitGTK는 붙여넣기에 그림을 주지 않음 → 데스크톱 클립보드 그림이 워드에 들어감", inserted and first and first["files"] == 0, json.dumps(first))
    snapshot("webkit-docx.png")
    to_frame({"__test": "save"})
    saved = until(lambda: "r2 저장됨" in status(), 30)
    found = media(docs["계획.docx"]["id"], 2) if saved else []
    check("Ctrl+S → r2, docx 안에 그림(word/media)", saved and len(found) == 1, ",".join(found))

    # ── PowerPoint ─────────────────────────────────────────────────────────
    open_doc("표지.pptx")
    opened = until(lambda: "특강" in (frame("slides").get("text") or "") and "r1 저장됨" in status(), 90)
    check("WebKitGTK: PPT 편집기 열림", opened)
    pump(1.5)
    before = frame("slides").get("images", 0)
    to_frame({"__test": "blur"})
    pump(0.4)
    key(Gdk.KEY_v, ctrl=True)
    pasted = until(lambda: frame("slides").get("images", 0) == before + 1, 15)
    check("슬라이드에서 Ctrl+V(글 상자 밖): 데스크톱 클립보드 그림이 슬라이드에 들어감", pasted, f"{before} → {frame('slides').get('images')}")
    to_frame({"__test": "select-picture"})
    pump(0.6)
    key(Gdk.KEY_c, ctrl=True)
    pump(0.4)
    key(Gdk.KEY_v, ctrl=True)
    copied = until(lambda: frame("slides").get("images", 0) == before + 2, 15)
    check("편집기 안에서 복사(Ctrl+C)한 그림은 Ctrl+V로 그 그림이 붙음(클립보드 표시)", copied, f"→ {frame('slides').get('images')}")
    snapshot("webkit-pptx.png")
    to_frame({"__test": "save"})
    saved = until(lambda: "r2 저장됨" in status(), 40)
    found = media(docs["표지.pptx"]["id"], 2) if saved else []
    check("Ctrl+S → r2, pptx 안에 그림(ppt/media)", saved and len(found) >= 1, ",".join(found))

    # ── Markdown ───────────────────────────────────────────────────────────
    open_doc("노트.md")
    until(lambda: js("return Boolean(document.querySelector('.md-editor .cm-content'))"), 20)
    js("""const content = document.querySelector('.md-editor .cm-content'); content.focus();
          const lines = content.querySelectorAll('.cm-line'); const range = document.createRange();
          range.selectNodeContents(lines[lines.length - 1]); range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); return true;""")
    pump(0.3)
    key(Gdk.KEY_v, ctrl=True)
    linked = until(lambda: js("return /!\\[image\\]\\(assets\\/[0-9a-f]{16}\\.png\\)/.test(document.querySelector('.md-editor .cm-content').innerText)"), 15)
    stored = os.listdir(os.path.join(cwd, "assets")) if os.path.isdir(os.path.join(cwd, "assets")) else []
    check("마크다운 Ctrl+V: 데스크톱 그림 → 작업 폴더 assets/ + 상대 링크", linked and len(stored) == 1, ",".join(stored))
    until(lambda: "r2 저장됨" in status(), 15)
    js("""[...document.querySelectorAll('.document-view .segmented [role=radio]')].find((b) => b.textContent.trim() === '미리보기').click(); return true;""")
    shown = until(lambda: js("const img = document.querySelector('.doc-preview .markdown img'); return Boolean(img && img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:'))"), 15)
    check("WebKitGTK 미리보기에 작업 폴더 그림이 보임", shown)
    pump(0.5)
    snapshot("webkit-markdown.png")
except Exception as error:  # noqa: BLE001
    check("실행", False, str(error))
    try:
        snapshot("webkit-failure.png")
    except Exception:  # noqa: BLE001
        pass
finally:
    host.terminate()
    host.wait(timeout=30)
    broadway.terminate()
    broadway.wait(timeout=10)
    for folder in (data_dir, cwd, scratch):
        shutil.rmtree(folder, ignore_errors=True)

with open(os.path.join(out_dir, "webkit-doc-images-results.json"), "w") as handle:
    json.dump(results, handle, ensure_ascii=False, indent=2)
failed = [entry for entry in results if not entry["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
