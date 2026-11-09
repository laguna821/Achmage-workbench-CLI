# U03/U10 actual directory and navigation UI

Four source-confirmed gaps are connected to product behavior. Existing S0 ranking/index/cancellation, original search source bytes, vault back/forward/up, Bases filtering/import/export and graph physics are retained.

## Product changes

- SearchPalette snapshots the original focus, input caret and reading scroll/visible transcript anchor before taking focus. Escape, outside dismissal and ordinary unmount return to that location. Opening a result, command or saved view explicitly gives up that restoration, preserving the destination's focus. Existing IME handling and per-query aborts remain.
- The common creation catalog has a separate **프로젝트 안 새 폴더…** action when a real workspace is known. The dialog shows that workspace's label/root and posts a relative path through the one permitted API method, `POST /api/workspaces/:workspaceId/directories`. Pending submits are deduplicated; traversal/absolute paths are rejected; host errors retain the entered path. Success shows the actual returned path with native folder-open or browser path-copy. The parent-owned endpoint publishes the existing `workspace.upserted` event. Sidebar organization remains **정리 폴더**, including remaining create labels.
- Projects/Bases cards, table rows, list rows and board cards expose checkboxes and Shift range selection. Selection survives filtering and shows the count outside the current view. Select-current-results and clear act on selection only. **선택 항목 보관…** reveals the exact count, then calls the existing archive API for each selected active project. Partial failures report their errors and keep only failed items selected. Selecting/filtering does not call note/property writers; existing board movement remains separate.
- The project graph has one Tab entry point and directional nearest-node navigation plus Home/End. Enter/Space still execute the original node action. Revealing an offscreen keyboard target pans the graph without resetting scale or changing simulation positions.

## Focused check ledger

```sh
npx vitest run apps/web/src/components/SearchPalette.focus.test.tsx apps/web/src/components/NewDirectoryDialog.test.tsx apps/web/src/components/project/ProjectsMode.selection.test.tsx apps/web/src/components/project/graph-ui.test.tsx
```

First run: 11 passed; four stopped on fixture assumptions. Search fixtures omitted jsdom's missing `scrollIntoView`; the table fixture attempted to type into the existing collapsed filter before opening it. These setup/actions were corrected. Only the four affected cases ran again:

```sh
npx vitest run apps/web/src/components/SearchPalette.focus.test.tsx apps/web/src/components/project/ProjectsMode.selection.test.tsx -t 'restores the original|leaves focus|does not close|keeps selection through'
```

Four passed, three already-passing cases skipped. Combined focused result: **15 passing behaviors**. These cover actual component callbacks and original graph rendering/pointer behavior; no broad suite, production build, installer CI or additional reviewer ran for this unit. The parent independently implemented and checked real directory creation.

## Ownership and limits

This commit owns web creation/search/project/navigation UI, its focused tests/styles, the graph viewport helper, and one `api.ts` method. Host directory code/contracts, imported-history UI, release/build changes, original vendor source, search index/projection and human vault files are excluded.

The browser component fixtures use synthetic state and API fakes. No live vault/DB, external provider or OS filesystem was accessed by this UI unit. Bulk archive uses existing host behavior and displays its result; it does not add a new filesystem delete command. A directory appears through the existing workspace event flow and result path; the product's project document list remains an artifacts list.

Context `context-99fa76c046cc445f8d932f1ec51b7bcf` was retrieved before the candidate and materially used. Exact Fast Find history read: `research:rr-236ff3048f29782b4eb36a197c2932df:703f3cac08a9b982814fbf0651c1aa06f0b767240121c50403984087cd8e8613`; current R24–R29 reference read: `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:cf2f7cdbc8b7d9f5d0f08e1bd8522a8edcc52ca9e77797dd42e2e7b94bffe481`.

The latest parent-relayed user correction is retained: “기능 추가하고 빌드하고 기능 추가하고 빌드하고 그게 맞아? ㅡㅡ; 그게 superpowers 및 pstack식이냐고 아닐거 같은데”. This unit ends at its owned code commit. Production build and installer work are not repeated per feature; root coordinates the remaining implementation before a single integrated build/release.
