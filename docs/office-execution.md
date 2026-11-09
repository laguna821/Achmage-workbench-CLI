# Office execution — U09

The admitted Office turn now owns a separate execution capability. Its life is renewed by the executor, not by a visible document view. Closing or expiring the UI registration cannot issue a second writer or cancel the admitted run on its own. The existing session transcript, parent report, task projection and cancellation remain authoritative.

Every normal editing turn holds one physical-file writer. Separate PDF reading/long jobs and EPUB translation holds are read-only and do not acquire another writer. Real paths identify symlink aliases; inode matching also prevents two active owners of hardlinks. Lease generations and random capabilities fence expired or cancelled writers. Existing document revision and disk-hash checks still reject external saves. Atomic document saves follow the physical symlink target instead of replacing the link.

The Office gateway pins the execution token for the original serializer. After a tool changes the document, `flushOfficeDocument()` calls the existing editor flush handlers directly; the visible parent is no longer required to renew UI authority and reselect the session for every save. Only initial admission still requires the saved, clean document and chosen session. The execution token is invalidated on cancellation, finish or expiry. UI grant refreshes cannot evict an active execution token.

UI presence remains separate from execution authority. `DocumentRegistry.list()` and `forArtifact()` report views; internal `authority()` resolves either a view or an admitted executor. Reopened read-only views can read their conversation history. Reference snapshots retain their existing preview/owner identity. Reference, style, skill and generated-file paths use scoped execution authority without creating another conversation database.

## Current executor matrix

All original document editing tool sets still use **ui-required** execution. The code above removes the UI-presence dependency; it does not move the JavaScript engine into an independent process. A destroyed iframe or app process still loses its engine and is interrupted. `host` and `independent-renderer` are authority modes for the next adapters, not claims of current product support.

| Format | Original skill / factory | Remaining engine dependency |
|---|---|---|
| Word | `docx` / `createDocsSkill` | ProseMirror selection, panel writer and rollback state |
| Slides | `slides` / `createSlidesSkill` | Deck state, selection, clarification resolver |
| Sheets | `sheets` / `createWorkbookSkill` | Univer/workbook state; merge/search/image skills in the App |
| HWP/HWPX | `hwp` / `createHwpSkill` | Captured selection, refreshed context, memo-removal confirmation |
| PDF | `pdf` / `createPdfSkill` | PDF renderer state and original file-operation confirmation |
| Markdown | `markdown` / `createMarkdownSkill` | Tiptap blocks/selection, frontmatter, original long-form writer |
| HTML | `html` / `createDocumentSkill` | Document map/SID, clarification and brief-confirmation resolvers |
| XMind | `mindmap` / `createMindmapSkill` | Mindmap model and selected nodes |
| EPUB | `epub` / `createEpubSkill` | Original chapter/selection state and book bridge |

The existing web-search, image-search, read-url, fetch-image, generate-image, analyze-media and knowledge tool implementations execute in the host. Their enclosing Office loop still needs an independent owner. `office-markdown.mjs` handles preferences/image upload; it is not a host implementation of the original Markdown editing skill. A new string-replacement tool must not be counted as that skill's completed migration.

## Next implementation boundary

Use the existing desktop binary's executor-only entry, with an independently owned parent that loads the original format iframe. Extend the pinned `originalOfficeConversation()` transform in `apps/office/vite.config.ts` to register thin adapters for each original `send`/`handleSend`, readiness and cancellation path. Eight formats instantiate their loop in AiPanel; Sheets does so in App. Registering a loop constructor is insufficient: HWP's send captures selection and refreshes context, and other panels prepare attachments, writer callbacks and model gates before `loop.run()`.

The executor must attach to the admitted turn instead of generating another turn ID. Original questions must reach their actual resolvers with run/question identity; pending interaction is not success. Keep the same executor through selection, question, tool, serialization and finish. Native process ownership, normal shutdown, crash/unknown outcomes and UI reconnection remain to implement. No `executor-entry.ts` or `office_executor.rs` is claimed complete by this phase.

## Focused evidence

- `document-execution-lease.test.ts`: stale symlink writer rejection, physical-target save, save after UI loss, external-change and cancellation fences, independent read holds, hardlink exclusion and expiry.
- `office-sessions.test.ts` and `document-registry.test.ts`: admitted run survives UI absence/selection change, expires with the executor, and keeps existing PDF/helper/main concurrency; real HTTP execution-token issue, heartbeat and revocation.
- `execution-bridge.test.ts`: the original agent wrapper executes a mutating tool, flushes through the serializer with the pinned execution grant, and returns to the latest UI token after finish without another parent prepare.
- These four suites total 22 cases. One expiry fixture initially captured real time before enabling fake timers; moving fake-timer activation before fixture creation fixed that one case. Only the failed case was repeated. A later changed HTTP case was checked individually.
- The affected reference, skill and style suites passed 49 cases. Host and Office TypeScript passed. No production, installer, native OS E2E or CI build was run for this phase.

Implementation: `aa6779d`. Research basis and results: R35, `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:1bc8ee43194f035f2258e6ce0c12aaf74acd1a95c01e76703bb6c1a899ab7bc1`. U09 and the full 0.4.0 goal remain incomplete.
