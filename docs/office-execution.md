# Office execution — U09

The admitted Office turn now owns a separate execution capability. Its life is renewed by the executor, not by a visible document view. Closing or expiring the UI registration cannot issue a second writer or cancel the admitted run on its own. The existing session transcript, parent report, task projection and cancellation remain authoritative.

Every normal editing turn holds one physical-file writer. Separate PDF reading/long jobs and EPUB translation holds are read-only and do not acquire another writer. Real paths identify symlink aliases; inode matching also prevents two active owners of hardlinks. Lease generations and random capabilities fence expired or cancelled writers. Existing document revision and disk-hash checks still reject external saves. Atomic document saves follow the physical symlink target instead of replacing the link.

The Office gateway pins the execution token for the original serializer. After a tool changes the document, `flushOfficeDocument()` calls the existing editor flush handlers directly; the visible parent is no longer required to renew UI authority and reselect the session for every save. Only initial admission still requires the saved, clean document and chosen session. The execution token is invalidated on cancellation, finish or expiry. UI grant refreshes cannot evict an active execution token.

UI presence remains separate from execution authority. `DocumentRegistry.list()` and `forArtifact()` report views; internal `authority()` resolves either a view or an admitted executor. Reopened read-only views can read their conversation history. Reference snapshots retain their existing preview/owner identity. Reference, style, skill and generated-file paths use scoped execution authority without creating another conversation database.

## Current executor matrix

The independent native process and host ownership now connect the original Markdown, Word, HWP/HWPX, HTML, XMind, Sheets, PDF and EPUB adapters. Slides also has its selection/send/question adapter, but remains **ui-required** until its subsequent queue and QC loops have one request-level owner. Independent paths require the matching executor entry and desktop binary. Actual native window execution remains to be observed during integration; code and isolated checks are not a completed OS acceptance result.

| Format | Original skill / factory | Adapter code and remaining boundary |
|---|---|---|
| Word | `docx` / `createDocsSkill` | Original runWith after full loading, validated ProseMirror selection, track changes, attachments and partial writer confirmation |
| Slides | `slides` / `createSlidesSkill` | Original runWith, saved slide/durable IDs, nested multi-selection, attachments/template, clarification and context gate. Queue/QC lifecycle remains; not promoted |
| Sheets | `sheets` / `createWorkbookSkill` | Original handleSend/runAgent, saved sheet/range, frozen scope and attachments; original merge/search/image skills remain in the App |
| HWP/HWPX | `hwp` / `createHwpSkill` | Original send/readiness, paragraph/table SelectionScope, attachments and original memo-removal confirmation |
| PDF | `pdf` / `createPdfSkill` | Original send, saved page-order positions, selected passage and cancellable file-operation confirmation |
| Markdown | `markdown` / `createMarkdownSkill` | Independent adapter wired: original send, Tiptap document/selection, raw frontmatter, long-form writer and keep/discard confirmation. Native full-path execution not yet observed |
| HTML | `html` / `createDocumentSkill` | Original send, saved SID map/multi-selection/intent, clarification, editable brief and partial writer confirmation |
| XMind | `mindmap` / `createMindmapSkill` | Original send, saved sheet/root identity and selected nodes |
| EPUB | `epub` / `createEpubSkill` | Original send, chapter/viewport/DOM selection, attachments and translation dialog choices. Parent waits through original translation result write/unlock |

The existing web-search, image-search, read-url, fetch-image, generate-image, analyze-media and knowledge tool implementations execute in the host. Their enclosing Office loop still needs an independent owner. `office-markdown.mjs` handles preferences/image upload; it is not a host implementation of the original Markdown editing skill. A new string-replacement tool must not be counted as that skill's completed migration.

## Independent renderer implementation

`office-executors/renderer.ts` starts the existing desktop binary with `--office-executor`. Its one-use boot capability stays in an environment URL fragment; the child receives only the admitted document's grant. The existing turn ID, transcript, references and lease remain authoritative. A source view cannot save through its former UI writer after handoff. The host owns each child handle and its stdin pipe, caps active renderers at four, and closes only its own pipe for normal shutdown. Process exit, boot/readiness timeout and host loss interrupt the existing turn without replay.

`office_executor.rs` bypasses the normal app's single-instance, tray and gateway setup. A hidden 1280×860 window retains layout, uses an isolated temporary profile, installs no native command handlers and refuses popups, downloads and OS permission requests. The child accepts only the local executor parent. Linux also rejects a replacement main response before commit; macOS currently has a load guard and still needs its native integration check.

`executor-entry.ts` hosts the original format iframe. Each pinned adapter restores its original transient state before invoking the original send function. Markdown restores document JSON, selection and raw frontmatter; binary formats open the admitted saved file through their existing bridge. `createOfficeAi` attaches that renderer to the admitted turn instead of issuing another user request. The original serializer saves mutations. Hidden animation frames get the same fallback already used for native Office export.

The visible source becomes an observer. Closing or remounting it detaches observation instead of cancelling the independent owner; an explicit stop still cancels. Reopening observes the existing turn and pending confirmation. Original boolean, choice, multiple-choice and free-text questions use the same transcript approval, answered from the document view or session task UI. Original resolvers receive those answers; a missing answer is never acceptance. The executor's grant cannot approve its own question. Main sessions remain available, and final results use the existing parent-report path.

The original transport now awaits asynchronous context confirmation before starting its model stream. Cancelling while that question is pending cannot start a stream after a late answer. Original output preparation asks for a path and, when necessary, a separate overwrite decision. The host then issues an existing `OfficeOutputs` ticket; original serialized bytes or a generated-file identity commit through that ticket, retaining revision, collision and backup checks after UI loss. Nested translation preparation flushes the current document revision instead of reusing its startup revision.

## Next implementation boundary

Slides must keep one parent request alive across its page queue and follow-up QC loops before it can leave ui-required mode. Its current adapter explicitly refuses queued execution. Native printing/rendering, image extraction and OS presentation/open-export require an independently owned service; unsupported output actions return an explicit error rather than wait indefinitely. Original serializers and ordinary output tickets are connected, but this is not the entire output surface.

PDF's separate toolbar AI-reading and whole-document translation dialogs are not covered by this general AiPanel adapter. In the pinned source, that panel does not supply either optional start capability to `PdfAiDeps`; its corresponding tools already return unavailable. Their separate UI-owned job paths still require their own handoff rather than being counted as completed by the general PDF adapter.

Remaining integration includes actual native loading/tool/save/question completion after visible UI exit, native output services, complete request/runtime receipt acceptance, settings continuity across handoff and the AppImage persistent runtime boundary. Do not count a pinned-source transform as proof of full document execution. The complete U09 acceptance remains open.

## Focused evidence

- `document-execution-lease.test.ts`: stale symlink writer rejection, physical-target save, save after UI loss, external-change and cancellation fences, independent read holds, hardlink exclusion and expiry.
- `office-sessions.test.ts` and `document-registry.test.ts`: admitted run survives UI absence/selection change, expires with the executor, and keeps existing PDF/helper/main concurrency; real HTTP execution-token issue, heartbeat and revocation.
- `execution-bridge.test.ts`: the original agent wrapper executes a mutating tool, flushes through the serializer with the pinned execution grant, and returns to the latest UI token after finish without another parent prepare.
- These four suites total 22 cases. One expiry fixture initially captured real time before enabling fake timers; moving fake-timer activation before fixture creation fixed that one case. Only the failed case was repeated. A later changed HTTP case was checked individually.
- The affected reference, skill and style suites passed 49 cases. Host and Office TypeScript passed. No production, installer, native OS E2E or CI build was run for this phase.

Independent-renderer phase: six new focused cases cover host ownership/one-use boot/UI loss/questions/same-turn save, crash without replay, original Markdown selection editing/serialization, the actual pinned transform chain, detachment during handoff, and renderer attachment without a second turn-start. The original tool case uses Tiptap and IeumOffice's actual `createMarkdownSkill`; it is not a raw-text replacement tool. Linux `cargo check --offline` passed once. Type-check fixture issues and a jsdom/esbuild realm issue were isolated and corrected; passed product cases were not repeated. No installer, production bundle or native screen run is claimed.

Original-format phase: five new focused cases cover structured questions in the host/UI, output path/overwrite/save after source UI loss, and the actual original transport waiting/cancellation. Seven Sheets/PDF/EPUB cases cover request reconstruction, exact selection, document locks/question input and translation write/unlock lifetime; one of these transforms seven actual pinned modules. The document owner transformed three pinned modules and the presentation owner transformed six with its state/question probes. Ten original context callbacks were connected. New fixture/type issues and the esbuild/jsdom realm mismatch were isolated; only the failed new checks were repeated. Host, web and Office TypeScript passed. These are code-level checks, not native execution proof.

Foundation commits: `aa6779d` and `f89fd18`; original-format adapters follow in R37. Research basis and results: R35–R37, `research:rr-1b4bb9d2193a4e5dced6dca4128061a9:eaf1781fb6ea15427f1698896ce325e66c7ae94fae3c0f05a1b3b54e907b0d2a`. U09 and the full 0.4.0 goal remain incomplete.
