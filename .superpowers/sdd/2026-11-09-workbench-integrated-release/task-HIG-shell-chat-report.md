# U02 · U03 · U04 — HIG common UI, shell and conversation

Implemented in `feat/workbench-040` on 2026-11-09. This report belongs to the UI implementation commit; its final SHA is returned to the parent release task. No remote write, live DB, vault, existing application process, provider invocation or additional agent was used.

## Product behavior

- `ContextMenu` and `Popover` use the same actual-item keyboard navigation: Arrow keys, Home/End, Escape and focus restoration. Chosen options expose checked state. Disabled options retain keyboard-readable reasons and cannot execute. Popovers containing a form expose a dialog and ordinary buttons. IME and background approval shortcuts do not consume these controls' events.
- The toolbar, sidebar, project page, project context menu, group tabs, command palette and existing creation shortcut share one command catalog. Document creation keeps the chosen project and valid workspace; a different project's workspace is never borrowed. Existing contracts expose eight blank Office formats (`docx`, `pptx`, `xlsx`, `hwpx`, `pdf`, `markdown`, `html`, `xmind`) plus doory, nine creation choices in total. Every format calls the existing actual creation API. The target workspace label/path appears in the dialog.
- Session creation keeps workspace scope. The visual grouping command is explicitly **새 정리 폴더**. It opens the existing sidebar inline form; it does not imply creating a filesystem directory. Physical workspace-folder creation remains a host-wiring follow-up.
- Tabs and the current location display their kind (project, conversation, document). Existing title/expand distinction, document focus/return, pane splitting and stable saved view/tab IDs remain on their existing paths. The named **작업** toolbar button opens the parent's `TaskPanel`; opening its source uses the existing session and transcript target path. No unverified count is shown.
- Transcript tool details fold beneath an execution disclosure while final answers, failure summaries, plans and approvals remain visible. A searched tool is mounted before scrolling and its target flashes. A message ID plus pixel offset preserves the reading position through history prepend, content resize and nested detail changes. Output following resumes only near the bottom. Hidden panes do not overwrite the current position.
- Composer drafts are keyed independently from follow-output state. Completing an asynchronous send does not clear text entered afterward, replace another tab's draft or steal that tab's focus. Composition input blocks send until composition ends.

## UI token roles

`styles.css` maps the neutral control layer to the existing chrome colors: surface, hover, selection, border, focus, disabled text and danger. Named menu/sheet/dialog surfaces consume these roles, with bounded overflow, coarse-pointer hit areas and reduced-motion/transparency handling. These rules do not target document canvases or iframes. Existing brand, typography, persisted appearance values and the icon set are preserved.

## Changed files

- Shared controls: `components/ContextMenu.tsx`, `Popover.tsx`, `controls/menu-navigation.ts`, `ModelPicker.tsx`, `styles.css`.
- Shell/create: `App.tsx`, `create-actions.ts`, `NewDocumentButton.tsx`, `Sidebar.tsx`, `GroupTabs.tsx`, `project/ProjectView.tsx`, `nav/NavPane.tsx`, `nav/TreeSection.tsx`, `shortcuts.ts`.
- Reading/drafts: `Transcript.tsx`, `conversation/reading-anchor.ts`, `Composer.tsx`, `panes.ts`.
- Focused behavior checks: new `controls.test.tsx`, `create-actions.test.tsx`, `reading-anchor.test.tsx`; updated `ui.test.tsx`, `ModelPicker.test.tsx`, `OfficeFileMenu.test.tsx`.
- Parent-owned API, TaskPanel, task styles, host/contracts, search implementation, release workflow/version and root design/research documents are excluded from this commit.

## Verification ledger

One focused bundle ran with two workers:

```sh
npm exec -- vitest run apps/web/src/components/controls.test.tsx apps/web/src/create-actions.test.tsx apps/web/src/conversation/reading-anchor.test.tsx apps/web/src/components/Transcript.position.test.tsx apps/web/src/components/ui.test.tsx apps/web/src/components/ModelPicker.test.tsx apps/web/src/components/OfficeFileMenu.test.tsx apps/web/src/tabs.test.tsx --maxWorkers=2
npm exec -- tsc -p apps/web/tsconfig.json
```

Initial tests: 26 passed, 5 failed. All failures were isolated to the new catalog expectation (nine actual formats, not ten), the un-clamped synthetic scroll fixture and old `menuitem` selectors for a form popover that now correctly exposes dialog buttons. Initial web tsc found the combined `folder | project` union member and an incomplete Workspace test fixture; both were corrected. There were no other web tsc diagnostics at that point.

After those source/fixture corrections, only the three failed files were rerun:

```sh
npm exec -- vitest run apps/web/src/create-actions.test.tsx apps/web/src/conversation/reading-anchor.test.tsx apps/web/src/components/OfficeFileMenu.test.tsx --maxWorkers=2
```

Result: three files, ten tests passed. Together with the five unchanged passing files, all 31 selected behavior tests pass. No full search suite, performance framework, review loop or multi-screen matrix was repeated. The parent is changing the attachment API concurrently and explicitly owns the final combined web tsc, candidate build and one browser route; this report does not claim those pending checks passed.

Not directly verified here: native Korean IME integration, native file dialogs, real provider streaming, browser image decode timing, touch hardware and the final combined packaged build. Resize behavior uses real Transcript wiring with synthetic browser geometry and a ResizeObserver fixture. No performance or Apple-native conformance claim is made.

## Context and research

- Context used: `context-eb87f7d899e04bb8b9cf195329b4d33d`.
- Exact research read: `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:ebbeda9b61453b7fc6a24c4f8eda0c7635f4b70f671d34812f420a8b37047d02` (R24 conversation-first source targeting and R25 implementation-first execution).
- User correction applied: “검증하고 또 확인검증하고 이런거 제발 하지마 … 구현을 우선으로 해”. Existing passing checks were not rerun. The parent owns the next integrated checkpoint.
- A research-record request for the ordinary first-check corrections was rejected with `Unknown research request fields`. Per the parent's subsequent instruction, the exact first-check outcomes and changed fixture/type evidence are retained in this ledger; no repeated research write was attempted. No research conclusion or R label was overwritten.

Suggested single candidate route: toolbar **새로 만들기 → 새 문서·디자인 → 새 Markdown 문서 → confirm shown workspace → 만들고 열기**. The creation dialog itself and all nine format APIs were covered by the focused test.
