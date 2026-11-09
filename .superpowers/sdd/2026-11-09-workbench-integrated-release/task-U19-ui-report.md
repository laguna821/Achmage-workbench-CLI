# U19 attention UI

Date: 2026-11-09. Scope: web notification center, host client/presence, legacy deduplication and exact original-message navigation. Host producer, contracts and native adapter are root-owned in `9c56e75`.

## Implemented

- The shell has a visible **알림** button and unread count. AttentionCenter displays completion/failure/input-needed kind, read status, time and local project/session titles. It supports unread filtering, explicit mark-read, refresh and opening the original target. API and delivery errors remain visible. The native dialog restores focus when dismissed.
- AttentionInbox consumes App's existing snapshot and SSE stream, with no second connection or inbox polling. Sequence/version fencing discards delayed reads, merges read/resolution acknowledgements monotonically and resets on host/epoch changes. `attention.changed` causes a live refresh. Old hosts without snapshot.attention retain the existing completion/status path; supported hosts do not send those notifications again.
- Presence sends this window's distinct clientId, active session and focus/visibility on changes, a 15-second heartbeat and visible:false on departure. It is separate from execution authority. Session changes use the same serialized sender.
- A fallback OS delivery is claimed only for unread `unavailable` events. Unknown claim results are not retried. Payloads use host generic title/body and opaque attentionId. Linux uses root's notify_attention command; only an explicit unsupported adapter result permits a browser Notification fallback, whose click resolves the same attentionId. Legacy OS notifications now use generic copy too; local toast/context titles remain local.
- Native warm events and take_open_attention cold-start receipts resolve through the host target endpoint. Warm events also drain the native pending id. The target's host, task, work, session and source item are checked before navigation; absent local metadata is refreshed. Read acknowledgement happens after the navigation callback and never calls approval APIs.
- Document targets retain the editor and writer registration. A separate ConversationSheet opens the exact referenced child conversation over the document, including Office editing, and forwards the original item to Transcript's existing focus path. It does not switch the editor's current agent or remount its iframe. The sheet focuses its close control and scopes Escape to itself.
- Existing project-folder, service and task-panel wiring remains in place.

## Focused evidence

Ran once: `npx vitest run apps/web/src/components/AttentionCenter.test.tsx`.

Result: **6 tests passed**, 1 file passed, 809 ms. The file covers mark-read without resolving approval, overlay focus return, exact document/child/item target and foreign-host rejection, delayed read/snapshot handling plus live refresh, old-host completion fallback gating, once-only generic fallback including an unknown result, 15-second focus/session/visibility presence and departure, and ConversationSheet forwarding the exact item without answering approval.

ConversationSheet's Transcript is isolated in this focused UI check; its original scrolling implementation is reused. Full DocumentView/native visual behavior, actual system notification permission/click delivery, Windows/macOS native click routing and mobile push remain integration/platform evidence, not claimed PASS here. See root's `docs/service-notifications.md` for native limits.

No production build, installer CI, additional typecheck, broad suite, reviewer, performance loop, live DB/vault read or existing process operation was run. No failed test or rerun occurred.

## Context and ownership

Read the current execution correction and U19 plan section, current attention contracts, existing completion/native notification paths and document transcript surfaces. Context `context-eacc2f50b5e04b9b8b5fc897f5eccd58` and bounded research preparation did not supply relevant U19 implementation evidence. The current exact implementation-cadence revision previously read remains `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:fb76a28f44c3dbf717a6aee28d89790d4677707904b2b9829dcd5edd1a4cb89c`; current parent instructions and source contracts govern concrete integration. The retrieval miss was recorded.

Owned files: App, api attention methods, completion-notifications, AttentionCenter component/test/style, and approved minimal DocumentView/ConversationDrawer focus wiring. Host, contracts, desktop, STATUS, plan and release files remain root-owned.
