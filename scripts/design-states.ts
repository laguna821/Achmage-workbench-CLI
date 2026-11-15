/// <reference lib="dom" />
// The control family's states sheet (Hallmark U2): every family × every one of the eight states,
// drawn with the app's own built stylesheets and the class names the markup uses, in light and dark.
// It is the proof of the control family and the next reviewer's tool: a state that cannot be told
// from its neighbour on this sheet is not a state.
//
// Hover, press and keyboard focus are forced through the browser's devtools protocol on the cell's
// element (no helper class enters the product's CSS); selected, disabled, loading and error use the
// attributes the app itself sets (aria-pressed/-expanded/-selected/-current/-checked, .on/.active/
// .current, disabled/aria-disabled, aria-busy, aria-invalid).
//
// Usage: npm run build -w @workbench/web, then
//        node scripts/design-states.ts [outDir] [--themes=light,dark] [--width=1440]
// Writes states-<theme>.png (and states.html, the page itself) into outDir. Needs only apps/web/dist.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? "ux-states");
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const themes = (option("themes")?.split(",") ?? ["light", "dark"]).filter((theme) => theme === "light" || theme === "dark");
const width = Number(option("width") ?? 1600);
const dist = resolve(option("dist") ?? "apps/web/dist"); // --dist=<built web folder> (fix 1: a build beside the default one)
if (!existsSync(join(dist, "index.html"))) throw new Error("apps/web/dist is missing: npm run build -w @workbench/web first");
mkdirSync(outDir, { recursive: true });

const index = readFileSync(join(dist, "index.html"), "utf8");
const sheets = [...index.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((match) => match[1]);

const STATES = ["rest", "hover", "focus-visible", "pressed", "selected", "disabled", "loading", "error"] as const;
type State = typeof STATES[number];
type Cell = string | null; // null: the state does not exist for this family (said in the cell)
type Row = { family: string; note: string; context?: string; cells: Record<State, Cell> };

/** A cell's markup, with the forced pseudo-classes on the element that carries them. */
const force = (html: string, state: State) => {
  const pseudo = state === "hover" ? "hover" : state === "pressed" ? "active hover" : state === "focus-visible" ? "focus focus-visible" : "";
  return pseudo ? html.replace(/<FORCE (\w+)/, `<$1 data-force="${pseudo}"`) : html;
};
/** Fill a template's {attrs} and {cls} slots for each state. */
const states = (template: (s: { attrs: string; cls: string; state: State }) => string, opts: {
  selected?: { attrs?: string; cls?: string } | null; disabled?: string; busy?: string; error?: { attrs?: string; cls?: string } | null; pressed?: boolean;
} = {}): Record<State, Cell> => {
  const out = {} as Record<State, Cell>;
  for (const state of STATES) {
    let attrs = "", cls = "";
    if (state === "selected") { if (opts.selected === null) { out[state] = null; continue; } attrs = opts.selected?.attrs ?? 'aria-pressed="true"'; cls = opts.selected?.cls ?? ""; }
    if (state === "pressed" && opts.pressed === false) { out[state] = null; continue; }
    if (state === "disabled") attrs = opts.disabled ?? "disabled";
    if (state === "loading") attrs = opts.busy ?? 'aria-busy="true"';
    if (state === "error") { if (opts.error === null) { out[state] = null; continue; } attrs = opts.error?.attrs ?? 'aria-invalid="true"'; cls = opts.error?.cls ?? ""; }
    out[state] = force(template({ attrs, cls, state }), state).replace(/<FORCE (\w+)/g, "<$1");
  }
  return out;
};
const icon = (d: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const PLUS = icon("M12 5v14M5 12h14");
const CHEV = icon("m6 9 6 6 6-6");
const DOC = icon("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5");

const ROWS: Row[] = [
  { family: "Key, primary", note: ".button.primary", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="button primary ${cls}" ${attrs}>허용 <kbd>Enter</kbd></button>`) },
  { family: "Key, secondary", note: ".button", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="button ${cls}" ${attrs}>거절 <kbd>Esc</kbd></button>`) },
  { family: "Key, quiet", note: ".ghost-button, .text-button", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="ghost-button ${cls}" ${attrs}>${PLUS}새로 만들기</button>`, { selected: { cls: "pressed" } }) },
  { family: "Icon key", note: ".icon-button, .hig-icon-button", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="icon-button ${cls}" aria-label="새 문서" ${attrs}>${DOC}</button>`, { selected: { cls: "pressed" } }) },
  { family: "Icon key, send", note: ".icon-button.primary (composer)", context: "hig-composer", cells: states(({ attrs, cls }) => `<div class="composer-bar"><FORCE button type="button" class="icon-button primary ${cls}" aria-label="보내기" ${attrs}>${icon("M12 19V5M5 12l7-7 7 7")}</button></div>`, { selected: null }) },
  { family: "Select", note: ".select-button, .ui-select (open = held)", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="ui-select ${cls}" aria-haspopup="listbox" ${attrs}><span class="ui-select-value">기본 작업공간</span>${CHEV}</button>`, { selected: { attrs: 'aria-expanded="true"' } }) },
  { family: "Select, quiet", note: ".plain-select (composer tools)", context: "hig-composer", cells: states(({ attrs, cls }) => `<div class="composer-bar"><FORCE button type="button" class="plain-select ${cls}" ${attrs}>${icon("M13 2 3 14h9l-1 8 10-12h-9z")}<span class="plain-select-label">자동</span>${CHEV}</button></div>`, { selected: { attrs: 'aria-expanded="true"' } }) },
  { family: "Field, text", note: "dialog input", context: "feature-dialog", cells: states(({ attrs }) => `<FORCE input type="text" value="3주차 강의안" aria-label="이름" ${attrs}>`, { selected: null, pressed: false }) },
  { family: "Field, search", note: ".search-field", cells: states(({ attrs, state }) => `<label class="search-field"${state === "error" ? ' aria-invalid="true"' : ""}>${icon("M21 21l-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z")}<FORCE input type="search" placeholder="보관한 것 찾기" aria-label="찾기" ${attrs}></label>`, { selected: null, pressed: false }) },
  { family: "Field, textarea", note: "dialog textarea", context: "feature-dialog", cells: states(({ attrs }) => `<FORCE textarea rows="2" aria-label="요청" ${attrs}>어제 바뀐 문서를 요약해 줘</textarea>`, { selected: null, pressed: false }) },
  { family: "Segmented", note: ".hk-seg (the chosen cell is a raised key)", cells: states(({ attrs, state }) => `<div class="hk-seg" data-hk="" style="--_n: 3; --_i: ${state === "selected" ? 2 : 0}" role="radiogroup" aria-label="화면" ${state === "error" ? 'aria-invalid="true"' : ""}><span class="hk-seg__indicator"></span><button type="button" class="hk-seg__item" aria-checked="${state === "selected" ? "false" : "true"}">시스템</button><FORCE button type="button" class="hk-seg__item" aria-checked="false" ${state === "error" ? "" : attrs}>라이트</button><button type="button" class="hk-seg__item" aria-checked="${state === "selected" ? "true" : "false"}">다크</button></div>`, { selected: { attrs: "" } }) },
  { family: "Row", note: ".side-row (sidebar)", context: "sidebar", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="side-row row-session ${cls}" ${attrs}>${icon("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")}<span class="side-row-label">슬라이드 정리</span></button>`, { selected: { cls: "current", attrs: 'aria-selected="true"' } }) },
  // Skin 2 fix 1: the same rows INSIDE the real list column (<aside class="sidebar look-scope nav-column">),
  // where the --accent cycle once left focus rings, drop marks and the rename edge without a colour.
  { family: "Row in the list column", note: ".nav-column .side-row (level 2, words)", context: "list-column", cells: states(({ attrs, cls }) => `<FORCE div role="treeitem" tabindex="0" class="side-row row-session ${cls}" data-list-row="" ${attrs}><span class="row-glyph state-mark tone-attention" data-state="attention" aria-hidden style="--mark: 16px">${icon("M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z")}</span><span class="side-row-label">슬라이드 정리</span><span class="side-row-trail"><span class="row-state tone-attention">확인 필요</span></span></div>`, { selected: { cls: "current", attrs: 'aria-selected="true"' } }) },
  { family: "Project row in the column", note: ".nav-column .side-row.nav-project", context: "list-column", cells: states(({ attrs, cls }) => `<FORCE div role="treeitem" tabindex="0" class="side-row nav-project ${cls}" data-list-row="" ${attrs}><div class="nav-project-line"><span class="side-row-icon">${DOC}</span><span class="side-row-label">3주차 강의 슬라이드</span><span class="side-row-trail"><span class="nav-pill">2</span></span></div></div>`, { selected: { cls: "current", attrs: 'aria-current="true"' } }) },
  { family: "Column marks", note: "drop before / after / into, rename, current without focus", context: "list-column", cells: {
    rest: `<div class="side-row row-session drop-before" style="position: relative">${DOC}<span class="side-row-label">위에 놓기</span></div>`,
    hover: `<div class="side-row row-session drop-after" style="position: relative">${DOC}<span class="side-row-label">아래에 놓기</span></div>`,
    "focus-visible": `<div class="side-row row-folder drop-inside">${DOC}<span class="side-row-label">폴더 안에 놓기</span></div>`,
    pressed: `<div class="side-row nav-project renaming"><div class="nav-project-line"><span class="side-row-icon">${DOC}</span><input class="inline-edit side-rename" value="3주차 강의 슬라이드" aria-label="이름 바꾸기" data-force="focus focus-visible"></div></div>`,
    selected: `<div class="side-row row-session current" aria-selected="true">${DOC}<span class="side-row-label">현재 (열 밖에 초점)</span><span class="dot-new"></span></div>`,
    disabled: null, loading: null, error: null,
  } },
  { family: "Tab", note: ".group-tab [role=tab]", context: "group-tabs", cells: STATES.reduce((acc, state) => {
    const active = state === "selected" ? " active" : "";
    const tab = (extra: string) => `<div class="group-tab${active}"${state === "hover" ? ' data-force="hover"' : ""}><button type="button" role="tab" aria-selected="${state === "selected"}"${extra}>${DOC}<span>강의안.md</span></button><button type="button" class="group-tab-close" aria-label="닫기">×</button></div>`;
    acc[state] = tab(state === "pressed" ? ' data-force="active hover"' : state === "focus-visible" ? ' data-force="focus focus-visible"' : state === "disabled" ? ' aria-disabled="true"' : state === "loading" ? ' aria-busy="true"' : state === "error" ? ' aria-invalid="true"' : "");
    return acc;
  }, {} as Record<State, Cell>) },
  { family: "Menu item", note: ".ui-menu-item (hover = the highlight)", context: "menu-slot", cells: states(({ attrs, cls, state }) => `<FORCE div role="menuitemradio" class="ui-menu-item ${cls}" ${state === "hover" ? "data-active" : ""} ${attrs}><span class="ui-menu-text">새 대화</span><span class="ui-menu-shortcut">Ctrl N</span></div>`.replace('data-force="hover"', ""), { selected: { attrs: 'aria-checked="true"' }, disabled: 'aria-disabled="true"' }) },
  { family: "Chip", note: ".filter-chip, .attach-chip (failed = error)", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="filter-chip ${cls}" ${attrs}>Claude</button>`, { selected: { cls: "on" } }) },
  { family: "Check, radio", note: "native, in the accent", cells: STATES.reduce((acc, state) => {
    const f = state === "hover" ? ' data-force="hover"' : state === "pressed" ? ' data-force="active hover"' : state === "focus-visible" ? ' data-force="focus focus-visible"' : "";
    const a = state === "selected" ? " checked" : state === "disabled" ? " disabled" : state === "loading" ? ' aria-busy="true"' : state === "error" ? ' aria-invalid="true"' : "";
    acc[state] = `<label class="check-row"><input type="checkbox"${a}${f}> 하위 폴더 포함</label><label class="check-row"><input type="radio" name="r-${state}"${a}> 매일</label>`;
    return acc;
  }, {} as Record<State, Cell>) },
  { family: "Switch", note: ".check-row.switch-row input", cells: STATES.reduce((acc, state) => {
    const f = state === "pressed" ? ' data-force="active hover"' : state === "focus-visible" ? ' data-force="focus focus-visible"' : "";
    const a = state === "selected" ? " checked" : state === "disabled" ? " disabled" : state === "loading" ? ' aria-busy="true"' : state === "error" ? ' aria-invalid="true"' : "";
    acc[state] = `<label class="check-row switch-row"${state === "hover" ? ' data-force="hover"' : ""}><span>자동 저장</span><input type="checkbox" role="switch"${a}${f}></label>`;
    return acc;
  }, {} as Record<State, Cell>) },
  { family: "Card link", note: ".doc-card (a file in a conversation)", cells: states(({ attrs, cls }) => `<FORCE button type="button" class="doc-card ${cls}" ${attrs}><span class="format-badge">MD</span><span class="doc-card-name">슬라이드-구성.md</span></button>`, { selected: { attrs: 'aria-current="true"' } }) },
];

const cellHtml = (row: Row, state: State) => {
  const html = row.cells[state];
  if (html === null) return `<td class="na">없음</td>`;
  // The column's rows are drawn inside the real column scope (its tokens, its rules); "selected" in the
  // marks family shows the current row while the keyboard is elsewhere (the column has no focus there).
  if (row.context === "list-column") return `<td><aside class="sidebar look-scope nav-column slot-column"><div class="nav-scroll">${html}</div></aside></td>`;
  return `<td><div class="slot ${row.context ?? ""}">${html}</div></td>`;
};
const page = (theme: string) => `<!doctype html><html lang="ko" data-theme="${theme}"><head><meta charset="utf-8"><title>컨트롤 여덟 상태 (${theme})</title>
${sheets.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}
<style>
  /* The sheet's own frame: tokens only. */
  body { margin: 0; padding: var(--space-lg); background: var(--color-paper-2); color: var(--color-ink); font: 400 var(--text-sm)/1.45 var(--font-body); }
  h1 { margin: 0 0 var(--space-2xs); font-size: var(--text-lg); }
  p.lead { margin: 0 0 var(--space-md); color: var(--color-muted); }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th { padding: var(--space-xs); border-bottom: 1px solid var(--rule-ink); color: var(--color-muted); font-weight: 500; text-align: left; }
  th:first-child { width: 150px; }
  td { padding: var(--space-sm) var(--space-xs); border-bottom: 1px solid var(--color-rule); vertical-align: middle; }
  td.family b { display: block; font-weight: 600; }
  td.family span { color: var(--color-muted); font-size: var(--text-xs); }
  td.na { color: var(--color-faint); font-size: var(--text-xs); }
  .slot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs); min-height: 36px; }
  .slot.sidebar { padding: var(--space-2xs); background: var(--color-paper); }
  .slot.sidebar .side-row { width: 100%; }
  .slot.group-tabs { padding: var(--space-2xs) var(--space-2xs) 0; background: var(--color-paper); border-bottom: 1px solid var(--color-rule); }
  .slot.group-tabs .group-tab { display: inline-flex; align-items: center; border-style: solid; border-width: 1px 1px 0; }
  .slot.group-tabs .group-tab [role="tab"] { display: flex; align-items: center; gap: var(--space-2xs); border: 0; padding: var(--space-2xs) var(--space-xs); font: inherit; }
  .slot.group-tabs .group-tab-close { border: 0; background: none; color: inherit; padding: 0 var(--space-2xs); }
  .slot.menu-slot { display: block; padding: var(--space-2xs); background: var(--color-paper-2); border: 1px solid var(--color-rule); border-radius: var(--radius-card); box-shadow: var(--shadow-lift); }
  .slot.menu-slot .ui-menu-item { position: relative; }
  .slot.hig-composer, .slot.feature-dialog { position: static; inset: auto; width: auto; max-width: none; min-height: 36px; margin: 0; padding: 0; border: 0; background: none; box-shadow: none; transform: none; animation: none; }
  .slot.hig-composer .composer-bar { display: flex; margin: 0; }
  .slot.feature-dialog input, .slot.feature-dialog textarea { width: 100%; min-height: 32px; padding: var(--space-2xs) var(--space-xs); border-width: 1px; border-style: solid; font: inherit; }
  .slot .search-field { display: flex; align-items: center; gap: var(--space-2xs); height: 32px; padding: 0 var(--space-xs); border-width: 1px; border-style: solid; width: 100%; }
  .slot .search-field input { border: 0; background: none; outline: none; min-width: 0; flex: 1; font: inherit; color: inherit; }
  .slot .hk-seg { width: 100%; }
  .slot .check-row { gap: var(--space-2xs); }
  .slot .check-row.switch-row { width: 100%; }
  .slot .doc-card { width: 100%; }
  .slot-column { display: block; position: static; width: auto; min-height: 36px; padding: var(--space-2xs) 0; border-right: 0; }
  .slot-column .nav-scroll { overflow: visible; padding: 0 var(--space-2xs); }
</style></head><body>
<h1>컨트롤 여덟 상태: ${theme === "light" ? "라이트" : "다크"}</h1>
<p class="lead">가로는 상태(기본, 올림, 키보드 초점, 누름, 선택/현재, 꺼짐, 처리 중, 오류), 세로는 컨트롤 묶음. 모든 칸은 앱이 쓰는 그 클래스와 속성으로 그렸고, 올림, 누름, 초점은 브라우저에 강제로 걸었습니다.</p>
<table><thead><tr><th>묶음</th>${STATES.map((state) => `<th>${{ rest: "기본", hover: "올림", "focus-visible": "키보드 초점", pressed: "누름", selected: "선택, 현재", disabled: "꺼짐", loading: "처리 중", error: "오류" }[state]}</th>`).join("")}</tr></thead>
<tbody>${ROWS.map((row) => `<tr><td class="family"><b>${row.family}</b><span>${row.note}</span></td>${STATES.map((state) => cellHtml(row, state)).join("")}</tr>`).join("\n")}</tbody></table>
</body></html>`;

const TYPES: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html" };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const theme = url.searchParams.get("theme") ?? "light";
  if (url.pathname === "/states.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page(theme)); return; }
  const file = join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch();
try {
  for (const theme of themes) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(`http://127.0.0.1:${port}/states.html?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-force]" });
    for (const nodeId of nodeIds) {
      const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
      const value = attributes[attributes.indexOf("data-force") + 1] ?? "";
      await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: value.split(" ").filter(Boolean) });
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `states-${theme}.png`), fullPage: true });
    console.log(`states-${theme}.png: ${nodeIds.length} forced cells`);
    await page.close();
  }
  writeFileSync(join(outDir, "states.html"), page("light"));
} finally {
  await browser.close();
  server.close();
}
