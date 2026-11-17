// doc-default: the app opens documents 쪽 보기 first. A rig that opens a document and expects its EDITOR
// chooses "편집기로 바로 열기" before the page loads (a choice the rig made itself is kept).
// Used by scripts/fixtures/editor-first.ts (Playwright rigs) and read by the Python WebKit rigs.
(() => { try { if (window.top === window && !localStorage.getItem("workbench.docOpen")) localStorage.setItem("workbench.docOpen", "editor"); } catch (error) { /* storage refused */ } })();
