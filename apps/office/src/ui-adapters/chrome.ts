import stylesheet from "./chrome.css?raw";
import type { OfficeUiFormat, UiTheme } from "../ui-adapters.ts";

// These are renderer UI surfaces, read from the pinned Ieum/rhwp source. Never
// include document pages, canvas containers, preview panes or chapter frames.
export const officeChromeSelectors: Record<OfficeUiFormat, string[]> = {
  word: [".ribbon", ".status-bar", ".nav-pane", ".comments-pane", ".styles-pane", ".find-panel", ".file-menu", ".ctx-menu", ".ctx-submenu", ".rb-font-family-menu", ".rb-font-size-menu", ".style-gallery-menu", ".spacing-menu", ".paste-menu", ".table-autofit-menu", ".modal", ".font-dialog", ".table-properties-dialog", ".table-small-dialog", ".zoom-dialog", ".print-dialog", ".equation-modal", ".list-define-modal"],
  hangul: [".hwp-topbar", ".hwp-notice", ".memo-panel", ".memo-modal", "#menu-bar", "#icon-toolbar", "#style-bar", "#status-bar", ".menu-dropdown", ".context-menu", ".tb-split-menu", ".sb-dropdown-menu", ".font-picker-menu", ".dialog-wrap", ".find-dialog", ".zoom-dialog"],
  slides: [".ribbon", ".status-bar", ".format-pane", ".anim-pane", ".comments-pane", ".find-panel", ".file-menu", ".ctx-menu", ".ctx-submenu", ".rb-menu", ".rb-font-menu", ".rb-size-menu", ".rb-fill-menu", ".rb-anim-menu", ".modal", ".print-dialog", ".chart-data-modal", ".chart-type-modal"],
  sheets: [".excel-header", ".ribbon", ".status-bar", ".find-replace-panel", ".chart-format-pane", ".pivot-fields-pane", ".threaded-comments-pane", ".note-pictures-pane", ".table-style-panel", ".sheet-tab-menu", ".sheet-tab-menu-pop", ".chart-menu", ".menu-select-drop", ".modal", ".cells-dialog", ".format-cells-dialog", ".function-args-dialog", ".insert-function-dialog", ".name-manager-dialog", ".sort-dialog", ".pivot-dialog", ".link-dialog", ".sheet-tab-dialog", ".equation-dialog", ".icons-dialog", ".select-data-dialog", ".recommended-charts-dialog", ".print-dialog", '[data-u-comp="ribbon-toolbar"]', '[data-u-comp="ribbon-header-menu"]', '[data-u-comp="slide-tab-bar"]', '[data-u-comp="sidebar"]', '[data-u-comp="find-replace-dialog"]'],
  markdown: [".ribbon", ".status-bar", ".find-panel", ".fm-panel", ".md-block-menu", ".md-theme-menu", ".slash-menu", ".table-menu", ".redact-menu", ".redact-dialog", ".image-host-dialog"],
  html: [".ribbon", ".status-bar", ".hx-panel", ".rb-menu", ".redact-dialog"],
  pdf: [".ribbon", ".status-bar", ".pdf-outline-pane", ".pdf-annot-pane", ".pdf-search-bar", ".pdf-annot-menu", ".pdf-markup-menu", ".pdf-opacity-menu", ".thumb-menu", ".rb-menu", ".pdf-modal", ".pdf-pwd-dialog", ".pdf-cert-dialog", ".pdf-sig-dialog", ".pdf-convert-dialog", ".pdf-translate-dialog", ".pdf-ai-read-dialog", ".pdf-textedit-bar", ".pdf-note-bar", ".pdf-hl-bar"],
  mindmap: [".ribbon", ".mm-theme-panel", ".mm-note-panel", ".context-menu", ".menu-list", ".mm-modal"],
  epub: [".ribbon", ".epub-toc", ".epub-search-form", ".epub-search-hits", ".epub-turn-bar", ".epub-status", ".file-menu", ".bt-dialog", ".bt-chapter-tools"],
};

// Even a document containing a class named "ribbon" must keep its own styling.
const content = ':is([contenteditable="true"], .ProseMirror, .tiptap, .cm-editor, .doc-page, .doc-pages, .page-content, .pane-preview, .print-preview-pane, .print-preview, .epub-reader iframe, .mm-node, .list-dialog-preview, .style-dialog-preview, [data-u-comp="editor"], [data-u-comp="sheets-formula-editor"])';

/** Stylesheet-only integration: no editor remount, control replacement or body font. */
export function installOfficeChrome(doc: Document, format: OfficeUiFormat, theme: UiTheme, documents: () => Document[]) {
  const skins = new Map<Document, { style: HTMLStyleElement; format: string | null; theme: string | null }>();
  // The editor origin serves /office assets only, independently from the main app origin.
  const fontUrl = new URL("/office/fonts/pretendard/PretendardVariable.ttf", doc.location.href).href;
  const root = `html[data-wb-office-format="${format}"]`;
  const safe = `:not(:where(${content}, ${content} *))`;
  const chrome = `${root} :is(${[...officeChromeSelectors[format], ".ai-panel-header", ".ai-composer", ".ai-model-picker"].join(", ")})${safe}`;
  // Exclude preview content from descendant controls as well as surface roots.
  const css = stylesheet.replaceAll("__WB_ROOT__", root).replaceAll("__WB_CHROME__", chrome).replaceAll("__WB_SAFE__", safe).replaceAll("__WB_FONT_URL__", JSON.stringify(fontUrl));
  function remove(source: Document) {
    const skin = skins.get(source); if (!skin) return;
    skin.style.remove();
    for (const [name, value] of [["data-wb-office-format", skin.format], ["data-wb-office-theme", skin.theme]] as const) {
      if (value === null) source.documentElement.removeAttribute(name); else source.documentElement.setAttribute(name, value);
    }
    skins.delete(source);
  }
  function sync() {
    const current = new Set(documents());
    for (const source of skins.keys()) if (!current.has(source)) remove(source);
    for (const source of current) {
      if (!skins.has(source)) {
        const style = source.createElement("style"); style.dataset.wbOfficeChrome = format; style.textContent = css;
        skins.set(source, { style, format: source.documentElement.getAttribute("data-wb-office-format"), theme: source.documentElement.getAttribute("data-wb-office-theme") });
        (source.head ?? source.documentElement).append(style);
      }
      source.documentElement.setAttribute("data-wb-office-format", format);
      source.documentElement.setAttribute("data-wb-office-theme", theme);
    }
  }
  sync();
  return { sync, setTheme(next: UiTheme) { theme = next; sync(); }, dispose() { for (const source of skins.keys()) remove(source); } };
}
