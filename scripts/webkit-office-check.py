#!/usr/bin/env python3
"""Check the in-app Word or PowerPoint editor in WebKitGTK (the engine the Linux app runs on), off screen.

Starts a gateway on a temporary data folder with a small .docx or .pptx, loads the real Workbench
UI, opens the document (the editor page comes from the editors' own origin), edits it (Word: types
into the text; PowerPoint: double-clicks the title on the slide canvas and types), saves with
Ctrl+S and reads revision 2 back from the gateway. The editor page is on another origin, so a
helper script injected into every frame reports its state to the window and performs the input.
Also reports which newer CSS features the editors rely on are available. Writes a snapshot PNG.
Usage: python3 scripts/webkit-office-check.py [docs|slides] [out-dir]
"""
import io
import json
import shutil
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

args = [a for a in sys.argv[1:]]
kind = args.pop(0) if args and args[0] in ("docs", "slides") else "docs"
out_dir = args[0] if args else os.path.join(tempfile.gettempdir(), f"wb-webkit-{kind}")
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


def pptx_text(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = sorted(n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n))
        return "\n".join("".join(re.findall(r"<a:t>([^<]*)</a:t>", z.read(n).decode("utf-8"))) for n in names)


if kind == "docs":
    DOC_NAME, FIRST_TEXT, TYPED, read_text = "계획.docx", "질문에서 시작하는 글쓰기", " — 웹킷에서 고침", docx_text
    make_docx(os.path.join(cwd, DOC_NAME), ["가을 특강 계획", "질문에서 시작하는 글쓰기", "10월 28일 오후 3시"])
else:
    DOC_NAME, FIRST_TEXT, TYPED, read_text = "표지.pptx", "질문에서", " 웹킷", pptx_text
    shutil.copyfile(os.path.join(repo, "scripts", "fixtures", "cover.pptx"), os.path.join(cwd, DOC_NAME))

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
work = request("POST", "/api/works", {"title": f"WebKit {kind}", "folderId": None, "cwd": cwd})
artifact = request("POST", f"/api/works/{work['id']}/artifacts", {"path": DOC_NAME})

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
  // The slide being edited: the largest Konva stage (the others are thumbnails).
  const mainStage = () => {
    const stages = (window.Konva && window.Konva.stages) || [];
    return stages.length ? stages.reduce((a, b) => (b.width() > a.width() ? b : a)) : null;
  };
  const slideText = () => {
    const stage = mainStage();
    return stage ? stage.find("Text").map((node) => node.text()).join("") : null;
  };
  setInterval(() => {
    const editor = document.querySelector(".ProseMirror");
    window.parent.postMessage({ __test: "state", text: editor ? editor.textContent : slideText(), support, href: location.href, ready: document.readyState,
      body: document.body ? document.body.innerHTML.length : -1, errors: window.__errors || [] }, "*");
  }, 400);
  const typeInto = (element, text) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
  };
  /** Double-click a word on the slide canvas, as a mouse would (Konva's dblclick comes from two mousedown/mouseup pairs). */
  const doubleClickWord = async (word) => {
    const stage = mainStage();
    const node = stage && stage.find("Text").find((candidate) => candidate.text().includes(word));
    if (!node) return false;
    const rect = node.getClientRect();
    const box = stage.container().getBoundingClientRect();
    const scale = box.width / stage.width();
    const x = box.left + (rect.x + rect.width / 2) * scale;
    const y = box.top + (rect.y + rect.height / 2) * scale;
    const target = document.elementFromPoint(x, y);
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    for (let count = 1; count <= 2; count += 1) {
      target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1, detail: count }));
      target.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0, detail: count }));
      target.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: count }));
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    target.dispatchEvent(new MouseEvent("dblclick", { ...base, buttons: 0, detail: 2 }));
    return true;
  };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || !data.__test || event.source !== window.parent) return;
    if (data.__test === "type") {
      const editor = document.querySelector(".ProseMirror");
      if (editor) typeInto(editor.querySelector("p"), data.text);
      else
        void doubleClickWord(data.word).then(async () => {
          for (let tries = 0; tries < 40 && !document.querySelector("[contenteditable]"); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
          const box = document.querySelector("[contenteditable]");
          if (!box) return;
          typeInto(box, data.text);
          box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        });
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


state = {"phase": "app", "deadline": time.time() + 60, "started": time.time()}


def snapshot_then_quit():
    def saved(source, result):
        surface = source.get_snapshot_finish(result)
        surface.write_to_png(os.path.join(out_dir, f"webkit-{kind}.png"))
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
                     const item = [...document.querySelectorAll('.docs-menu *')].find((el) => el.children.length === 0 && el.textContent.trim() === %s);
                     item && item.click();
                   }, 300);
                   return { clicked: true };""" % json.dumps(DOC_NAME),
                lambda v: None,
            )
            state["phase"] = "open"
            state["deadline"] = time.time() + 90
        elif state["phase"] == "open" and FIRST_TEXT in text and "r1 저장됨" in status:
            check(f"WebKitGTK에서 {'워드' if kind == 'docs' else 'PPT'} 편집기 열림(다른 출처)", True, f"{time.time() - state['started']:.1f}s")
            state["support"] = frame.get("support")
            state["phase"] = "type"
            state["deadline"] = time.time() + 30
            post_to_frame({"__test": "type", "text": TYPED, "word": "특강"})
        elif state["phase"] == "type" and TYPED.strip() in text and "저장 안 됨" in status:
            check("입력하면 '저장 안 됨' 표시", True)
            state["phase"] = "save"
            state["deadline"] = time.time() + 30
            post_to_frame({"__test": "save"})
        elif state["phase"] == "save" and "r2 저장됨" in status:
            saved = read_text(request("GET", f"/api/artifacts/{artifact['id']}/raw?revision=2", raw=True))
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
with open(os.path.join(out_dir, f"webkit-{kind}-results.json"), "w") as handle:
    json.dump({"results": results, "support": state.get("support")}, handle, ensure_ascii=False, indent=2)
failed = [r for r in results if not r["ok"]]
print(f"{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
