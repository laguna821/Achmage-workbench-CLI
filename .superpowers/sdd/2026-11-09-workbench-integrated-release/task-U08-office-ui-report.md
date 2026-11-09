# U08 embedded Office UI

Implemented in the shared 0.4.0 worktree. This change connects the original editors' menus and live ribbon controls to a named shell command picker and fixes theme propagation after a delayed editor grant. It does not rebuild an editor or replace its document model.

## Product behavior

- **편집 명령** in DocumentView and **Alt+/** inside the editor open a native dialog with search, keyboard navigation, Escape/dismiss and focus return. Commands run after the original DOM range/input caret is restored. Search keystrokes do not fall through to renderer editing shortcuts; IME composition does not execute the highlighted command.
- All entries passed to `adaptOfficeCommands` survive, including unknown advanced IDs and their original handlers/disabled reasons. The mounted picker combines the format's original native-menu IDs with visible controls from its current original ribbon. Disabled controls explain their reason. Other ribbon tabs and contextual tools remain in the original editor; their controls enter search when that tab is shown. Hidden contextual controls are not falsely advertised as globally indexed commands.
- The original nine editors invoke these adapters from their real browser bridge entrypoints. The existing bridge still checks parent origin and frame source. Headless exports do not mount the picker.
- Theme observation now attaches after the async grant creates the iframe. Changes in enclosing theme scopes and a final theme message on editor-open reach the original theme handlers. The iframe key, grant, content CSS, dirty/revision model and undo implementation are untouched; hiding the pane does not reload it.
- Shell file outputs now reach existing live editor handlers for spreadsheet/HWP/HWPX PDF export, Word HTML/images and slide images, in addition to existing paths. They reuse the existing output dialogs/receipts. The file menu trigger advertises menu or form-dialog semantics according to the existing native/web file picker surface.

## Nine connected adapters

| Format | Actual entrypoint / original dispatch |
| --- | --- |
| 한글 HWP/HWPX | `hwp.ts`: saveRequest / printRequest, outer toolbar and same-origin HOP studio controls; inner frame load binds Alt+/ |
| Word | `docs.ts`: menuCommand, including original table/font/paragraph/layout and other advanced menu IDs; live ribbon |
| Slides | `slides.ts`: slides:menu and live ribbon, including original image/PDF output |
| Sheets | `sheets.ts`: menu:action, original spreadsheet ribbon/Univer controls |
| Markdown | `text-editor.ts`: save/export/print events and original Markdown ribbon |
| PDF | `pdf.ts`: existing saveCopy / pdf:print-request and original annotation/OCR/form ribbon controls |
| HTML | `text-editor.ts`: save/export/print events and original HTML ribbon |
| Mindmap | `mindmap.ts`: original save/print/menu-command channels and ribbon |
| EPUB | `epub.ts`: original save/menu-command channels and ribbon |

CSS is scoped to the new picker. The existing Vite entrypoints already bundle imports and CSS, so no Vite configuration change was needed. OfficeView's static preview, independent document AI, existing original ribbons and native editor output machinery already worked and were retained.

## Focused verification

```sh
npx vitest run apps/office/src/ui-adapters.test.ts apps/web/src/components/docs/OfficeEditor.theme.test.tsx apps/web/src/components/OfficeFileMenu.test.tsx
```

The first run passed all six OfficeEditor/FileMenu behaviors. The adapter file stopped in setup because this jsdom build lacks native dialog `showModal`/`close` methods. The fixture now supplies those browser methods, without changing production dialog behavior. Only that affected file was rerun:

```sh
npx vitest run apps/office/src/ui-adapters.test.ts
```

All fifteen adapter behaviors pass. Combined focused result: **21 passing behaviors**. Coverage includes nine-format native/live command execution, unknown advanced commands, disabled controls, same content/control identity, DOM selection and input caret restoration, IME/renderer shortcut isolation, nested HWP controls, authorized parent messages, delayed grant theme changes, unchanged dirty iframe across pane visibility, and live export callbacks. No successful test file was rerun. Parent owns the combined type check/build and installation candidate.

The DOM tests do not execute all nine vendor engines against native documents or prove native IME/Undo histories. This change uses their existing handlers rather than mutating their models. Full native renderer/browser/print behavior was not claimed or separately looped here.

## Context

Context: `context-ec9faf6972b8495d90c20cdc1077eb43`; material-use outcome recorded. A first outcome submission used a decision ID where the API requires retrieval source IDs; the corrected receipt omits unverified source IDs.

Exact task-supplied research read before implementation: `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:70d2c06553dfffc96bb06082310b44f3c8449f27543768366354c487c196802d` (R24–R27). The user's implementation-first cadence governs; no extra review agent, performance gate, provider invocation, remote write, or live database/vault access was used. Parent owns the single `office:show-commands` contract addition.
