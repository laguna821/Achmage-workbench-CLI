# Office execution — U09

The admitted Office turn now owns a separate execution capability. Its life is renewed by the executor, not by a visible document view. Closing or expiring the UI registration cannot issue a second writer or cancel the admitted run on its own. The existing session transcript, parent report, task projection and cancellation remain authoritative.

Every normal editing turn holds one physical-file writer. Separate PDF reading/long jobs and EPUB translation holds are read-only and do not acquire another writer. Real paths identify symlink aliases; inode matching also prevents two active owners of hardlinks. Lease generations and random capabilities fence expired or cancelled writers. Existing document revision and disk-hash checks still reject external saves. Atomic document saves follow the physical symlink target instead of replacing the link.

The Office gateway pins the execution token for the original serializer. After a tool changes the document, `flushOfficeDocument()` calls the existing editor flush handlers directly; the visible parent is no longer required to renew UI authority and reselect the session for every save. Only initial admission still requires the saved, clean document and chosen session. The execution token is invalidated on cancellation, finish or expiry. UI grant refreshes cannot evict an active execution token.

UI presence remains separate from execution authority. `DocumentRegistry.list()` and `forArtifact()` report views; internal `authority()` resolves either a view or an admitted executor. Reopened read-only views can read their conversation history. Reference snapshots retain their existing preview/owner identity. Reference, style, skill and generated-file paths use scoped execution authority without creating another conversation database.

## Current executor matrix

The independent native process, host ownership and original **Markdown** adapter are now wired in code. Other original document editing tool sets still use **ui-required** execution. A destroyed iframe or app process still loses those engines. Markdown's independent path is enabled only when the matching executor entry and desktop binary are installed. Actual native window execution remains to be observed during integration; code and isolated engine checks are not a completed OS acceptance result.

| Format | Original skill / factory | Remaining engine dependency |
|---|---|---|
| Word | `docx` / `createDocsSkill` | ProseMirror selection, panel writer and rollback state |
| Slides | `slides` / `createSlidesSkill` | Deck state, selection, clarification resolver |
| Sheets | `sheets` / `createWorkbookSkill` | Univer/workbook state; merge/search/image skills in the App |
| HWP/HWPX | `hwp` / `createHwpSkill` | Captured selection, refreshed context, memo-removal confirmation |
| PDF | `pdf` / `createPdfSkill` | PDF renderer state and original file-operation confirmation |
| Markdown | `markdown` / `createMarkdownSkill` | Independent adapter wired: original send, Tiptap document/selection, raw frontmatter, long-form writer and keep/discard confirmation. Native full-path execution not yet observed |
| HTML | `html` / `createDocumentSkill` | Document map/SID, clarification and brief-confirmation resolvers |
| XMind | `mindmap` / `createMindmapSkill` | Mindmap model and selected nodes |
| EPUB | `epub` / `createEpubSkill` | Original chapter/selection state and book bridge |

The existing web-search, image-search, read-url, fetch-image, generate-image, analyze-media and knowledge tool implementations execute in the host. Their enclosing Office loop still needs an independent owner. `office-markdown.mjs` handles preferences/image upload; it is not a host implementation of the original Markdown editing skill. A new string-replacement tool must not be counted as that skill's completed migration.

## Independent renderer implementation

`office-executors/renderer.ts` starts the existing desktop binary with `--office-executor`. Its one-use boot capability stays in an environment URL fragment; the child receives only the admitted document's grant. The existing turn ID, transcript, references and lease remain authoritative. A source view cannot save through its former UI writer after handoff. The host owns each child handle and its stdin pipe, caps active renderers at four, and closes only its own pipe for normal shutdown. Process exit, boot/readiness timeout and host loss interrupt the existing turn without replay.

`office_executor.rs` bypasses the normal app's single-instance, tray and gateway setup. A hidden 1280×860 window retains layout, uses an isolated temporary profile, installs no native command handlers and refuses popups, downloads and OS permission requests. The child accepts only the local executor parent. Linux also rejects a replacement main response before commit; macOS currently has a load guard and still needs its native integration check.

`executor-entry.ts` hosts the original format iframe. The Markdown source adapter calls the original `send` after restoring its document JSON, selection and raw-frontmatter snapshot. `createOfficeAi` attaches that renderer to the admitted turn instead of issuing another user request. The original serializer saves mutations. Hidden animation frames get the same fallback already used for native Office export.

The visible source becomes an observer. Closing or remounting it detaches observation instead of cancelling the independent owner; an explicit stop still cancels. Reopening observes the existing turn and pending confirmation. The original Markdown partial-write question becomes an existing transcript approval, which can be answered from the document view or session task UI. The executor's grant cannot approve its own question. Main sessions remain available, and final results use the existing parent-report path.

## Next implementation boundary

Extend the pinned adapter from Markdown to the remaining eight original `send`/`handleSend`, readiness, selection and question paths. Eight formats instantiate their loop in AiPanel; Sheets does so in App. Registering a loop constructor is insufficient: HWP's send captures selection and refreshes context, and other panels prepare attachments, writer callbacks and model gates before `loop.run()`.

Original questions must reach their actual resolvers with run/question identity; pending interaction is not success. Keep the same executor through selection, question, tool, serialization and finish. Remaining work includes the other eight adapters, original multi-choice/free-text questions and output interactions, actual native lifecycle execution, and the AppImage persistent runtime boundary. The complete U09 acceptance remains open.

## Focused evidence

- `document-execution-lease.test.ts`: stale symlink writer rejection, physical-target save, save after UI loss, external-change and cancellation fences, independent read holds, hardlink exclusion and expiry.
- `office-sessions.test.ts` and `document-registry.test.ts`: admitted run survives UI absence/selection change, expires with the executor, and keeps existing PDF/helper/main concurrency; real HTTP execution-token issue, heartbeat and revocation.
- `execution-bridge.test.ts`: the original agent wrapper executes a mutating tool, flushes through the serializer with the pinned execution grant, and returns to the latest UI token after finish without another parent prepare.
- These four suites total 22 cases. One expiry fixture initially captured real time before enabling fake timers; moving fake-timer activation before fixture creation fixed that one case. Only the failed case was repeated. A later changed HTTP case was checked individually.
- The affected reference, skill and style suites passed 49 cases. Host and Office TypeScript passed. No production, installer, native OS E2E or CI build was run for this phase.

Independent-renderer phase: six new focused cases cover host ownership/one-use boot/UI loss/questions/same-turn save, crash without replay, original Markdown selection editing/serialization, the actual pinned transform chain, detachment during handoff, and renderer attachment without a second turn-start. The original tool case uses Tiptap and IeumOffice's actual `createMarkdownSkill`; it is not a raw-text replacement tool. Linux `cargo check --offline` passed once. Type-check fixture issues and a jsdom/esbuild realm issue were isolated and corrected; passed product cases were not repeated. No installer, production bundle or native screen run is claimed.

Implementation: `aa6779d`. Research basis and results: R35, `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:1bc8ee43194f035f2258e6ce0c12aaf74acd1a95c01e76703bb6c1a899ab7bc1`. U09 and the full 0.4.0 goal remain incomplete.
