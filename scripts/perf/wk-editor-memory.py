#!/usr/bin/env python3
"""WebKitGTK editor-memory harness (driven by scripts/editor-memory-check.ts; copy of ux/perf/edmem/wk-edmem.py, itself from ux/perf/webkit/wk-measure.py). WK_CASE=c-ai: a template font set on a Latin and a Korean text by the editor's own tool, saved, reopened. Scene `doc` replaced by: one tab of <kind>, probes in its
frame (fonts, canvases, images, workers), then CYCLES close -> 30 s -> reopen cycles. Env: WK_SIZE=WxH (default 1440x900),
WK_VARIANT=comma list (nofonts: slides privateFontFaces -> []), CYCLES (default 3), WK_TABS (tabs opened before cycles, default 1).
Original doc: Perf measurement in WebKitGTK (READ-ONLY for the product). Real built UI + built gateway (wt/integ), stand-in engines,
fixture data in $TMPDIR, private GTK Broadway display.
Usage (cwd = wt/integ, through ux/run-isolated.sh):
  python3 wk-measure.py conv <out.json> [mode]          conversation scene + 4 editors hidden + sleep
  python3 wk-measure.py doc <kind> <out.json> [mode]    kind: docx pptx xlsx pdf hwpx md
mode: never (harness default: policy NEVER + compositing off + dmabuf off) | default (nothing set, as the Tauri shell) | always
"""
import json, os, shutil, socket, sqlite3, subprocess, sys, tempfile, time, urllib.request, zipfile

import signal
def _wd(*a): raise TimeoutError("watchdog: WK_MAX seconds passed")
signal.signal(signal.SIGALRM, _wd); signal.alarm(int(os.environ.get("WK_MAX", "480")))
argv = sys.argv[1:]
SCENE = argv.pop(0)
KIND = argv.pop(0) if SCENE == "doc" else None
OUT = os.path.abspath(argv.pop(0))
MODE = argv.pop(0) if argv else "never"
REPO = os.getcwd()
FIX = os.path.join(REPO, "scripts/fixtures")
SLEEP_MS = 25_000
res = {"scene": SCENE, "kind": KIND, "mode": MODE, "engine": "WebKitGTK (webkit2gtk-4.1) on GTK Broadway", "steps": [], "timings": {}, "notes": [], "wasm": [], "frames": []}
VARIANT = [v for v in os.environ.get("WK_VARIANT", "").split(",") if v]; res["variant"] = VARIANT
def save():
    with open(OUT, "w") as h: json.dump(res, h, ensure_ascii=False, indent=1)

def free_port():
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); return s.getsockname()[1]
display = f":{free_port() % 1000 + 100}"
broadway = subprocess.Popen(["broadwayd", "--address", "127.0.0.1", "--port", str(free_port()), display], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
for k in ("WAYLAND_DISPLAY", "DISPLAY"): os.environ.pop(k, None)
os.environ.update({"GDK_BACKEND": "broadway", "BROADWAY_DISPLAY": display})
if MODE == "never":
    os.environ.update({"WEBKIT_DISABLE_COMPOSITING_MODE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1"})
else:
    for k in ("WEBKIT_DISABLE_COMPOSITING_MODE", "WEBKIT_DISABLE_DMABUF_RENDERER"): os.environ.pop(k, None)
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("Gdk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402
res["webkitVersion"] = f"{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}"

base = tempfile.mkdtemp(prefix="wk-perf-")
data = os.path.join(base, "data")
env = {**os.environ, "WORKBENCH_DATA_DIR": data, "WORKBENCH_HOST_ID": "fixture", "WORKBENCH_IEUM_BOOTSTRAP": "0", "WORKBENCH_WEB_DIR": os.environ.get("WK_WEB_DIR") or os.path.join(REPO, "apps/web/dist"),
       "WORKBENCH_CODEX_BIN": os.path.join(FIX, "fake-codex.mjs"), "WORKBENCH_CLAUDE_BIN": os.path.join(FIX, "fake-claude.mjs"), "WORKBENCH_VAULT_SUGGEST": ""}
host = None; G = {}
def start_gw():
    global host
    host = subprocess.Popen(["node", os.path.join(REPO, "apps/host/dist/host.mjs")], cwd=REPO, env=env, stdout=subprocess.PIPE, text=True)
    for line in host.stdout:
        if line.startswith("WORKBENCH_READY "): G.update(json.loads(line[16:])); return
    raise SystemExit("gateway did not start")
def stop_gw():
    if host and host.poll() is None: host.terminate(); host.wait(timeout=30)
import atexit
atexit.register(lambda: (stop_gw(), broadway.poll() is None and broadway.terminate()))
def api(method, path, body=None):
    r = urllib.request.Request(G["url"] + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"authorization": f"Bearer {G['token']}", "content-type": "application/json"})
    with urllib.request.urlopen(r) as h: return json.loads(h.read())

EXT = {"docx": "docx", "pptx": "pptx", "xlsx": "xlsx", "pdf": "pdf", "hwpx": "hwpx", "md": "md"}
SRC = {"docx": os.path.join(FIX, "hello.docx"), "pptx": os.path.join(FIX, "cover.pptx"), "xlsx": os.path.join(FIX, "supplies.xlsx"),
       "pdf": os.path.join(FIX, "opendataloader/text.pdf"), "hwpx": os.path.join(REPO, "apps/host/src/channels/fixtures/강의계획서.hwpx")}
MD = "# 메모\n\n" + "\n".join(f"{i}. 준비할 것 — 자료, 장소, 시간표." for i in range(1, 81)) + "\n"
def place(kind, path):
    if kind == "md": open(path, "w").write(MD)
    else: shutil.copyfile(SRC[kind], path)

answer = lambda i: (f"## {i}번째 답\n\n강의안의 구조를 정리했습니다. **핵심**은 세 가지입니다.\n\n- 첫째: 목표와 평가 기준을 맞춘다\n- 둘째: 사례 두 장을 한 장으로 합친다\n- 셋째: 실습 시간을 늘린다\n\n"
                    "| 주차 | 주제 | 비고 |\n|---|---|---|\n| 1 | 소개 | 자료 배포 |\n| 2 | 실습 | 조별 |\n\n```ts\nexport function plan(week: number) {\n  return week < 8 ? \"이론\" : \"실습\";\n}\n```\n\n> 다음 주까지 초안을 보내 주세요. " + "설명 문장을 이어서 씁니다. " * 12)

# ── data ──
start_gw()
api("PUT", "/api/prefs", {"prefs": {"onboarding": "done", "startScreen": "last", "layoutScope": "global", "sidebar": True}})
c1, c2 = os.path.join(base, "p1"), os.path.join(base, "p2"); os.makedirs(c1); os.makedirs(c2)
docs = []
if SCENE == "doc":
    for n in ("가", "나", "다"): place(KIND, os.path.join(c1, f"{n}문서.{EXT[KIND]}")); docs.append(f"{n}문서.{EXT[KIND]}")
else:
    for k in ("docx", "xlsx", "pptx", "md"): place(k, os.path.join(c1, f"숨김.{EXT[k]}")); docs.append(f"숨김.{EXT[k]}")
p1 = api("POST", "/api/works", {"title": "프로젝트 하나", "cwd": c1}); p2 = api("POST", "/api/works", {"title": "프로젝트 둘", "cwd": c2})
art = {d: api("POST", f"/api/works/{p1['id']}/artifacts", {"path": d})["id"] for d in docs}
sE = api("POST", f"/api/works/{p1['id']}/sessions", {"provider": "claude"})["id"]
s12 = api("POST", f"/api/works/{p1['id']}/sessions", {"provider": "claude"})["id"]
s320 = api("POST", f"/api/works/{p1['id']}/sessions", {"provider": "claude"})["id"]
sP2 = api("POST", f"/api/works/{p2['id']}/sessions", {"provider": "claude"})["id"]
tab = lambda i, w, s: {"id": i, "view": {"kind": "work"}, "workId": w, "sessionId": s}
tabs = [tab("tE", p1["id"], sE), tab("t12", p1["id"], s12), tab("t320", p1["id"], s320), tab("tP2", p2["id"], sP2)]
api("PUT", "/api/layouts/global", {"expectedRevision": 0, "layout": {"version": 2, "focus": "a", "panes": [{**tabs[0], "id": "a", "tabs": tabs, "activeTabId": "tE", "recentTabIds": ["tE"]}]}})
stop_gw()
db = sqlite3.connect(os.path.join(data, "state.sqlite"))
t0 = int(time.time() * 1000) - 30 * 86400_000
for sid, turns in ((s12, 12), (s320, 320)):
    for i in range(turns):
        at = t0 + i * 60_000
        db.execute("INSERT INTO items (session_id, item_id, ord, json) VALUES (?,?,?,?)", (sid, f"user:r{i}", i * 3 + 1, json.dumps({"kind": "user", "id": f"user:r{i}", "text": f"{i+1}번째 요청: 강의안을 정리해 주세요.", "at": at}, ensure_ascii=False)))
        db.execute("INSERT INTO items (session_id, item_id, ord, json) VALUES (?,?,?,?)", (sid, f"tool:{i}", i * 3 + 2, json.dumps({"kind": "tool", "id": f"tool:{i}", "tool": "command", "title": "ls -la", "status": "completed", "output": "total 8\n-rw-r--r-- 1 a a 120 보고서.docx\n" * 6, "at": at}, ensure_ascii=False)))
        db.execute("INSERT INTO items (session_id, item_id, ord, json) VALUES (?,?,?,?)", (sid, f"assistant:{i}", i * 3 + 3, json.dumps({"kind": "assistant", "id": f"assistant:{i}", "text": answer(i + 1), "streaming": False, "at": at}, ensure_ascii=False)))
db.commit(); db.close()
start_gw()

# ── /proc ──
HZ = os.sysconf("SC_CLK_TCK")
def kids_of(root):
    rows = {}
    for e in os.listdir("/proc"):
        if not e.isdigit(): continue
        try:
            st = open(f"/proc/{e}/stat").read(); tail = st.rsplit(")", 1)[1].split()
            rows[int(e)] = (int(tail[1]), open(f"/proc/{e}/comm").read().strip())
        except OSError: pass
    out = []
    for pid, (pp, name) in rows.items():
        at, hops = pid, 0
        while at > 1 and hops < 30:
            at = rows.get(at, (0,))[0]; hops += 1
            if at == root: out.append((pid, name)); break
    return out
def mem(pid):
    r = {"rss": 0, "pss": 0, "swap": 0}
    try:
        for line in open(f"/proc/{pid}/smaps_rollup"):
            if line.startswith("Rss:"): r["rss"] = int(line.split()[1])
            if line.startswith("Pss:"): r["pss"] = int(line.split()[1])
            if line.startswith("Swap:"): r["swap"] = int(line.split()[1])
    except OSError: pass
    return r
def ticks(pid, main_only=False):
    try:
        p = f"/proc/{pid}/task/{pid}/stat" if main_only else f"/proc/{pid}/stat"
        t = open(p).read().rsplit(")", 1)[1].split(); return int(t[11]) + int(t[12])
    except OSError: return 0
def webprocs(): return [(p, n) for p, n in kids_of(os.getpid()) if n.startswith("WebKit")]
def memrow():
    row = {"uiProcess": {k: v // 1024 for k, v in mem(os.getpid()).items()}, "web": [], "gatewayRssMb": mem(host.pid)["rss"] // 1024}
    for p, n in webprocs(): m = mem(p); row["web"].append({"pid": p, "name": n, "rssMb": m["rss"] // 1024, "pssMb": m["pss"] // 1024, "swapMb": m["swap"] // 1024})
    row["webProcessRssMb"] = sum(w["rssMb"] for w in row["web"] if w["name"].startswith("WebKitWebProces"))
    row["webProcessPssMb"] = sum(w["pssMb"] for w in row["web"] if w["name"].startswith("WebKitWebProces"))
    row["webProcessSwapMb"] = sum(w["swapMb"] for w in row["web"] if w["name"].startswith("WebKitWebProces"))
    row["webProcessRssSwapMb"] = row["webProcessRssMb"] + row["webProcessSwapMb"]
    row["allWebKitPssMb"] = sum(w["pssMb"] for w in row["web"])
    return row
def cpu_over(sec):
    wp = [p for p, n in webprocs() if n.startswith("WebKitWebProces")]; allw = [p for p, _ in webprocs()]
    a = (sum(ticks(p) for p in wp), sum(ticks(p, True) for p in wp), sum(ticks(p) for p in allw), ticks(os.getpid()), ticks(host.pid))
    pump(sec)
    b = (sum(ticks(p) for p in wp), sum(ticks(p, True) for p in wp), sum(ticks(p) for p in allw), ticks(os.getpid()), ticks(host.pid))
    pc = lambda i: round((b[i] - a[i]) / HZ / sec * 100, 1)
    return {"seconds": sec, "webProcessCpuPct": pc(0), "webMainThreadCpuPct": pc(1), "allWebKitCpuPct": pc(2), "uiProcessCpuPct": pc(3), "gatewayCpuPct": pc(4)}

# ── window ──
WINDOW = """(() => { if (window.top !== window) return; window.__workbenchTabSleepMs = %d; window.__frames = {}; window.__wasm = [];
  window.addEventListener('message', (e) => { const d = e.data; if (d && d.type === 'office:mcp-result') (window.__mcp = window.__mcp || {})[d.requestId] = d.reply; if (!d || !d.__perf) return;
    if (d.__perf === 'state') window.__frames[d.href] = { ...d, seen: performance.now() };
    if (d.__perf === 'wasm') window.__wasm.push({ ...d, t: performance.now() }); if (d.__perf === 'probe-result') (window.__probes = window.__probes || {})[d.href] = d.data; if (d.__perf === 'act-result') (window.__acts = window.__acts || []).push(d); if (d.type === 'office:mcp-result') (window.__mcp = window.__mcp || {})[d.requestId] = d.reply; if (typeof d.type === 'string' && d.type.startsWith('office:')) (window.__seen = window.__seen || []).push(d.type + ' ' + JSON.stringify(d).slice(0, 200)); }); })();""" % SLEEP_MS
EARLY = """(() => { if (window.top === window) return; const post = (m) => { try { window.top.postMessage(m, '*'); } catch (e) {} };
  const W = WebAssembly; const href = location.href;
  for (const name of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) { const f = W[name]; if (!f) continue;
    W[name] = function (src, ...rest) { const size = src && src.byteLength; post({ __perf: 'wasm', call: name, href, size: size || null, src: (src && src.url) || null }); return f.call(this, src, ...rest); }; }
  const OW = window.Worker; if (OW) window.Worker = function (u, o) { post({ __perf: 'wasm', call: 'Worker', href, src: String(u) }); return new OW(u, o); }; })();"""
FRAME = """(() => { if (window.top === window) return;
  const depth = (() => { let d = 0, w = window; try { while (w !== window.top) { w = w.parent; d++; } } catch (e) {} return d; })();
  const stage = () => { const s = (window.Konva && window.Konva.stages) || []; return s.length ? s.reduce((a, b) => (b.width() > a.width() ? b : a)) : null; };
  window.__typedOk = false;
  setInterval(() => { const pm = document.querySelector('.ProseMirror'); const cm = document.querySelector('.cm-content');
    const st = stage(); const body = document.body ? document.body.innerText || '' : '';
    let text = pm ? pm.textContent : cm ? cm.textContent : st ? st.find('Text').map((n) => n.text()).join('') : body.slice(0, 4000);
    window.top.postMessage({ __perf: 'state', href: location.href, title: document.title, depth, name: window.name,
      editable: document.querySelectorAll('[contenteditable="true"]').length, canvas: document.querySelectorAll('canvas').length,
      pm: Boolean(pm), cm: Boolean(cm), konva: Boolean(st), sheetInput: Boolean(document.getElementById('__editor___INTERNAL_EDITOR__DOCS_NORMAL')),
      text: (text || '').slice(-400), body: body.length, kids: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.getAttribute('src'), id: f.id, cls: f.className, name: f.name, title: f.title, srcdoc: f.hasAttribute('srcdoc') })) }, '*'); }, 150);
  const typeInto = (el, text) => { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertText', false, text); };
  const dbl = async (word) => { const s = stage(); const node = s && s.find('Text').find((c) => c.text().includes(word)); if (!node) return false;
    const rc = node.getClientRect(); const box = s.container().getBoundingClientRect(); const k = box.width / s.width();
    const x = box.left + (rc.x + rc.width / 2) * k, y = box.top + (rc.y + rc.height / 2) * k; const t = document.elementFromPoint(x, y);
    const b = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    for (let c = 1; c <= 2; c++) { t.dispatchEvent(new MouseEvent('mousedown', { ...b, buttons: 1, detail: c })); t.dispatchEvent(new MouseEvent('mouseup', { ...b, buttons: 0, detail: c })); t.dispatchEvent(new MouseEvent('click', { ...b, buttons: 0, detail: c })); await new Promise((r) => setTimeout(r, 60)); }
    t.dispatchEvent(new MouseEvent('dblclick', { ...b, buttons: 0, detail: 2 })); return true; };
  const clickAt = async (word, n) => { const s = stage(); const node = s && s.find('Text').find((c) => c.text().includes(word)); if (!node) return 'no node ' + word;
    const rc = node.getClientRect(); const box = s.container().getBoundingClientRect(); const k = box.width / s.width();
    const x = box.left + (rc.x + rc.width / 2) * k, y = box.top + (rc.y + rc.height / 2) * k; const t = document.elementFromPoint(x, y);
    const b = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    for (let c = 1; c <= n; c++) { t.dispatchEvent(new PointerEvent('pointerdown', { ...b, buttons: 1, detail: c, pointerType: 'mouse', isPrimary: true })); t.dispatchEvent(new MouseEvent('mousedown', { ...b, buttons: 1, detail: c })); t.dispatchEvent(new PointerEvent('pointerup', { ...b, buttons: 0, detail: c, pointerType: 'mouse', isPrimary: true })); t.dispatchEvent(new MouseEvent('mouseup', { ...b, buttons: 0, detail: c })); t.dispatchEvent(new MouseEvent('click', { ...b, buttons: 0, detail: c })); await new Promise((r) => setTimeout(r, 80)); }
    return 'ok'; };
  const md = (el) => { const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, view: window }; el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 })); };
  window.addEventListener('message', async (e) => { const d = e.data; if (!d || d.__perf !== 'act' || d.href !== location.href) return; let out = null;
    try {
      if (d.act === 'select') out = await clickAt(d.word, 1);
      else if (d.act === 'pickfont') { const caret = document.querySelector('.rb-font-name .rb-size-caret'); if (!caret) out = 'no caret'; else { md(caret); await new Promise((r) => setTimeout(r, 1500));
          const opt = [...document.querySelectorAll('.rb-font-menu button')].find((b) => (b.firstChild && b.firstChild.textContent || '').trim() === d.family);
          out = opt ? (md(opt), 'ok') : 'no option; menu: ' + [...document.querySelectorAll('.rb-font-menu button')].map((b) => b.textContent).slice(0, 40).join('|'); } }
      else if (d.act === 'typefont') { const input = document.querySelector('.rb-font-input'); if (!input) out = 'no input'; else { md(input); input.focus(); await new Promise((r) => setTimeout(r, 200));
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, d.family); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 800));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); out = 'typed; disabled=' + input.disabled; } }
      else if (d.act === 'openfontmenu') { const caret = document.querySelector('.rb-font-name .rb-size-caret'); out = caret ? (md(caret), 'ok') : 'no caret'; }
      else if (d.act === 'escape') { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); if (t.blur) t.blur(); const c = document.querySelector('.rb-font-name .rb-size-caret'); if (document.querySelector('.rb-font-menu') && c) md(c); out = 'ok'; }
      else if (d.act === 'save') { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); out = 'ok'; }
      else if (d.act === 'gallery') { const chip = document.querySelector('.ai-tpl-chip-main'); if (!chip) out = 'no chip'; else { chip.click(); for (let i = 0; i < 200; i++) { const cards = [...document.querySelectorAll('[data-template-id]')]; if (cards.length && cards.every((c) => c.querySelector('.ai-tpl-cover') && c.querySelector('.ai-tpl-cover').childElementCount > 0)) break; await new Promise((r) => setTimeout(r, 100)); }
          out = 'cards ' + document.querySelectorAll('[data-template-id]').length; } }
      else if (d.act === 'fonts') { const faces = await window.slidesApi.privateFontFaces(); const loaded = []; document.fonts.forEach((f) => { if (f.status === 'loaded') loaded.push(f.family + '|' + f.weight); }); out = { faces: (faces || []).map((f) => f.family + '|' + (f.weight || (f.bold ? '700' : '400'))), loaded }; }
      else if (d.act === 'check') { out = {}; for (const fam of d.families) out[fam] = document.fonts.check('24px "' + fam + '"', '가A') ; }
    } catch (x) { out = 'error ' + x; }
    window.top.postMessage({ __perf: 'act-result', act: d.act, href: location.href, out }, '*'); });
  window.addEventListener('message', async (e) => { const d = e.data; if (!d || d.__perf !== 'type' || d.href !== location.href) return;
    const pm = document.querySelector('.ProseMirror'); const cm = document.querySelector('.cm-content');
    if (pm) typeInto(pm.querySelector('p, h1, li') || pm, d.text);
    else if (cm) typeInto(cm.querySelector('.cm-line') || cm, d.text);
    else if (stage()) { if (await dbl(d.word)) { for (let i = 0; i < 40 && !document.querySelector('[contenteditable]'); i++) await new Promise((r) => setTimeout(r, 50));
        const box = document.querySelector('[contenteditable]'); if (box) typeInto(box, d.text); } }
    else { const ed = document.querySelector('[contenteditable="true"]'); if (ed) typeInto(ed, d.text); } }); })();"""

PROBE = """(() => { if (window.top === window) return; const VARIANT = %s;
  const cv = []; const ff = { n: 0, bytes: 0, fams: {} }; let workers = 0;
  const oc = Document.prototype.createElement; Document.prototype.createElement = function (t, ...r) { const el = oc.call(this, t, ...r); if (String(t).toLowerCase() === 'canvas') cv.push(new WeakRef(el)); return el; };
  if (window.OffscreenCanvas) { const OO = window.OffscreenCanvas; window.OffscreenCanvas = function (w, h) { const c = new OO(w, h); cv.push(new WeakRef(c)); return c; }; }
  const OF = window.FontFace; window.FontFace = function (fam, src, d) { ff.n++; const b = src && src.byteLength; if (b) ff.bytes += b; ff.fams[fam] = (ff.fams[fam] || 0) + (b || 0); const f = new OF(fam, src, d); if (typeof src === 'string') f.__url = true; return f; };
  if (VARIANT.includes('nourlfaces')) { const add = FontFaceSet.prototype.add; FontFaceSet.prototype.add = function (f) { if (f && f.__url) return this; return add.call(this, f); }; }
  const OW = window.Worker; window.Worker = function (u, o) { workers++; return new OW(u, o); };
  if (VARIANT.includes('nofonts') && /slides\\.html/.test(location.href)) { let api; Object.defineProperty(window, 'slidesApi', { configurable: true, get() { return api; }, set(v) { api = v ? { ...v, privateFontFaces: async () => [] } : v; } }); }
  window.addEventListener('message', (e) => { const d = e.data; if (!d || d.__perf !== 'probe') return;
    let alive = 0, bytes = 0, dom = 0, domBytes = 0; const sizes = [];
    for (const r of cv) { const c = r.deref(); if (!c) continue; alive++; const b = c.width * c.height * 4; bytes += b; if (c.isConnected) { dom++; domBytes += b; } sizes.push(c.width + 'x' + c.height + (c.isConnected ? '' : '*')); }
    sizes.sort((a, b) => parseInt(b) - parseInt(a));
    let fonts = 0, loaded = 0; const fl = {}; try { document.fonts.forEach((f) => { fonts++; if (f.status === 'loaded') loaded++; fl[f.family] = (fl[f.family] || 0) + 1; }); } catch (x) {}
    let imgPx = 0; for (const i of document.images) imgPx += (i.naturalWidth || 0) * (i.naturalHeight || 0);
    window.top.postMessage({ __perf: 'probe-result', href: location.href, data: { canvasCreated: cv.length, canvasAlive: alive, canvasAliveMB: Math.round(bytes / 1048576), canvasInDom: dom, canvasInDomMB: Math.round(domBytes / 1048576), canvasSizes: sizes.slice(0, 12),
      fontFaceCtor: ff.n, fontFaceBytesMB: Math.round(ff.bytes / 1048576 * 10) / 10, fontFaceFams: ff.fams, documentFonts: fonts, documentFontsLoaded: loaded, documentFontFams: fl,
      images: document.images.length, imageMpx: Math.round(imgPx / 1e5) / 10, workers, nodes: document.querySelectorAll('*').length, konvaStages: (window.Konva && window.Konva.stages || []).length } }, '*'); }); })();""" % json.dumps(VARIANT)

Gdk.Screen.get_default().set_resolution(96.0)
SIZE = [int(x) for x in os.environ.get("WK_SIZE", "1440x900").split("x")]; res["size"] = SIZE
window = Gtk.OffscreenWindow(); window.set_default_size(*SIZE)
ucm = WebKit2.UserContentManager()
# doc-default: documents open 쪽 보기 first; this rig expects the editor, so it chooses it (the one way: scripts/fixtures/editor-first.js).
ucm.add_script(WebKit2.UserScript(open(os.path.join(FIX, "editor-first.js"), encoding="utf-8").read(), WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.add_script(WebKit2.UserScript(WINDOW, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.add_script(WebKit2.UserScript(PROBE, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.add_script(WebKit2.UserScript(EARLY, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.START, None, None))
ucm.add_script(WebKit2.UserScript(FRAME, WebKit2.UserContentInjectedFrames.ALL_FRAMES, WebKit2.UserScriptInjectionTime.END, None, None))
view = WebKit2.WebView.new_with_user_content_manager(ucm)
if MODE == "never": view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
elif MODE == "always": view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
res["accelPolicy"] = str(view.get_settings().get_hardware_acceleration_policy())
loads = []
view.connect("resource-load-started", lambda v, r, req: loads.append((round(time.time(), 3), req.get_uri())) if ".wasm" in req.get_uri() or "worker" in req.get_uri() else None)
crashed = []
view.connect("web-process-terminated", lambda v, reason: crashed.append(str(reason)))
window.add(view); window.show_all(); view.grab_focus()
fe = Gdk.Event.new(Gdk.EventType.FOCUS_CHANGE); fe.focus_change.window = window.get_window(); fe.focus_change.send_event = 1; fe.focus_change.in_ = 1; window.event(fe)
ctx = GLib.MainContext.default()
def pump(sec):
    end = time.time() + sec
    while time.time() < end: ctx.iteration(False); time.sleep(0.005)
def js(script, timeout=20):
    box = {}
    def fin(src, r):
        try:
            v = src.evaluate_javascript_finish(r); box["v"] = json.loads(v.to_string()) if v and not v.is_undefined() else None
        except Exception as e: box["v"] = {"error": str(e)}
    view.evaluate_javascript(f"JSON.stringify((() => {{ {script} }})())", -1, None, None, None, fin)
    end = time.time() + timeout
    while "v" not in box and time.time() < end: ctx.iteration(True) if False else (ctx.iteration(False), time.sleep(0.002))
    return box.get("v")
def until(fn, timeout, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v: return v
        pump(step)
    return None
def measure(label, settle=3.0, cpu=0):
    pump(settle)
    dom = js("return { frames: document.querySelectorAll('iframe').length, panes: document.querySelectorAll('section.pane').length, nodes: document.querySelectorAll('*').length, reporting: Object.keys(window.__frames).filter((k) => performance.now() - window.__frames[k].seen < 2000).length }")
    dom["tabs"] = js("return [...new Set([...document.querySelectorAll('[data-tab-id]')].map((x) => x.getAttribute('data-tab-id').slice(0, 12)))]")
    row = {"step": label, "t": round(time.time() - T0, 1), **memrow(), "dom": dom}
    if cpu: row["cpu"] = cpu_over(cpu)
    res["steps"].append(row); save()
    print(f"[{row['t']}s] {label}: web RSS {row['webProcessRssMb']} +swap {row['webProcessSwapMb']} PSS {row['webProcessPssMb']} UI {row['uiProcess']} dom {dom} {row.get('cpu','')}", flush=True)
    return row
def click_tab(tid): return js(f"const b = document.querySelector('[data-tab-id=\"{tid}\"] [role=tab]'); if (!b) return false; b.click(); return true")
def tab_with(name): return js(f"const w = [...document.querySelectorAll('[data-tab-id]')].find((x) => x.textContent.includes({json.dumps(name)})); return w ? w.getAttribute('data-tab-id') : null")
def frames_now(): return js("return Object.values(window.__frames).filter((f) => performance.now() - f.seen < 1500)") or []
def office_frame(name_hint=None):
    fr = [f for f in frames_now() if "/office/" in f["href"] and not f["href"].endswith("executor.html")]
    return fr
LEAF = "[...document.querySelectorAll('aside *')].filter((el) => el.children.length === 0 && el.textContent.trim() === %s && el.offsetParent !== null)"
def side_back():
    if js("return document.querySelectorAll('aside.sidebar').length > 0"): return
    js("const b = [...document.querySelectorAll('button')].find((x) => /작업 화면으로/.test((x.getAttribute('aria-label') || '') + x.textContent)); b && b.click(); return Boolean(b)"); pump(0.6)
    if not js("return document.querySelectorAll('aside.sidebar').length > 0"): click_tab("tE"); pump(0.8)
def open_doc(name):
    """Through the app's own sidebar: the document's row under the project, clicked as a person clicks."""
    side_back()
    if not js("return " + LEAF % json.dumps(name) + ".length > 0"): to_project("프로젝트 하나"); pump(1.5)
    if not until(lambda: js("return " + LEAF % json.dumps(name) + ".length > 0"), 8): res["notes"].append("doc rows: " + str(js("return [...document.querySelectorAll('aside')].map((a) => a.innerText.replace(/\\n+/g, ' / ').slice(0, 500))")))
    before = {f["href"] for f in frames_now()}
    t = time.time()
    ok = js("const el = " + LEAF % json.dumps(name) + "[0]; if (!el) return false; (el.closest('button, a, [role=treeitem], [role=button], [role=option]') || el).click(); return true")
    if not ok: res["notes"].append(f"sidebar row for {name} not found")
    return t, before
def to_project(title):
    side_back()
    if not js("return " + LEAF % json.dumps(title) + ".length > 0"):
        js("const b = [...document.querySelectorAll('aside button')].find((x) => /프로젝트 목록|뒤로/.test(x.getAttribute('aria-label') || x.title || '')); b && b.click(); return Boolean(b)"); pump(0.8)
    ok = js("const el = " + LEAF % json.dumps(title) + "[0]; if (!el) return false; (el.closest('button, a, [role=treeitem], [role=button], [role=option]') || el).click(); return true")
    if not ok: res["notes"].append(f"project row {title} not found")
    return ok
SURFACE = {"docx": lambda f: f["pm"], "md": lambda f: f["pm"] or f["cm"] or f["editable"] > 0, "pptx": lambda f: f["konva"] and "질문에서" in f["text"],
           "xlsx": lambda f: f["sheetInput"] and f["canvas"] > 0, "pdf": lambda f: f["canvas"] > 0 and "pdf" in f["href"], "hwpx": lambda f: f["canvas"] > 0 and "studio" in f["href"]}
TYPABLE = {"docx", "md", "pptx"}
def kind_of(name): return {"docx": "docx", "pptx": "pptx", "xlsx": "xlsx", "pdf": "pdf", "hwpx": "hwpx", "md": "md"}[name.rsplit(".", 1)[1]]
def wait_usable(kind, t, marker, timeout=90, aid=None, before=frozenset(), name=None):
    """surfaceMs: the editor's own surface is there (per kind, see SURFACE); typedMs: a typed marker is back in the editor's text."""
    out = {"surfaceMs": None, "typedMs": None}
    hit = until(lambda: next((f for f in frames_now() if "/office/" in f["href"] and (aid is None or aid in f["href"] or f["href"] not in before or (name and (f.get("title") or "").startswith(name))) and SURFACE[kind](f)), None), timeout)
    if not hit: return out
    out["surfaceMs"] = round((time.time() - t) * 1000)
    if kind in TYPABLE:
        href = hit["href"]
        for _ in range(3 if kind == "pptx" else 1):
            js(f"for (const f of document.querySelectorAll('iframe')) f.contentWindow.postMessage({{ __perf: 'type', href: {json.dumps(href)}, text: {json.dumps(marker)}, word: '질문에서' }}, '*'); return 1")
            got = until(lambda: next((f for f in frames_now() if f["href"] == href and marker in f["text"]), None), 10)
            if got: out["typedMs"] = round((time.time() - t) * 1000); break
    return out
def typing_latency():
    return js("""const el = document.querySelector('section.pane:not([hidden]) .composer-input'); if (!el) return { error: 'no composer' };
      el.focus(); window.__lat = null; const chars = [...'가나다라마바사아자차카타파하 abcdefghij']; const lat = [];
      (async () => { for (const ch of chars) { const t = performance.now();
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
          document.execCommand('insertText', false, ch);
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
          await new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => requestAnimationFrame(() => setTimeout(r, 0)); ch.port2.postMessage(0); }); lat.push(performance.now() - t); await new Promise((r) => setTimeout(r, 60)); }
        const v = el.value !== undefined ? el.value : el.textContent; lat.sort((a, b) => a - b);
        window.__lat = { n: lat.length, medianMs: Math.round(lat[lat.length >> 1] * 10) / 10, p95Ms: Math.round(lat[Math.floor(lat.length * 0.95)] * 10) / 10, maxMs: Math.round(lat[lat.length - 1] * 10) / 10, typedLen: (v || '').length };
        document.execCommand('selectAll'); document.execCommand('delete'); })(); return 1""") and until(lambda: js("return window.__lat"), 60)
def stream_cost(session_id, label):
    wp = [p for p, n in webprocs() if n.startswith("WebKitWebProces")]
    a = (sum(ticks(p, True) for p in wp), sum(ticks(p) for p in wp)); t = time.time()
    api("POST", f"/api/sessions/{session_id}/messages", {"requestId": f"stream-{label}-{int(t)}", "text": "견본 강의안을 정리해 주세요.", "refs": [], "create": None, "mode": "auto"})
    def idle():
        s = next((x for x in api("GET", "/api/snapshot")["sessions"] if x["id"] == session_id), None); return s and s.get("status") == "idle"
    pump(0.5); until(idle, 90, 0.2); wall = time.time() - t; pump(1.0)
    b = (sum(ticks(p, True) for p in wp), sum(ticks(p) for p in wp))
    return {"label": label, "wallSec": round(wall, 2), "webMainThreadCpuSec": round((b[0] - a[0]) / HZ, 2), "webProcessCpuSec": round((b[1] - a[1]) / HZ, 2), "note": "CPU seconds of the WebKit web process over the stream + 1 s; tick resolution 10 ms"}

def slides_href():
    fr = [f for f in frames_now() if "slides.html" in f["href"]]; return fr[0]["href"] if fr else None
def act(a, timeout=20, **kw):
    href = slides_href(); js("window.__acts = []; for (const f of document.querySelectorAll('iframe')) f.contentWindow.postMessage(" + json.dumps({"__perf": "act", "act": a, "href": href, **kw}) + ", '*'); return 1")
    r = until(lambda: js("return (window.__acts || []).find((x) => x.act === %s) || null" % json.dumps(a)), timeout); out = r and r["out"]
    print("act", a, kw, "->", json.dumps(out, ensure_ascii=False)[:600], flush=True); res.setdefault("acts", []).append({"act": a, **kw, "out": out}); save(); return out
MCPN = [0]
def mcp(command, payload=None, timeout=30):
    MCPN[0] += 1; rid = f"edmem-{MCPN[0]}"; req = {"kind": "command", "family": "pptx", "command": command, **({"payload": payload} if payload is not None else {})}
    js("const f = document.querySelector('iframe.office-frame'); f.contentWindow.postMessage(" + json.dumps({"type": "office:mcp", "requestId": rid, "request": req}) + ", '*'); return 1")
    r = until(lambda: js("return (window.__mcp || {})[%s] || null" % json.dumps(rid)), timeout)
    if r is None: print("seen", js("return (window.__seen || []).slice(-15)"), flush=True)
    print("mcp", command, "->", json.dumps(r, ensure_ascii=False)[:400], flush=True); res.setdefault("mcp", []).append({"command": command, "payload": payload, "reply": r}); save(); return r
def shot(name):
    d = os.environ.get("WK_SHOTDIR")
    if not d: return
    box = {}
    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, lambda v, r: box.update(s=v.get_snapshot_finish(r)))
    until(lambda: "s" in box, 20); box.get("s") and box["s"].write_to_png(os.path.join(d, name + ".png")); print("shot", name, flush=True)
def element_ids():
    r = mcp("read_deck"); found = {}
    def walk(o):
        if isinstance(o, dict):
            t = json.dumps(o, ensure_ascii=False)
            if isinstance(o.get("id"), str) and o.get("type") == "text":
                for w in ("가을", "질문", "Writing"):
                    if w in t and w not in found: found[w] = o["id"]
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(r); print("ids", found, flush=True); return found
def run_case(case):
    pump(2); ids = element_ids(); sub, title = ids.get("질문"), ids.get("가을")
    # the same setup on both builds: the subtitle becomes Latin text (the deck uses no template font yet)
    mcp("apply_slide_ops", {"ops": [{"op": "setText", "target": {"slide": 0, "el": sub}, "paragraphs": [{"runs": [{"text": "Writing starts with a question, then a long second line wraps here"}]}]}]}); pump(3)
    shot(f"{case}-0-setup")
    if case in ("a-latin", "a-korean"):
        word, fam = ("Writing", "Playfair Display") if case == "a-latin" else ("가을", "Black Han Sans")
        act("escape"); pump(1); act("escape"); pump(1)
        act("select", word=word); pump(1); act(os.environ.get("WK_PICK", "pickfont"), family=fam, timeout=30); pump(4)
        act("escape"); pump(1); act("select", word=word); pump(0.5)
        js("document.activeElement && document.activeElement.blur(); return 1"); pump(2)
        shot(f"{case}-1-picked"); res["deckPicked"] = mcp("read_slide", None) if False else None
    elif case == "c-ai":
        mcp("apply_slide_ops", {"ops": [{"op": "setFont", "target": {"slide": 0, "el": sub}, "font": {"fontFamily": "Bebas Neue"}}, {"op": "setFont", "target": {"slide": 0, "el": title}, "font": {"fontFamily": "Gowun Batang"}}]}); pump(4)
        shot(f"{case}-1-ai")
    elif case == "b-gallery":
        print("ai button", js("const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '문서 AI' && x.offsetParent !== null && !x.closest('iframe')); b && b.click(); return Boolean(b)"), flush=True); pump(4)
        act("gallery", timeout=60); pump(4); shot(f"{case}-1-gallery")
    act("fonts"); act("check", families=["Playfair Display", "Black Han Sans", "Bebas Neue", "Gowun Batang", "Pretendard", "Noto Serif KR"])
    res["deckAfter"] = mcp("read_deck")
    if case != "b-gallery":
        act("save"); pump(5)
        res["savedXmlFonts"] = saved_fonts()
        # close and reopen
        click_tab("tE"); pump(1); tid = tab_with(docs[0])
        js(f"const w = document.querySelector('[data-tab-id=\"{tid}\"]'); const b = [...w.querySelectorAll('button')].find((x) => x.getAttribute('role') !== 'tab'); b && b.click(); return Boolean(b)"); pump(3)
        t, bf = open_doc(docs[0]); until(lambda: any("slides.html" in f["href"] and f["konva"] for f in frames_now()), 60); pump(6)
        js("document.activeElement && document.activeElement.blur(); return 1"); shot(f"{case}-2-reopened"); act("fonts")
def saved_fonts():
    import glob, re
    out = {}
    for path in [os.path.join(base, "p1", docs[0])]:
        try:
            with zipfile.ZipFile(path) as z: xml = z.read("ppt/slides/slide1.xml").decode("utf8", "replace")
            out[path.rsplit("/", 1)[1]] = sorted(set(re.findall(r'typeface="([^"]*)"', xml)))
        except Exception as e: out["error"] = str(e)
    print("saved fonts", out, flush=True); return out

T0 = time.time()
try:
    tw = time.time(); view.load_uri(f"{G['url']}/?token={G['token']}")
    until(lambda: js("return document.querySelectorAll('section.pane').length > 0 && Boolean(document.querySelector('[data-tab-id=\"tE\"]'))"), 60)
    res["timings"]["windowFirstPaneMs"] = round((time.time() - tw) * 1000)
    measure("window + empty conversation on screen", settle=6)
    if os.environ.get("WK_DEBUG"):
        print("DBG tabs", js("return [...document.querySelectorAll('[data-tab-id]')].map((x) => x.getAttribute('data-tab-id') + ':' + x.textContent.slice(0,30))"))
        print("DBG more", js("return [...document.querySelectorAll('.note-head-more')].map((b) => [b.className, b.getAttribute('aria-label'), b.offsetParent !== null])"))
        print("DBG panes", js("return [...document.querySelectorAll('section.pane')].map((p) => p.getAttribute('data-tab') + ' hidden=' + p.hidden + ' ' + p.className)"))
        print("DBG aside", js("return [...document.querySelectorAll('aside')].map((a) => a.className + ' :: ' + a.innerText.replace(/\\n+/g, ' / ').slice(0, 600))"))
        print("DBG js", js("window.__clk = []; document.addEventListener('click', (e) => window.__clk.push(e.target.className + '|' + e.target.textContent.slice(0,20)), true); return 1"))
        t, _ = open_doc(docs[0]); pump(8)
        print("DBG clicks", js("return window.__clk"), js("return [...document.querySelectorAll('.note-menu')].length"))
        print("DBG after", js("return { tabs: [...document.querySelectorAll('[data-tab-id]')].map((x) => x.textContent.slice(0,20)), iframes: [...document.querySelectorAll('iframe')].map((f) => f.src.slice(0,80)), frames: Object.keys(window.__frames), err: document.querySelector('.toast') && document.querySelector('.toast').textContent }"))
        raise SystemExit("debug")
    if SCENE == "conv":
        click_tab("t12"); until(lambda: js("return document.querySelectorAll('section.pane:not([hidden]) .composer-input').length > 0"), 20)
        measure("12-turn conversation on screen (empty one mounted hidden)", settle=4, cpu=30)
        res["typing12"] = typing_latency(); save(); print("typing12", res["typing12"], flush=True)
        click_tab("t320"); t = time.time()
        until(lambda: js("return document.querySelectorAll('section.pane:not([hidden]) .composer-input').length > 0"), 30)
        res["timings"]["open320Ms"] = round((time.time() - t) * 1000)
        measure("320-turn conversation on screen (12 + empty mounted hidden)", settle=4)
        res["long320Nodes"] = js("const p = document.querySelector('section.pane:not([hidden])'); return p ? p.querySelectorAll('*').length : 0")
        res["typing320"] = typing_latency(); save(); print("typing320", res["typing320"], flush=True)
        res["stream"] = [stream_cost(s12, "12-turn streamed, hidden; 320 on screen")]
        click_tab("t12"); pump(3)
        res["stream"].append(stream_cost(s12, "12-turn streamed, on screen; 320 mounted hidden")); save(); print(res["stream"], flush=True)
        click_tab("t320"); pump(3)
        res["stream"].append(stream_cost(s320, "320-turn streamed, on screen")); save(); print(res["stream"][-1], flush=True)
        # four editors, then hidden
        opened = []
        for d in docs:
            t, bf = open_doc(d); u = wait_usable(kind_of(d), t, "ㅋ표시", 30, art[d], bf); opened.append({"doc": d, **u}); pump(2)
        res["timings"]["fourEditors"] = opened; save()
        measure("4 editors open (docx xlsx pptx md), last on screen", settle=3)
        to_project("프로젝트 둘"); pump(2)
        measure("project 2 on screen, 4 editors + 3 conversations awake hidden", settle=2, cpu=30)
        pump(max(0, SLEEP_MS / 1000 + 20 - 32))
        until(lambda: js("return document.querySelectorAll('section.pane').length <= 2"), 60, 1)
        measure("after sleep (sleep time 45 s via window.__workbenchTabSleepMs)", settle=5, cpu=30)
    else:
        def probe():
            js("window.__probes = {}; for (const f of document.querySelectorAll('iframe')) { f.contentWindow.postMessage({ __perf: 'probe' }, '*'); try { for (const g of f.contentWindow.frames) g.postMessage({ __perf: 'probe' }, '*'); } catch (e) {} } return 1")
            pump(1.0); return js("return window.__probes")
        def close_all():
            click_tab("tE"); pump(1)
            for d in docs:
                tid = tab_with(d)
                if tid: js(f"const w = document.querySelector('[data-tab-id=\"{tid}\"]'); const b = [...w.querySelectorAll('button')].find((x) => x.getAttribute('role') !== 'tab'); b && b.click(); return Boolean(b)"); pump(1)
            return js("return [...document.querySelectorAll('[data-tab-id]')].map((x) => x.getAttribute('data-tab-id'))")
        NT = int(os.environ.get("WK_TABS", "1")); CY = int(os.environ.get("CYCLES", "3")); res["timings"]["open"] = []
        def open_n(tag):
            for i, d in enumerate(docs[:NT]):
                t, bf = open_doc(d); u = wait_usable(KIND, t, f"ㅋ{i}표", 90, art[d], bf, d); res["timings"]["open"].append({"doc": d, "tag": tag, **u}); print(d, u, flush=True)
                row = measure(f"{tag}: {KIND} tab {i + 1} open (on screen)", settle=6); row["probe"] = probe(); save()
                if os.environ.get("WK_SHOT") and tag == "first":
                    box = {}
                    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, lambda v, r: box.update(s=v.get_snapshot_finish(r)))
                    until(lambda: "s" in box, 20); box.get("s") and box["s"].write_to_png(os.environ["WK_SHOT"]); print("probe", json.dumps(row["probe"], ensure_ascii=False)[:1500], flush=True)
        open_n("first")
        CASE = os.environ.get("WK_CASE")
        if CASE: run_case(CASE)
        for c in range(CY):
            res.setdefault("tabsLeft", []).append(close_all())
            measure(f"cycle {c + 1}: {KIND} tabs closed, 30 s later", settle=30)
            if os.environ.get("WK_GC"):
                measure(f"cycle {c + 1}: diagnostic: 90 s after the close", settle=60)
                view.get_context().clear_cache()
                measure(f"cycle {c + 1}: diagnostic: after WebKitWebContext.clear_cache(), 5 s", settle=5)
            if c < CY - 1 or os.environ.get("REOPEN_LAST"): open_n(f"cycle {c + 1} reopen")
except Exception as e:
    import traceback; res["failure"] = traceback.format_exc(); print(res["failure"], flush=True)
finally:
    res["wasm"] = (js("return window.__wasm") or []) if not crashed else []
    res["wasmResourceLoads"] = [(round(t - T0, 2), u.split("?")[0][-90:]) for t, u in loads]
    res["webProcessCrashed"] = crashed
    save()
    stop_gw(); broadway.terminate(); broadway.wait(timeout=10)
    shutil.rmtree(base, ignore_errors=True)
print("done", OUT)
