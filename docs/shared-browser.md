# Shared web tabs — U12/U13/U14 core

The desktop main window owns a native child webview for each `pageId`. A new tab always gets a new identity, even at the same URL. Moving or hiding a tab changes its rectangle, not its document or executor. Lightpanda remains the existing background research path. Opening a visible tab does not copy a Lightpanda DOM, login or pending form.

The implementation uses the existing Tauri 2.12.4 runtime with its child-webview feature. It does not bundle another Chromium. Windows/Linux use a separate app-local data directory per browser profile. macOS 14+ uses the existing WKWebsiteDataStore identifier through Wry, with a stable UUID saved per profile; earlier macOS uses an ephemeral store and omits `persistent_profile`.

The host records pages, profiles, command identities and outcomes in the existing local SQLite metadata. One main-window bridge reports real native pages and drains jobs independent of tab selection. Jobs are ordered per page and different pages can proceed concurrently. Lost execution results are `outcome_unknown`, retained and observed without replay. Host restart or actual page destruction interrupts the browser target; it never moves that task to Lightpanda or recreates a page under the old identity.

Each web tab can have a `Session.pageAgent` child with its own provider run and the selected main conversation as parent. Existing provider/browser approval cards still govern the supported browser commands. The child uses the normal `playwright-cli` spool, routed to this exact native page even when Lightpanda is absent. It neither activates nor blocks the main session. Common task projection, attention targets and the main conversation's next-request context include page children. Changing the global background browser engine preserves these page-child approval requests.

The new-tab menu and workspace menu open the shared page with address/history/profile controls and an independent AI panel. Explicit handoff waits for native acknowledgement. Switching tabs retains the page; the tab X or explicit close ends that exact page and its child work. A lost create response is reconciled by identity, not another create request.

Native actions use a document nonce, navigation revision and stable element references. A changed document or disconnected element rejects a stale action. Human control increments a generation. A trusted pointer/key/wheel event inside the page revokes AI control before the event acts; queued AI actions check the fence in the document. UI presence is not this authority. Native interaction timestamps also identify the pane the person actually used.

Untrusted remote pages receive no Workbench command capability. The capability binds trusted webview labels, not the containing main window. App commands are enumerated in `AppManifest`, including the previously omitted attention commands. Navigation is restricted to HTTP(S), excludes the local app origin, and cannot expose local files. The existing `office_browser` converter policy is unchanged. Popups are denied and offered as explicit new-page links.

## Downloads and site permissions

A person chooses the download directory for each page. The native engine writes a distinct filename without overwriting an existing file. Completed files up to 25 MB are hashed and can be copied into the existing immutable attachment/artifact flow; larger downloads stay available in the chosen directory. The page text output uses the existing page observation and provenance route.

The Windows adapter retains the real `ICoreWebView2DownloadOperation`, calls its `Cancel`, and waits for `StateChanged` with the completed/interrupted reason. The macOS adapter retains `WKDownload`, calls its `cancel` completion handler and also consumes the original finish/failure callbacks. The UI distinguishes a cancellation request from confirmed cancellation. Each native object maps to a download ID, so another download of the same URL cannot be cancelled or completed by mistake. Existing WebKitGTK download handling remains in place.

Windows permission requests use the SDK's `Uri`, `GetDeferral`, `SetState`, `SetHandled`, and `SetSavesInProfile(false)`. A runtime missing the last interface is denied as unsupported rather than silently allowing the engine to save a broader grant. macOS 12+ uses `WKUIDelegate`'s media-capture request and the initiating `WKFrameInfo.securityOrigin` for camera, microphone, and combined capture. Every other Wry navigation/UI callback is forwarded to its original delegate, including navigation policy, page load, popups and native file selection. No global delegate swizzle or replacement browser engine is used.

The application can remember an explicit allow/deny decision for exactly one browser profile, embedding top-level origin, actual requesting origin and permission kind. The native top-level URL must match the current page record, and pending decisions expire at 60 seconds or on navigation/close. The store uses a private atomic file under `browser-profiles/site-permissions.json`. There are no wildcard origins, cross-profile grants or inferred iframe origins. Linux's current registered permission-request API supplies no initiating origin, so Linux remains request-only and does not expose `permission_persistence`.

Deleting a saved decision explicitly reloads matching top-level-site tabs in that profile and returns their control to the person. macOS also stops current camera/microphone capture using the existing WK media-capture-state API. The UI warns that site inputs should be saved before this action. OS-level privacy permission still applies independently of the site's application decision.

Original API sources used: registered `webview2-com`/`webview2-com-sys` 0.39.1 `src/callback.rs`, `src/pwstr.rs`, `src/bindings.rs`; Wry 0.57.0 `src/webview2/mod.rs`, `src/wkwebview/class/wry_navigation_delegate.rs`, `wry_web_view_ui_delegate.rs`, `wry_download_delegate.rs`, `src/wkwebview/download.rs`; `objc2-web-kit` 0.3.2 generated `WKDownload.rs`, `WKDownloadDelegate.rs`, `WKUIDelegate.rs`, `WKFrameInfo.rs`, `WKSecurityOrigin.rs`, `WKWebView.rs`. These are the existing SDK implementations; no vendor source was modified.

## Scope still open

- AI-driven native file upload, restart recovery for in-progress downloads, and resumable/retry download controls. Human file selection retains the original native browser flow; cancelled downloads can be requested again from the website.
- Frame/shadow-DOM coverage, screenshots and richer browser commands. The current supported commands are listed by the wrapper's help; arbitrary JavaScript, cookies and local-file access are not exposed.
- Window reattachment/recovery after actual renderer loss, remote/mobile page viewing, and agent-desktop external-app operations.
- Actual native screen layout, login/IME, OS focus and hidden execution observations on Windows/macOS/Linux. A passing compile or DOM fixture is not this evidence.

## Focused implementation checks

- Host registry: four cases passed once, covering distinct same-URL targets, restart interruption, generation fencing, unknown receipts, and independent child/parent task identity.
- Exact `shared_browser.js` in an isolated Chromium fixture: distinct DOM nonces, retained target while another page is selected, trusted-human takeover, stale navigation rejection and no reference reuse for a replaced element passed. Script: `scripts/architecture-probes/shared-page-dom.mjs`.
- Host TypeScript passed after correcting an unused import and unsupported parameter-property syntax.
- Linux `cargo check --locked --offline` passed; an incremental compile covered the later interaction timestamp/unknown-result changes. This creates no installer or release bundle.
- Browser UI: five initial focused cases and one additional explicit-close case passed; web TypeScript passed. Source `1c5e688`, report `.superpowers/sdd/2026-11-09-workbench-integrated-release/task-U13-U14-ui-report.md`.
- A single exact nonce-initialization probe passed with `crypto.randomUUID` unavailable. The DOM adapter uses `getRandomValues` so HTTP intranet pages can initialize as well.

The later Windows/macOS cancellation and persistent-site-permission implementation has not run additional tests, type/native compile, app/installer builds, CI or external browsing, as explicitly requested. The earlier passing checks above do not cover these new adapters. Actual per-OS download cancellation, delegate forwarding, media privacy and persisted-grant behavior remain unverified until the final integrated checks and device observations.

Research basis: `research:rr-8ee5519df2391bc87774abc748cec9f6:b536f3d644acbc942964beda941d1582d39b893babbd4d40700ee1b0e5fff228`. Execution scope and original requirement labels remain in the integrated plan and coverage map. Full 0.4.0 remains incomplete.
