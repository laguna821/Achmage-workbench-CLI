#!/usr/bin/env python3
"""Check the in-app Word editor in WebKitGTK (the engine the Linux app runs on), off screen.

Starts a gateway on a temporary data folder with a small .docx, loads the real Workbench UI, opens
the document (the editor page comes from the editors' own origin), types into the editor, saves
with Ctrl+S and reads revision 2 back from the gateway. The editor page is on another origin, so a
helper script injected into every frame reports its state to the window and performs the typing.
Also reports which newer CSS features the editor relies on are available. Writes a snapshot PNG.
Usage: python3 scripts/webkit-office-check.py [out-dir]
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from xml.sax.saxutils import escape

# Off screen there is no GL context: draw without GPU compositing.
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "wb-webkit-office")
os.makedirs(out_dir, exist_ok=True)
repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data_dir = tempfile.mkdtemp(prefix="workbench-webkit-office-")
cwd = tempfile.mkdtemp(prefix="workbench-webkit-office-cwd-")

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def make_docx(path, texts):
    body = "".join('<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % escape(t) for t in texts)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>' % (W, body))


def docx_text(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    paras = re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)
    return "\n".join("".join(re.findall(r"<w:t(?: [^>]*)?>([^<]*)</w:t>", p)) for p in paras)


make_docx(os.path.join(cwd, "계획.docx"), ["가을 특강 계획", "질문에서 시작하는 글쓰기", "10월 28일 오후 3시"])

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


def request(method, path, body=None, raw=False):
    req = urllib.request.Request(
        url + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req) as response:
        data = response.read()
        return data if raw else json.loads(data)


request("PUT", "/api/prefs", {"prefs": {"onboarding": "done"}})
work = request("POST", "/api/works", {"title": "WebKit 워드", "folderId": None, "cwd": cwd})
artifact = request("POST", f"/api/works/{work['id']}/artifacts", {"path": "계획.docx"})

# In the window: remember the work, and collect what the editor frame reports.
WINDOW_SCRIPT = """
(() => {
  if (window.top !== window) return;
  localStorage.setItem("workbench.lastWork", %s);
  window.__frame = null;
  window.addEventListener("message", (event) => {
    if (event.data && event.data.__test === "state") window.__frame = event.data;
  });
})();
""" % json.dumps(work["id"])
# In the editor frame (another origin): report its state; type and save when the window asks.
FRAME_ERRORS = """
(() => {
  if (window.top === window) return;
  window.__errors = [];
  window.addEventListener("error", (event) => window.__errors.push((String(event.message || event.error) + " @ " + String(event.error && event.error.stack)).slice(0, 1500)));
  window.addEventListener("unhandledrejection", (event) => window.__errors.push("rejection: " + String(event.reason && (event.reason.stack || event.reason.message) || event.reason).slice(0, 300)));
})();
"""
FRAME_SCRIPT = """
(() => {
  if (window.top === window || !location.pathname.startsWith("/office/")) return;
  const support = {
    anchor: CSS.supports("position-anchor: --x") && CSS.supports("top: anchor(bottom)"),
    autospace: CSS.supports("text-autospace: normal"),
    zoom: CSS.supports("zoom: 1.5"),
  };
  setInterval(() => {
    const editor = document.querySelector(".ProseMirror");
    window.parent.postMessage({ __test: "state", text: editor ? editor.textContent : null, support, href: location.href, ready: document.readyState,
      body: document.body ? document.body.innerHTML.length : -1, errors: window.__errors || [] }, "*");
  }, 400);
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || !data.__test || event.source !== window.parent) return;
    if (data.__test === "type") {
      const editor = document.querySelector(".ProseMirror");
      const paragraph = editor.querySelector("p");
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, data.text);
    }
    if (data.__test === "save") {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true }));
    }
  });
})();
"""

results = []
window = Gtk.OffscreenWindow()
window.set_default_size(1440, 920)
content = WebKit2.UserContentManager()
content.add_script(WebKit2.UserScript(WINDOW_SCRIPT, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
content.add_script(WebKit2.UserScript(FRAME_ERRORS, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
content.add_script(WebKit2.UserScript(FRAME_SCRIPT, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.END, None, None))
view = WebKit2.WebView.new_with_user_content_manager(content)
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
view.get_settings().set_enable_write_console_messages_to_stdout(True)
window.add(view)
window.show_all()
view.load_uri(f"{url}/?token={token}")
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


TYPED = " — 웹킷에서 고침"
state = {"phase": "app", "deadline": time.time() + 60, "started": time.time()}


def snapshot_then_quit():
    def saved(source, result):
        surface = source.get_snapshot_finish(result)
        surface.write_to_png(os.path.join(out_dir, "webkit-office.png"))
        loop.quit()

    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, saved)


def post_to_frame(message):
    evaluate(
        "const frame = document.querySelector('iframe.office-frame'); frame && frame.contentWindow.postMessage(%s, '*'); return { sent: Boolean(frame) };" % json.dumps(message),
        lambda v: None,
    )


def tick():
    if time.time() > state["deadline"]:
        check(f"시간 안에 끝남 ({state['phase']})", False, json.dumps(state.get("last"), ensure_ascii=False)[:600])
        snapshot_then_quit()
        return False

    def on_state(value):
        if not value or state["phase"] == "done":
            return
        state["last"] = value
        status = value.get("status") or ""
        frame = value.get("frame") or {}
        text = frame.get("text") or ""
        if state["phase"] == "app" and value.get("docs"):
            evaluate(
                """document.querySelector('.docs-button').click();
                   setTimeout(() => {
                     const item = [...document.querySelectorAll('.docs-menu *')].find((el) => el.children.length === 0 && el.textContent.trim() === '계획.docx');
                     item && item.click();
                   }, 300);
                   return { clicked: true };""",
                lambda v: None,
            )
            state["phase"] = "open"
            state["deadline"] = time.time() + 90
        elif state["phase"] == "open" and "질문에서 시작하는 글쓰기" in text and "r1 저장됨" in status:
            check("WebKitGTK에서 워드 편집기 열림(다른 출처)", True, f"{time.time() - state['started']:.1f}s")
            state["support"] = frame.get("support")
            state["phase"] = "type"
            state["deadline"] = time.time() + 30
            post_to_frame({"__test": "type", "text": TYPED})
        elif state["phase"] == "type" and TYPED.strip() in text and "저장 안 됨" in status:
            check("입력하면 '저장 안 됨' 표시", True)
            state["phase"] = "save"
            state["deadline"] = time.time() + 30
            post_to_frame({"__test": "save"})
        elif state["phase"] == "save" and "r2 저장됨" in status:
            saved = docx_text(request("GET", f"/api/artifacts/{artifact['id']}/raw?revision=2", raw=True))
            check("Ctrl+S → r2, 파일에 반영", TYPED.strip() in saved, saved.split("\n")[0])
            support = state.get("support") or {}
            print("INFO CSS 지원: " + json.dumps(support), flush=True)
            state["phase"] = "done"
            GLib.timeout_add(800, lambda: snapshot_then_quit() and False)

    evaluate(
        """return { docs: Boolean(document.querySelector('.docs-button')),
                    status: (document.querySelector('.save-state') || {}).textContent || null,
                    frame: window.__frame };""",
        on_state,
    )
    return state["phase"] != "done"


GLib.timeout_add(700, tick)
GLib.timeout_add(240_000, lambda: (check("전체 시간 초과", False), loop.quit()))
try:
    loop.run()
finally:
    host.terminate()
with open(os.path.join(out_dir, "webkit-office-results.json"), "w") as handle:
    json.dump({"results": results, "support": state.get("support")}, handle, ensure_ascii=False, indent=2)
failed = [r for r in results if not r["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
