# U13/U14 shared browser UI core

Date: 2026-11-09. Scope: apps/web shared native browser driver, page surfaces and independent page AI conversation. Host registry, provider route, contracts and native adapter are root-owned in `2df5f41`.

## Implemented

- The common + catalog includes **새 웹 탭…** and the workspace picker includes **웹 탭 열기…**. The creation dialog selects an existing workspace and browser profile, creates a profile, validates an http(s) address without embedded credentials, and lists previously opened pages. Profile/address cloning is an explicit new page request with a new UUID. Moving an existing tab keeps its page ID.
- Browser tabs show a URL field, back/forward, reload/stop, profile/new-tab entry, blocked-popup URLs with explicit new-tab actions, AI conversation toggle, control status, **내가 조작하기**, and **페이지 종료**. Separate-window/non-desktop views explain the main desktop window requirement.
- `SharedBrowser` owns one stable sessionStorage driver ID in the main desktop window. A serial approximately 500 ms driver heartbeat observes native pages and sends queued results; failed native listings never become an empty page list. Jobs execute in order within each page and concurrently across pages, independent of visible tabs. Accepted job IDs are not executed twice. IPC failures report `outcome: unknown`; unacknowledged results are retained for the next poll.
- Host page creation and native creation are separate. Lost host responses reconcile by `pageId === requestId`; a pending creation is persisted and its explicit result-check action only reads the host list. A native create is attempted once per recorded page. Missing/interrupted pages are not silently recreated. Unknown human actions retain their original receipt and use GET jobs; a null receipt is handled explicitly. The person may finish checking an unknown result without resending it. API waits have finite deadlines and never retry mutations automatically.
- Each mounted visible viewport contributes its measured CSS-pixel rectangle. Inactive tabs, hidden panes and DOM dialogs/menus/popovers hide native surfaces without destroying pages. Native presentation calls are serialized. Actual native `interactionAt` updates select the existing corresponding pane/tab without moving DOM focus; newer DOM input wins over a delayed native observation.
- The AI panel uses the existing Composer, Transcript, approval callback, queued-send/cancel and interrupt paths. Creating/opening the child conversation does not grant control or send a request. **AI에게 맡기기** explicitly waits for the native control generation/owner acknowledgement, then enables sending to that page's independent session. Direct native page input can immediately take human control via the root adapter. Original-conversation navigation remains available.
- Main-session selection/fallback excludes page agents. Navigation groups them under **웹 탭 AI**. Session, search-hit, task and attention opening routes the exact page child/item into BrowserView instead of selecting the main conversation. This UI path does not render the legacy Lightpanda BrowserPill or require its installation.
- Tab X, close-pane and explicit page termination use one close operation: take human control if necessary, await the native fence, then close that exact page. Duplicate close requests share one promise. A closed, absent or interrupted page is a no-op. Ordinary tab switching, moving, workspace layout changes, unmount and editor flushing only hide; they do not terminate a page. The existing Office leave/save behavior remains in place.

## Focused evidence

1. `npx vitest run apps/web/src/browser-state.test.tsx`: **5 passed**, one file, 1.07 s. Covers explicit page-child handoff/send and main-session preservation, unknown action receipt lookup without replay, independent page execution/order and unknown result acknowledgement, native bounds/modal hiding/lost-page handling, lost create-response recovery and tab identity while moving.
2. The subsequent close-guard integration added one new case. `npx vitest run apps/web/src/browser-state.test.tsx -t 'closes the native page only'`: **1 passed, 5 skipped**, 800 ms. Covers no-close flush/unmount, human takeover before native close, and deduplication of footer/tab close. The five previously passing cases were not repeated.
3. `npm run typecheck --workspace @workbench/web`: the first run found only incomplete test fixture casts (new browser Session fixture and the existing ProjectsMode.selection Work fixture). Required fields were filled explicitly. The failed typecheck alone was rerun and **passed**. No behavior suite was repeated for those fixture-only corrections.

The focused UI file injects native/host transports and isolates Transcript/Composer rendering. It checks the real new driver and component event wiring, not an OS webview E2E. No production/installer build, CI dispatch, additional reviewer/agent, broad test run, performance loop, external provider call, existing app process operation or live DB/vault access was performed.

## Remaining scope

- Native OS visual/E2E behavior, real-page login persistence, actual native focus/geometry and external-site behavior remain platform integration evidence. This report does not mark all U13/U14 requirements complete.
- Upload/download and site-permission management are explicitly unavailable in this core. Browser profile rename/delete, artifact handoff and general agent-desktop workflows are not implemented here.
- macOS currently lacks the persistent-profile capability and uses the root adapter's nonpersistent page behavior; the page footer states that login state is not retained across restart when that capability is absent.
- Main desktop window only owns native surfaces. Detached windows show the explanatory view. There is no renderer-side fallback to Lightpanda or a replacement browser after native-page loss.

## Context and ownership

The current implementation cadence and U13/U14 plan sections, frozen browser contracts, current host API/native message definitions and existing App/tabs/leave-guard/Composer/Transcript code guided implementation. Context `context-3bcd1460cfdd4b8aa25e4ea79342c30d` and its bounded research preparation returned unrelated evidence; the miss was recorded. The previously read exact cadence revision is `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:fb76a28f44c3dbf717a6aee28d89790d4677707904b2b9829dcd5edd1a4cb89c`. Root's current R34 scope/result was read from exact revision `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:837c9a4192c8057bb92671d9f9f9a0973fd1b9b9baaf03714885fd96c4e2dd71` (matching source/index hash, not stale).

Owned changes: App, sharedBrowser API methods, browser-state/component/style/test, tab/create/workspace entries, page-session routing/grouping and the explicit Work test fixture fields. Host/contracts/desktop/STATUS/root docs are not included in this UI commit. The untracked vendor link is excluded.
