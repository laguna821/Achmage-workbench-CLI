# Shared web tabs — U12/U13/U14 core

The desktop main window owns a native child webview for each `pageId`. A new tab always gets a new identity, even at the same URL. Moving or hiding a tab changes its rectangle, not its document or executor. Lightpanda remains the existing background research path. Opening a visible tab does not copy a Lightpanda DOM, login or pending form.

The implementation uses the existing Tauri 2.12.4 runtime with its child-webview feature. It does not bundle another Chromium. Windows/Linux use a separate app-local data directory per browser profile. macOS currently uses an isolated ephemeral store and deliberately omits `persistent_profile`; persistent WK stores remain to implement.

The host records pages, profiles, command identities and outcomes in the existing local SQLite metadata. One main-window bridge reports real native pages and drains jobs independent of tab selection. Jobs are ordered per page and different pages can proceed concurrently. Lost execution results are `outcome_unknown`, retained and observed without replay. Host restart or actual page destruction interrupts the browser target; it never moves that task to Lightpanda or recreates a page under the old identity.

Each web tab can have a `Session.pageAgent` child with its own provider run and the selected main conversation as parent. Existing provider/browser approval cards still govern the supported browser commands. The child uses the normal `playwright-cli` spool, routed to this exact native page even when Lightpanda is absent. It neither activates nor blocks the main session. Common task projection, attention targets and the main conversation's next-request context include page children.

Native actions use a document nonce, navigation revision and stable element references. A changed document or disconnected element rejects a stale action. Human control increments a generation. A trusted pointer/key/wheel event inside the page revokes AI control before the event acts; queued AI actions check the fence in the document. UI presence is not this authority. Native interaction timestamps also identify the pane the person actually used.

Untrusted remote pages receive no Workbench command capability. The capability binds trusted webview labels, not the containing main window. App commands are enumerated in `AppManifest`, including the previously omitted attention commands. Navigation is restricted to HTTP(S), excludes the local app origin, and cannot expose local files. The existing `office_browser` converter policy is unchanged. Popups are denied and offered as explicit new-page links.

## Scope still open

- Native file upload, download history/acceptance, site permission UI and persistent macOS profiles.
- Frame/shadow-DOM coverage, screenshot/output artifact connections and richer browser commands. The current supported commands are listed by the wrapper's help; arbitrary JavaScript, cookies and local-file access are not exposed.
- Window reattachment/recovery after actual renderer loss, remote/mobile page viewing, and agent-desktop external-app operations.
- Actual native screen layout, login/IME, OS focus and hidden execution observations on Windows/macOS/Linux. A passing compile or DOM fixture is not this evidence.

## Focused implementation checks

- Host registry: four cases passed once, covering distinct same-URL targets, restart interruption, generation fencing, unknown receipts, and independent child/parent task identity.
- Exact `shared_browser.js` in an isolated Chromium fixture: distinct DOM nonces, retained target while another page is selected, trusted-human takeover, stale navigation rejection and no reference reuse for a replaced element passed. Script: `scripts/architecture-probes/shared-page-dom.mjs`.
- Host TypeScript passed after correcting an unused import and unsupported parameter-property syntax.
- Linux `cargo check --locked --offline` passed; an incremental compile covered the later interaction timestamp/unknown-result changes. This creates no installer or release bundle.
- Browser UI checks and web TypeScript are recorded in the matching execution report when complete.

Research basis: `research:rr-8ee5519df2391bc87774abc748cec9f6:b536f3d644acbc942964beda941d1582d39b893babbd4d40700ee1b0e5fff228`. Execution scope and original requirement labels remain in the integrated plan and coverage map. Full 0.4.0 remains incomplete.
