# Model menus in compact chat panes

The user reported that choosing a model cuts off the menu at the web chat's left
edge and blanks the native web page. The model menu was right-aligned to a small
button inside an overflow-hidden pane. Native presentation also hid every web
page for any DOM popup anywhere in the window.

Model, effort and custom-ID popups now measure their viewport and clipping
ancestors, limit their size, and move within those bounds. They update on resize,
scroll and content size changes. Existing focus, keyboard selection and engine
refresh behavior remains in the shared Popover.

Native presentation keeps pages visible beside non-overlapping menus and local
forms. Actual overlap hides the affected page; modal dialogs retain whole-window
blocking.

## Evidence and installation

- Research plan: `research:rr-8718bbf2e984d04fa8e6724d37e39dcc:942966d6839ff3bf3df0abcced0b3b198abe8c780071f34cef52f1384404fff6`.
- Previous provider-control scope: `research:rr-2efe2a502c682cf43f1fbeddca892d06:1f73e5f73b3f632f8384314d9d2720688ec9ba963148f9ea7fadd0b1091bd4d4`.
- ModelPicker/shared-browser regressions: 23 passed. Web and root TypeScript
  checks and frontend build passed.
- `scripts/app-e2e/model-menu-run.ts`: actual Linux WebKitGTK menus fit in
  368.625px and 300px panes, including resizing while open, effort and custom-ID
  forms. The native fixture remained visible in private X11 screenshots; model
  and custom-ID selections persisted to the child session. Stand-in engines;
  no AI turn. Result: `.hallmark/model-menu-fix/evidence-x11/result.json`.
- The first test probe tried to replace Tauri's non-writable invoke function.
  It produced no visibility observations; the replacement probe samples the
  actual native page in an X11 root screenshot. This is not a product failure.
- Installed as local patch `model-menu-fit-20261111` on 0.4.1, preserving the
  existing native/host binaries, office/design resources and standalone Office
  registration. Installation receipt uses the observed `host/host.mjs` entry;
  an earlier filename assumption failed before the installation swap.
- Relaunch confirmed the updated frontend is served. All 9 sessions and 340
  conversation items remain; original item rows are unchanged. Local rollback
  copy: `~/.local/opt/achmage-workbench.previous-20261111-model-menu`.

Windows/macOS native execution was not tested on this Linux laptop. Both changes
are shared frontend code; no new official release is claimed.
