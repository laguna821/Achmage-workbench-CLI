#!/usr/bin/env python3
"""A document tab shows its first page while the editor boots (doc-pages-first) — checked in WebKitGTK.

Real built UI + built gateway (apps/web/dist, apps/host/dist/host.mjs) on a temporary data folder with
fixture documents, a private GTK Broadway display (software drawing), window 1440x900 (or WxH).
For each kind (docx pptx hwpx xlsx pdf): the gateway makes the pictures first (as after a save), the
document is opened by a click on its row in the app's own sidebar, and the rig times
  firstMs   click -> something of the document on screen (the placeholder's picture painted, or the
            editor's own surface when there is no placeholder)
  surfaceMs click -> the editor's own surface (same signals as ux/perf/webkit/wk-measure.py)
  swapMs    click -> the placeholder gone
and compares the placeholder page's box with the editor's page box (found in the editor's frame, and
from the after-frame's pixels) -> jump in px. Frames: <out>/<kind>-cover.png, <kind>-editor.png.
Then (docx) an edit + save -> r2, the tab closed and opened again -> the placeholder is r2's.
Usage (cwd = the worktree, through ux/run-isolated.sh):
  python3 scripts/webkit-pages-first-check.py <out-dir> [cover|none|pages|default] [kinds...] [--size WxH] [--theme dark]
  cover, none: the window chooses 편집기로 바로 열기 first (scripts/fixtures/editor-first.js): since doc-default
          the app's default is 쪽 보기 first, and these modes time the editor.
  none = the same run with the placeholder off (window.__workbenchNoCover): the "before" times.
  pages = 설정 › 문서 도구 › 문서를 열 때 = 쪽 보기로 먼저 열기: time to the first page picture, the web
          process's memory with the tab in 쪽 보기 vs after a double click started the editor; frames
          <kind>-pages.png, <kind>-pages-edit.png, settings-docopen.png.
  default = a fresh profile with NO choice stored (doc-default): as pages, but the editor is started by
          typing a character in the page (keydown on the focused page), and the rig records whether that
          character reached the document; Excel must open in its editor.
Exit 1 when a kind with a placeholder showed none, showed a wrong revision, or jumped more than TOLERANCE px.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request

argv = sys.argv[1:]
OUT = os.path.abspath(argv.pop(0)); os.makedirs(OUT, exist_ok=True)
MODE = argv.pop(0) if argv and argv[0] in ("cover", "none", "pages", "default") else "cover"
READING = MODE in ("pages", "default")
EDITOR_FIRST = open(os.path.join(os.getcwd(), "scripts/fixtures/editor-first.js"), encoding="utf-8").read()
SIZE = (1440, 900); THEME = "light"
if "--size" in argv: i = argv.index("--size"); SIZE = tuple(int(v) for v in argv[i + 1].split("x")); del argv[i:i + 2]
if "--theme" in argv: i = argv.index("--theme"); THEME = argv[i + 1]; del argv[i:i + 2]
KINDS = argv or ["docx", "pptx", "hwpx", "xlsx", "pdf"]
TOLERANCE = 6  # px: the largest jump of the page's box at the swap we accept
REPO = os.getcwd()
FIX = os.path.join(REPO, "scripts/fixtures")
SRC = {"docx": os.path.join(FIX, "hello.docx"), "pptx": os.path.join(FIX, "cover.pptx"), "xlsx": os.path.join(FIX, "supplies.xlsx"),
       "pdf": os.path.join(FIX, "opendataloader/text.pdf"), "hwpx": os.path.join(REPO, "apps/host/src/channels/fixtures/강의계획서.hwpx")}
COVERED = {"docx", "pptx", "hwpx"}
res = {"mode": MODE, "size": SIZE, "theme": THEME, "engine": "WebKitGTK (webkit2gtk-4.1) on GTK Broadway, software drawing", "kinds": {}, "notes": []}
def save():
    with open(os.path.join(OUT, f"result-{MODE}-{SIZE[0]}x{SIZE[1]}-{THEME}.json"), "w") as h: json.dump(res, h, ensure_ascii=False, indent=1)

def free_port():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
display = f":{free_port() % 1000 + 100}"
broadway = subprocess.Popen(["broadwayd", "--address", "127.0.0.1", "--port", str(free_port()), display], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
for k in ("WAYLAND_DISPLAY", "DISPLAY"): os.environ.pop(k, None)
os.environ.update({"GDK_BACKEND": "broadway", "BROADWAY_DISPLAY": display, "WEBKIT_DISABLE_COMPOSITING_MODE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1"})
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("Gdk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402
from PIL import Image  # noqa: E402

base = tempfile.mkdtemp(prefix="wk-pagesfirst-")
data = os.path.join(base, "data")
env = {**os.environ, "WORKBENCH_DATA_DIR": data, "WORKBENCH_HOST_ID": "fixture", "WORKBENCH_IEUM_BOOTSTRAP": "0", "WORKBENCH_WEB_DIR": os.path.join(REPO, "apps/web/dist"),
       "WORKBENCH_CODEX_BIN": os.path.join(FIX, "fake-codex.mjs"), "WORKBENCH_CLAUDE_BIN": os.path.join(FIX, "fake-claude.mjs"), "WORKBENCH_VAULT_SUGGEST": ""}
# Word/PowerPoint pictures are drawn by IeumOffice's CLI through the desktop app's own renderer: a built
# Workbench binary (RIG_APP_BIN, used read-only) and the vendored CLI. Without them only Hangul has pictures.
if os.environ.get("RIG_APP_BIN"):
    env.update({"WORKBENCH_APP_BIN": os.environ["RIG_APP_BIN"], "WORKBENCH_IEUM_CLI": os.path.join(REPO, "vendor/ieumoffice/packages/cli/dist/genoffice.cjs")})
    res["notes"].append("office pictures via RIG_APP_BIN + vendor/ieumoffice CLI")
host = None; G = {}
def start_gw():
    global host
    host = subprocess.Popen(["node", os.path.join(REPO, "apps/host/dist/host.mjs")], cwd=REPO, env=env, stdout=subprocess.PIPE, text=True)
    for line in host.stdout:
        if line.startswith("WORKBENCH_READY "): G.update(json.loads(line[16:])); return
    raise SystemExit("gateway did not start")
def api(method, path, body=None):
    r = urllib.request.Request(G["url"] + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"authorization": f"Bearer {G['token']}", "content-type": "application/json"})
    with urllib.request.urlopen(r) as h: return json.loads(h.read())

WINDOW = """(() => { if (window.top !== window) return; window.__frames = {}; %s
  window.__said = [];
  window.addEventListener('message', (e) => { const d = e.data; if (d && d.__perf === 'state') window.__frames[d.href] = { ...d, seen: performance.now() };
    if (d && typeof d.type === 'string' && d.type.startsWith('office:') && window.__said.length < 400) window.__said.push({ type: d.type, t: Math.round(performance.now()), ready: d.ready }); }); })();""" % ("window.__workbenchNoCover = true;" + EDITOR_FIRST if MODE == "none" else "localStorage.setItem('workbench.docOpen', 'pages');" if MODE == "pages" else "" if MODE == "default" else EDITOR_FIRST)
# Every editor frame reports its state and its page's box (in its own viewport) every 100 ms.
FRAME = """(() => { if (window.top === window) return;
  const depth = (() => { let d = 0, w = window; try { while (w !== window.top) { w = w.parent; d++; } } catch (e) {} return d; })();
  const stage = () => { const s = (window.Konva && window.Konva.stages) || []; return s.length ? s.reduce((a, b) => (b.width() > a.width() ? b : a)) : null; };
  const box = (r, how) => r ? { x: Math.round(r.left ?? r.x), y: Math.round(r.top ?? r.y), w: Math.round(r.width), h: Math.round(r.height), how } : null;
  const white = (el) => /rgb\\(255, 255, 255\\)/.test(getComputedStyle(el).backgroundColor);
  const page = () => {
    const pm = document.querySelector('.ProseMirror');
    if (pm) { let el = pm, best = null; while (el && el !== document.body) { const r = el.getBoundingClientRect(); if (white(el) && r.width < innerWidth * 0.95 && r.width > 200) best = el; el = el.parentElement; } return box((best || pm).getBoundingClientRect(), best ? 'white page' : 'prosemirror'); }
    const st = stage();
    if (st) { const c = st.container().getBoundingClientRect(), k = c.width / st.width(); const rects = st.find('Rect').map((n) => n.getClientRect()).filter((r) => r.width > 100).sort((a, b) => b.width * b.height - a.width * a.height);
      const r = rects[0]; return r ? box({ left: c.left + r.x * k, top: c.top + r.y * k, width: r.width * k, height: r.height * k }, 'konva rect') : box(c, 'konva stage'); }
    const cs = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 100).sort((a, b) => b.width * b.height - a.width * a.height);
    return cs[0] ? box(cs[0], 'canvas') : null; };
  setInterval(() => { const pm = document.querySelector('.ProseMirror'); const st = stage(); const body = document.body ? document.body.innerText || '' : '';
    const text = pm ? pm.textContent : st ? st.find('Text').map((n) => n.text()).join('') : body.slice(0, 2000);
    window.top.postMessage({ __perf: 'state', href: location.href, title: document.title, depth, pm: Boolean(pm), konva: Boolean(st), booting: Boolean(document.querySelector('.start-booting')), canvas: document.querySelectorAll('canvas').length,
      sheetInput: Boolean(document.getElementById('__editor___INTERNAL_EDITOR__DOCS_NORMAL')), text: (text || '').slice(0, 300), page: page(),
      ground: document.body ? getComputedStyle(document.body).backgroundColor : null,
      kids: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.getAttribute('src'), rect: box(f.getBoundingClientRect(), 'iframe') })) }, '*'); }, 100);
  const typeInto = (el, text) => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, text); };
  window.addEventListener('message', (e) => { const d = e.data; if (!d || d.__perf !== 'type' || d.href !== location.href) return; const pm = document.querySelector('.ProseMirror'); if (pm) { typeInto(pm.querySelector('p, h1, li') || pm, d.text); setTimeout(() => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })), 400); } });
})();"""

Gdk.Screen.get_default().set_resolution(96.0)
window = Gtk.OffscreenWindow(); window.set_default_size(*SIZE)
ucm = WebKit2.UserContentManager()
ucm.add_script(WebKit2.UserScript(WINDOW, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.add_script(WebKit2.UserScript(FRAME, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.END, None, None))
view = WebKit2.WebView.new_with_user_content_manager(ucm)
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
window.add(view); window.show_all(); view.grab_focus()
fe = Gdk.Event.new(Gdk.EventType.FOCUS_CHANGE); fe.focus_change.window = window.get_window(); fe.focus_change.send_event = 1; fe.focus_change.in_ = 1; window.event(fe)
ctx = GLib.MainContext.default()
def pump(sec):
    end = time.time() + sec
    while time.time() < end: ctx.iteration(False); time.sleep(0.003)
def js(script, timeout=20):
    box = {}
    def fin(src, r):
        try:
            v = src.evaluate_javascript_finish(r); box["v"] = json.loads(v.to_string()) if v and not v.is_undefined() else None
        except Exception as e: box["v"] = {"error": str(e)}
    view.evaluate_javascript(f"JSON.stringify((() => {{ {script} }})())", -1, None, None, None, fin)
    end = time.time() + timeout
    while "v" not in box and time.time() < end: ctx.iteration(False); time.sleep(0.001)
    return box.get("v")
def until(fn, timeout, step=0.02):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v: return v
        pump(step)
    return None
def snapshot(path):
    box = {}
    def done(src, r):
        try: src.get_snapshot_finish(r).write_to_png(path); box["ok"] = True
        except Exception as e: box["ok"] = str(e)
    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)
    end = time.time() + 10
    while "ok" not in box and time.time() < end: ctx.iteration(False); time.sleep(0.002)
    return box.get("ok") is True
def frames_now(): return js("return Object.values(window.__frames).filter((f) => performance.now() - f.seen < 800)") or []
LEAF = "[...document.querySelectorAll('aside *')].filter((el) => el.children.length === 0 && el.textContent.trim() === %s && el.offsetParent !== null)"
def open_doc(name):
    if not until(lambda: js("return " + LEAF % json.dumps(name) + ".length > 0"), 10): res["notes"].append(f"row {name} not found"); return None
    js("window.__frames = {}; window.__said = []; window.__t0 = performance.now(); return 1")
    t = time.time()
    js("const el = " + LEAF % json.dumps(name) + "[0]; (el.closest('button, a, [role=treeitem], [role=button], [role=option]') || el).click(); return true")
    return t
SURFACE = {"docx": lambda f: f["pm"], "pptx": lambda f: f["konva"] and len(f["text"]) > 0, "xlsx": lambda f: f["sheetInput"] and f["canvas"] > 0,
           "pdf": lambda f: f["canvas"] > 0 and "pdf" in f["href"], "hwpx": lambda f: f["canvas"] > 0 and "studio" in f["href"]}
COVER_JS = "const p = document.querySelector('section.pane:not([hidden]) .doc-cover'); if (!p) return null; const i = p.querySelector('img.doc-cover-page'); const r = i && i.getBoundingClientRect(); return { painted: Boolean(i && i.complete && i.naturalWidth > 0), revision: Number(p.getAttribute('data-cover-revision')), box: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null, mark: (p.querySelector('.doc-cover-mark') || {}).textContent || null }"

def editor_page_abs(kind):
    """The editor's page box in window coordinates: the frame's iframe rect (+ the nested studio frame for Hangul) + the box it reports."""
    fr = frames_now()
    iframe = js("const f = [...document.querySelectorAll('section.pane:not([hidden]) iframe.office-frame')][0]; if (!f) return null; const r = f.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), src: f.src }")
    if not iframe: return None
    top = next((f for f in fr if f["depth"] == 1 and f["href"].split("?")[0] in iframe["src"]), None)
    if not top: return None
    ox, oy, inner = iframe["x"], iframe["y"], top
    if kind == "hwpx":
        studio = next((f for f in fr if f["depth"] == 2 and "studio" in f["href"]), None)
        kid = next((k for k in top["kids"] if k["src"] and "studio" in k["src"]), None)
        if not studio or not kid: return None
        ox += kid["rect"]["x"]; oy += kid["rect"]["y"]; inner = studio
    p = inner.get("page")
    return {"x": ox + p["x"], "y": oy + p["y"], "w": p["w"], "h": p["h"], "how": p["how"], "ground": inner.get("ground"), "frame": iframe} if p else None

def web_rss_mb():
    """RSS of this window's WebKit web process(es) (MB): every frame of the window lives there."""
    total = 0
    for e in os.listdir("/proc"):
        if not e.isdigit(): continue
        try:
            if not open(f"/proc/{e}/comm").read().startswith("WebKitWebProces"): continue
            pid, hops = int(e), 0
            while pid > 1 and hops < 20:
                pid = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1]); hops += 1
                if pid == os.getpid(): break
            if pid != os.getpid(): continue
            total += next(int(l.split()[1]) for l in open(f"/proc/{e}/smaps_rollup") if l.startswith("Rss:"))
        except (OSError, StopIteration, ValueError): pass
    return total // 1024
PAGES_JS = "const p = document.querySelector('section.pane:not([hidden]) .doc-reading'); if (!p) return null; const i = p.querySelector('.office-page img, .hwpx-stage img, .hwpx-stage svg, .hwpx-page, .pdf-stage canvas'); return { shown: Boolean(i && (i.tagName !== 'IMG' || (i.complete && i.naturalWidth > 0))), line: (p.querySelector('.doc-reading-line') || {}).textContent || null }"

def pixel_page(path, region):
    """The page's box from a frame's pixels: the largest block of white columns/rows inside `region` (x, y, w, h)."""
    im = Image.open(path).convert("RGB"); W, H = im.size; x0, y0, w, h = region
    px = im.load(); white = lambda c: c[0] > 250 and c[1] > 250 and c[2] > 250
    cols = [sum(1 for y in range(y0, min(H, y0 + h), 4) if white(px[x, y])) for x in range(x0, min(W, x0 + w))]
    need = max(cols) * 0.6 if cols and max(cols) else 1
    xs = [x0 + i for i, c in enumerate(cols) if c >= need]
    if not xs: return None
    left, right = xs[0], xs[-1]
    rows = [sum(1 for x in range(left, right, 4) if white(px[x, y])) for y in range(y0, min(H, y0 + h))]
    full = (right - left) / 4 * 0.9
    # The largest BLOCK: rows split where the white falls well below the block's width (a grey gap). Before
    # office-leftovers this took the first to the last white row of the region, so at 1000x800 the white bottom
    # rows of PowerPoint's two-line ribbon and its AI chips above the slide counted as the slide ("55 px off").
    gap = (right - left) / 4 * 0.4
    blocks, cur = [], []
    for i, c in enumerate(rows):
        if c < gap:
            if cur: blocks.append(cur); cur = []
        else: cur.append(i)
    if cur: blocks.append(cur)
    best = max(blocks, key=len) if blocks else []
    ys = [y0 + i for i in best if rows[i] >= full]
    return {"x": left, "y": ys[0], "w": right - left + 1, "h": ys[-1] - ys[0] + 1} if ys else None

try:
    start_gw()
    api("PUT", "/api/prefs", {"prefs": {"onboarding": "done", "startScreen": "last", "layoutScope": "global", "sidebar": True, "theme": THEME}})
    c1 = os.path.join(base, "p1"); os.makedirs(c1)
    names = {k: f"첫쪽.{k}" for k in KINDS}
    for k in KINDS: shutil.copyfile(SRC[k], os.path.join(c1, names[k]))
    p1 = api("POST", "/api/works", {"title": "프로젝트 하나", "cwd": c1})
    art = {k: api("POST", f"/api/works/{p1['id']}/artifacts", {"path": names[k]})["id"] for k in KINDS}
    sE = api("POST", f"/api/works/{p1['id']}/sessions", {"provider": "claude"})["id"]
    api("PUT", "/api/layouts/global", {"expectedRevision": 0, "layout": {"version": 2, "focus": "a", "panes": [{"id": "a", "view": {"kind": "work"}, "workId": p1["id"], "sessionId": sE, "tabs": [{"id": "tE", "view": {"kind": "work"}, "workId": p1["id"], "sessionId": sE}], "activeTabId": "tE", "recentTabIds": ["tE"]}]}})
    # The pictures, made in the background after the documents' first revision (as after a save).
    made = {}
    for k in KINDS:
        t = time.time(); ready = None
        while time.time() - t < 90:
            ready = api("GET", f"/api/artifacts/{art[k]}/cover?revision=1")["cover"]
            if ready or k not in COVERED and k != "xlsx": break
            time.sleep(0.5)
        made[k] = {"ready": bool(ready), "waitedMs": round((time.time() - t) * 1000), "cover": ready}
    res["pictures"] = made
    du = lambda p: sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)
    res["cacheBytes"] = {k: sum(du(os.path.join(data, "artifacts", art[k], n)) if os.path.isdir(os.path.join(data, "artifacts", art[k], n)) else os.path.getsize(os.path.join(data, "artifacts", art[k], n))
                            for n in os.listdir(os.path.join(data, "artifacts", art[k])) if n.startswith("r1.pages") or n.startswith("r1.cover")) for k in KINDS}
    save(); print("pictures", made, res["cacheBytes"], flush=True)
    view.load_uri(f"{G['url']}/?token={G['token']}")
    until(lambda: js("return document.querySelectorAll('aside').length > 0"), 40)
    pump(3)
    if not js("return " + LEAF % json.dumps(names[KINDS[0]]) + ".length > 0"):
        js("const el = " + LEAF % json.dumps("프로젝트 하나") + "[0]; el && (el.closest('button, a, [role=treeitem], [role=button]') || el).click(); return 1"); pump(1.5)
    failures = []
    for k in KINDS:
        # Each kind's picture as the gateway keeps it (frames for the report).
        try:
            if made.get(k, {}).get("ready"):
                r = urllib.request.Request(G["url"] + f"/api/artifacts/{art[k]}/cover-image?revision=1", headers={"authorization": f"Bearer {G['token']}"})
                with urllib.request.urlopen(r) as h:
                    body = h.read(); ext = "svg" if h.headers.get("content-type", "").startswith("image/svg") else "png"
                with open(os.path.join(OUT, f"{k}-picture.{ext}"), "wb") as w: w.write(body)
        except Exception as e: res["notes"].append(f"{k} picture: {e}")
    if READING:
        pump(2); base_rss = web_rss_mb(); res["baseRssMb"] = base_rss
        for k in KINDS:
            row = {}
            t = open_doc(names[k])
            if t is None: failures.append(f"{k}: no row"); continue
            if k == "xlsx":
                # Excel has no page view: its editor at once, never 쪽 보기.
                row["editorMs"] = round((time.time() - t) * 1000) if until(lambda: any(SURFACE[k](f) for f in frames_now()), 60) else None
                row["reading"] = js("return Boolean(document.querySelector('section.pane:not([hidden]) .doc-reading'))")
                pump(2); snapshot(os.path.join(OUT, f"{k}-{MODE}.png"))
                res["kinds"][k] = row; save(); print(k, json.dumps(row, ensure_ascii=False), flush=True)
                if row["reading"] or not row["editorMs"]: failures.append(f"{k}: not opened in its editor")
                js("const w = [...document.querySelectorAll('[data-tab-id]')].filter((x) => x.getAttribute('data-tab-id') !== 'tE').pop(); const b = w && [...w.querySelectorAll('button')].find((x) => x.getAttribute('role') !== 'tab'); b && b.click(); return Boolean(b)")
                pump(4); continue
            got = until(lambda: (lambda c: c if c and c["shown"] else None)(js(PAGES_JS)), 30, 0.01)
            row["pagesMs"] = round((time.time() - t) * 1000) if got else None
            row["line"] = got and got["line"]
            row["editorMounted"] = js("return document.querySelectorAll('section.pane:not([hidden]) iframe.office-frame').length > 0")
            pump(3); snapshot(os.path.join(OUT, f"{k}-pages.png")); row["rssPagesMb"] = web_rss_mb() - base_rss
            # A double click in the page starts the editor (default: typing a character in the focused page).
            t = time.time()
            if MODE == "default":
                js("const p = document.querySelector('section.pane:not([hidden]) .doc-reading'); p.focus(); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Ж', bubbles: true, cancelable: true })); return 1")
            else: js("const p = document.querySelector('section.pane:not([hidden]) .doc-reading .office-page, section.pane:not([hidden]) .doc-reading .hwpx-stage > *, section.pane:not([hidden]) .doc-reading .pdf-stage > *, section.pane:not([hidden]) .doc-reading'); p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1")
            row["editorAfterDblclickMs"] = None
            if until(lambda: any(SURFACE[k](f) for f in frames_now()), 60):
                row["editorAfterDblclickMs"] = round((time.time() - t) * 1000)
            pump(3); snapshot(os.path.join(OUT, f"{k}-pages-edit.png")); row["rssEditorMb"] = web_rss_mb() - base_rss
            if MODE == "default": row["typedArrived"] = any("Ж" in (f.get("text") or "") for f in frames_now())
            res["kinds"][k] = row; save(); print(k, json.dumps(row, ensure_ascii=False), flush=True)
            if not row["pagesMs"]: failures.append(f"{k}: no page picture in 쪽 보기")
            if not row["editorAfterDblclickMs"]: failures.append(f"{k}: the editor did not start on the wish to edit")
            if row["editorMounted"]: failures.append(f"{k}: the editor started in 쪽 보기")
            js("const w = [...document.querySelectorAll('[data-tab-id]')].filter((x) => x.getAttribute('data-tab-id') !== 'tE').pop(); const b = w && [...w.querySelectorAll('button')].find((x) => x.getAttribute('role') !== 'tab'); b && b.click(); return Boolean(b)")
            pump(4)
        # The settings row.
        js("const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '설정' || x.getAttribute('aria-label') === '설정'); b && b.click(); return Boolean(b)"); pump(1.5)
        js("const b = [...document.querySelectorAll('button, [role=tab], a')].find((x) => (x.textContent || '').trim() === '문서 도구'); b && b.click(); return Boolean(b)"); pump(1.5)
        js("const r = [...document.querySelectorAll('[role=radiogroup]')].find((g) => g.getAttribute('aria-label') === '문서를 열 때'); r && r.scrollIntoView({ block: 'center' }); return Boolean(r)"); pump(0.5)
        res["settingsRow"] = js("const r = [...document.querySelectorAll('[role=radiogroup]')].find((g) => g.getAttribute('aria-label') === '문서를 열 때'); return r ? [...r.querySelectorAll('[role=radio]')].map((b) => b.textContent + (b.getAttribute('aria-checked') === 'true' ? ' ✓' : '')) : null")
        snapshot(os.path.join(OUT, "settings-docopen.png"))
        res["failures"] = failures; save(); print("settings", res["settingsRow"], "failures", failures, flush=True)
        KINDS_LOOP = []
    else:
        KINDS_LOOP = KINDS
    for k in KINDS_LOOP:
        row = {"firstMs": None, "surfaceMs": None, "swapMs": None, "coverRevision": None}
        t = open_doc(names[k])
        if t is None: failures.append(f"{k}: no row"); continue
        cover_seen = None; shot = False
        end = t + 60
        while time.time() < end:
            c = js(COVER_JS)
            now = round((time.time() - t) * 1000)
            if c and c["painted"] and cover_seen is None:
                cover_seen = c; row["firstMs"] = now; row["coverRevision"] = c["revision"]; row["coverBox"] = c["box"]
                pump(0.05); shot = snapshot(os.path.join(OUT, f"{k}-cover.png"))
            if c and c.get("mark"): row.setdefault("markMs", now)
            if c and c["painted"]:
                row["coverBox"] = c["box"]
                # The placeholder as it stands last before the swap (the frame compared with the editor's).
                if now - row.get("lastShotMs", -1000) > 250: snapshot(os.path.join(OUT, f"{k}-cover-last.png")); row["lastShotMs"] = now
            if row["surfaceMs"] is None and any(SURFACE[k](f) for f in frames_now()):
                row["surfaceMs"] = now
                # What the editor shows when its surface is first there (is the page drawn yet?).
                if MODE == "none": snapshot(os.path.join(OUT, f"{k}-surface.png"))
                if row["firstMs"] is None: row["firstMs"] = now
            if cover_seen and not c and row["swapMs"] is None:
                row["swapMs"] = now
                row["swapDom"] = editor_page_abs(k)
                # The editor as it stands right at the swap: the jump is measured on this frame.
                snapshot(os.path.join(OUT, f"{k}-swap.png")); row["swapFrame"] = js("const f = [...document.querySelectorAll('section.pane:not([hidden]) iframe.office-frame')][0]; if (!f) return null; const r = f.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }")
            if row["surfaceMs"] is not None and (cover_seen is None or row["swapMs"] is not None): break
            pump(0.015)
        # After the picture left: the editor must not show its own "여는 중…" (office-leftovers point 1).
        if cover_seen and row["swapMs"] is not None:
            after_end = time.time() + 1.5
            while time.time() < after_end:
                if any(f.get("booting") for f in frames_now()):
                    row["bootingAfterSwapMs"] = round((time.time() - t) * 1000); snapshot(os.path.join(OUT, f"{k}-booting-after-swap.png")); break
                pump(0.03)
        if MODE == "none":
            for i in range(6):
                snapshot(os.path.join(OUT, f"{k}-t{i}.png")); row.setdefault("filmMs", []).append(round((time.time() - t) * 1000)); pump(0.35)
        pump(2.0)
        snapshot(os.path.join(OUT, f"{k}-editor.png"))
        page = editor_page_abs(k)
        row["editorPage"] = page
        row["said"] = js("return window.__said.map((m) => ({ ...m, t: m.t - Math.round(window.__t0) }))")
        if cover_seen and row.get("coverBox"):
            b = row["coverBox"]
            frame = page["frame"] if page else None
            # Below the editor's toolbar band, right of its rail, above its status bar (and PowerPoint's notes).
            band, rail, bottom = {"docx": (130, 34, 44), "pptx": (130, 154, 144), "hwpx": (155, 20, 44)}[k]
            region = (frame["x"] + rail, frame["y"] + band, frame["w"] - rail - 12, frame["h"] - band - bottom) if frame else (0, 0, SIZE[0], SIZE[1])
            if row.get("swapFrame"):
                f2 = row["swapFrame"]; region = (f2["x"] + rail, f2["y"] + band, f2["w"] - rail - 12, f2["h"] - band - bottom)
                row["swapPagePixels"] = pixel_page(os.path.join(OUT, f"{k}-swap.png"), region)
            pix = pixel_page(os.path.join(OUT, f"{k}-editor.png"), region if not row.get("swapFrame") else (frame["x"] + rail, frame["y"] + band, frame["w"] - rail - 12, frame["h"] - band - bottom) if frame else region)
            row["editorPagePixels"] = pix
            # PowerPoint's Konva rects include more than the slide: its pixels are the slide.
            ref = pix if k == "pptx" and pix else page if page and page["w"] > 100 else pix
            if ref: row["jumpLater"] = {"dx": ref["x"] - b["x"], "dy": ref["y"] - b["y"], "dw": ref["w"] - b["w"], "dh": ref["h"] - b["h"]}
            sp = row.get("swapPagePixels")
            # At the swap: the page's box in the picture vs in the editor's first frame (pixels; Word and Hangul pages run under the status bar, so their height is not compared).
            sd = row.get("swapDom")
            # Hangul's page is white on a white ground: its pixels cannot show the page; its canvas box can.
            if k == "hwpx" and sd: row["jump"] = {"dx": sd["x"] - b["x"], "dy": sd["y"] - b["y"], "dw": sd["w"] - b["w"]}
            elif sp: row["jump"] = {"dx": sp["x"] - b["x"], "dy": sp["y"] - b["y"], "dw": sp["w"] - b["w"], **({"dh": sp["h"] - b["h"]} if k == "pptx" else {})}
        if os.path.exists(os.path.join(OUT, f"{k}-cover-last.png")) and os.path.exists(os.path.join(OUT, f"{k}-swap.png")):
            a = Image.open(os.path.join(OUT, f"{k}-cover-last.png")).convert("RGB"); b = Image.open(os.path.join(OUT, f"{k}-swap.png")).convert("RGB")
            sheet = Image.new("RGB", (a.size[0] * 2 + 8, a.size[1]), (220, 0, 0)); sheet.paste(a, (0, 0)); sheet.paste(b, (a.size[0] + 8, 0))
            sheet.save(os.path.join(OUT, f"compare-{k}.png"))
        res["kinds"][k] = row; save(); print(k, json.dumps(row, ensure_ascii=False), flush=True)
        if k in COVERED and MODE == "cover":
            if not cover_seen: failures.append(f"{k}: no placeholder")
            if row.get("bootingAfterSwapMs") is not None: failures.append(f"{k}: the editor showed its own 여는 중 after the picture left")
            elif cover_seen["revision"] != 1: failures.append(f"{k}: placeholder of r{cover_seen['revision']}")
        # Close the tab (its editor saved nothing).
        js("const w = [...document.querySelectorAll('[data-tab-id]')].find((x) => x.getAttribute('data-tab-id') !== 'tE' && x.querySelector('[role=tab]') && x.getAttribute('data-active') !== null) || [...document.querySelectorAll('[data-tab-id]')].filter((x) => x.getAttribute('data-tab-id') !== 'tE').pop(); const b = w && [...w.querySelectorAll('button')].find((x) => x.getAttribute('role') !== 'tab'); b && b.click(); return Boolean(b)")
        pump(1.0)
    # Edit + save a Word document, close, open again: the placeholder is the NEW revision's.
    if "docx" in KINDS_LOOP and MODE == "cover":
        t = open_doc(names["docx"])
        until(lambda: next((f for f in frames_now() if SURFACE["docx"](f)), None), 60)
        href = next(f["href"] for f in frames_now() if SURFACE["docx"](f))
        js(f"for (const f of document.querySelectorAll('iframe')) f.contentWindow.postMessage({{ __perf: 'type', href: {json.dumps(href)}, text: '새판' }}, '*'); return 1")
        pump(1.0)
        rev = until(lambda: (lambda revs: {"revision": max(r["revision"] for r in revs)} if revs and max(r["revision"] for r in revs) >= 2 else None)(api("GET", f"/api/artifacts/{art['docx']}/revisions")), 40, 0.5)
        if not rev:
            js("document.querySelector('iframe.office-frame').contentWindow.focus(); return 1")
            res["notes"].append("autosave did not come within 40 s")
        revision = (rev or {}).get("revision", 1)
        # The background job's quiet moment + render.
        made2 = until(lambda: api("GET", f"/api/artifacts/{art['docx']}/cover?revision={revision}")["cover"], 60, 0.5)
        js("const w = [...document.querySelectorAll('[data-tab-id]')].filter((x) => x.getAttribute('data-tab-id') !== 'tE').pop(); const b = w && [...w.querySelectorAll('button')].find((x) => x.getAttribute('role') !== 'tab'); b && b.click(); return Boolean(b)")
        pump(1.5)
        t = open_doc(names["docx"]); seen = until(lambda: (lambda c: c if c and c["painted"] else None)(js(COVER_JS)), 10, 0.01)
        if seen: snapshot(os.path.join(OUT, "docx-after-save-cover.png"))
        res["afterSave"] = {"savedRevision": revision, "pictureMade": bool(made2), "placeholderRevision": seen and seen["revision"]}
        print("after save", res["afterSave"], flush=True)
        if revision < 2: failures.append("docx: the edit was not saved in the rig (no new revision)")
        elif seen and seen["revision"] != revision: failures.append(f"docx: after the save the placeholder was r{seen['revision']}, not r{revision}")
        pump(3)
    for k, row in (res["kinds"].items() if not READING else []):
        j = row.get("jump")
        if MODE == "cover" and k in COVERED and j and max(abs(v) for v in j.values()) > TOLERANCE: failures.append(f"{k}: jump {j} > {TOLERANCE} px")
    res["failures"] = failures; save()
    print("failures", failures, flush=True)
except Exception:
    import traceback; res["failure"] = traceback.format_exc(); print(res["failure"], flush=True); save()
finally:
    if host and host.poll() is None: host.terminate(); host.wait(timeout=30)
    broadway.terminate(); broadway.wait(timeout=10)
    shutil.rmtree(base, ignore_errors=True)
sys.exit(1 if res.get("failure") or res.get("failures") else 0)
