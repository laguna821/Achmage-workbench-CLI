# 0.4.0 browser usability hotfix

User source: current session 01a187dc-c850-7991-93c0-aa60b50f9a26, 2026-11-10 browser screenshots and correction decision-a507c4108dc8604712feb1b44bf8bfe6acb08f1cdab91123196d47e6f0215d30.

Exact baseline research: research:rr-f4d0ed7e4102bb97df4ec02d1f2b1814:0260daee8b6a36261909f5ed57472e3e9ead89f24fb97af83e366d1e4d48ded9. Later user corrections decision-43d0dcb27ecd25c673b0fbb1bc34c2b5ac03f63d3aac84d3c049d1473d331ec2 and decision-c828a89a3f2e0ccaed8e4290783aeb192a5cbdbbf32b28d3b9db4c92b46b4edd apply.

## Global constraints
- Fix the reported real workflow and update this computer; preserve user sessions, documents, browser profiles and independent Office installation.
- Reuse the existing shared native browser and session routing. Lightpanda remains the background engine; visible-page requests must act on that same visible page.
- Implementation first. Only focused regressions, one integrated build and a native workflow check; no repeated broad test/review loops. This explicit user override takes precedence over generic skill gates.
- Keep control-generation/document fences. Sending an explicit page request grants its page session control; a real human page interaction still takes control back.
- Do not automatically replay uncertain browser actions. Report failures as failures.
- Existing feature branch is isolated; no main merge. No destructive cleanup or forced shutdown of live user work.

### Task 1: Simple browser entry and usable page conversation
Own frontend components/styles only: BrowserView.tsx, browser.css, App.tsx and relevant home/create-action components. Do not edit browser-state.ts, host, contracts or Rust.
- A home search/address field opens a web tab directly. New web tab creates an empty tab with inherited workspace/default profile, without forcing the workspace/profile modal; create a default project/workspace through the existing create flow when needed.
- The home/blank tab has one Search/Ask input. Ask starts the main Codex/Claude task, Search navigates. Page chat is collapsed initially and toggles as a full-height right column from the top-right button.
- Blank tabs use about:blank; show a simple centered search/address entry. Root will make browserUrl accept blank, domains and search terms and enable about:blank in host/native validators.
- Keep profile/settings in secondary controls, not the default opening flow. Avoid path-heavy forms and implementation warnings in the primary product UI.
- Compact navigation/address toolbar; web viewport fills the remaining pane, AI side chat uses the full adjacent height and input stays at its bottom. Remove persistent control explanation/footer rows. Keep actual errors and pending confirmations visible when relevant.
- Composer stays usable without a separate grant button. Before sending/steering/dispatching a queued request, await browser.control(pageId, session.id), then send to that same session; handle failures visibly. Navigation initiated by the user claims human control before acting. Human page clicks remain native-controlled.
- Preserve independent page sessions/parent orchestration, history, downloads/permission access, modal native-surface hiding, and idempotent create request handling.
- Add only targeted frontend regressions for direct entry/blank creation and grant-before-send if existing harness supports it. Do not run the full test suite or production build.

### Task 2: Native embedding and real visible-page actions
Root owns browser-state.ts, native Rust/JS, host registry/browse/session routing and contracts. Fix GTK child placement, top-frame URL/observation handling, about:blank/search inputs, and any evidenced execution/receipt errors. Check source and the user's failed page-session transcript without altering it.
- Main agents can explicitly open a real shared tab with tab-open; following commands stay on that page. The human can select its background tab. Default Lightpanda research remains independent; a copy of a URL is never presented as the same controlled page.

### Task 3: Build, install and narrow real acceptance
Build the integrated frontend/host/native app once after focused checks. Update the current user installation with rollback retained, gracefully restart only when no user jobs/unsaved editor work block it. Check an actual native blank/search tab, correct page/chat bounds and a visible search-field fill with a result tied to that page. Record exact checked scope and any remaining limitation.
- Latest user instruction expands this to Windows/macOS as well. Run the same native-driver scenario on all three OSes and common UI regressions; distinguish those results from full installed-app UI acceptance. The native example/CI must use the exact production shared_browser module, temporary profiles and no live user data.

## Hallmark / Impeccable finish result

Current implementation and bounded OS acceptance: [design finish result](../../design/2026-11-10-design-finish.md). Exact R8/R9 revision: `research:rr-d444ad1fc3329b8db7a04a08c16d9489:4eb15dcba62ba1bdcf3021d233f0cf3da4fa537d0431cb166765efb5e05adaad`. The design-finish phase did not publish or install an installer; earlier plan statements above describe their original point in time.
