# U05/U18 mobile file and input connection

Implementation only, following the latest user correction. No new test, typecheck, build, installer, CI, device session, microphone, or paid request was started for this bundle.

Context: context-9141d9787cab4bb8b00df7efd7641599. Approved implementation/reuse correction: decision-5e2a5ff3288c4ec7973e1f9922dd873605f56843e258b8e4fea0485a18a4cd70 and decision-ad213a131da97ba4c7079eeaca47430ffd819ae80f1963b5d546c71559fcbe6c. Existing research continuity: research:rr-1b4bb9d2193a4e5dced6dca4128061a9:eaf1781fb6ea15427f1698896ce325e66c7ae94fae3c0f05a1b3b54e907b0d2a (R37; native execution evidence is not mobile-device evidence).

## Implemented paths

- Composer → 첨부 → 사진 보관함 / 사진 촬영 / 파일 선택. Browser pickers feed the existing authenticated upload and Workbench Attachment identity. The target draft is captured before picking; changing conversations does not retarget the returned files. Existing paste/drop, voice, queue, stop and document controls remain connected.
- Transcript attachment → file action menu → 파일 받기 / 공유. Gallery uses the same actions. File preparation uses the existing immutable reference and host-bound authenticated media cache; the prepared File is shared only by a subsequent explicit click. No credential URL or local filesystem path is handed to the share sheet. Unsupported Web Share shows a download fallback; cancellation is not reported as a failure.
- Exact host plus Composer draftKey owns pending uploads. Uploaded Attachment metadata survives reload in the existing browser localStorage draft area; file bytes are not put in a new database. Async completion stays with its original draft. Failed files stay after a successful send and can be retried explicitly while their File is still in memory. Interrupted uploads after reload ask for re-selection rather than automatic retransmission.
- Composer follows the original web input's composition ownership: DOM keeps active IME text, compositionend commits the final value, native isComposing/keyCode229 prevent send/menu acceptance. Compact input uses Return for newline and the visible send button. Text is written synchronously and flushed on pagehide/hidden; cursor/selection/textarea scroll restore with matching draft text. Mobile mounts/receipts do not auto-focus and reopen the keyboard.
- installMobileLayout() uses the original visible-viewport functions to resize the existing root surface on keyboard, viewport and orientation changes; it does not remount Office or transcript views. CSS adds safe-area padding and touch-sized composer, file and approval actions. Pinch zoom is left to the browser.

## Direct upstream reuse

Pinned Paseo 1fff127f45b11c1c9c573fbbd12791673004c912, Apache-2.0. vendor/paseo/mobile-web/source.json records the original and derived SHA256 values; original complete modules are preserved under upstream/.

- keyboard-ime.ts and file-types.ts copied unchanged.
- Original readVisibleViewport / resolveVisibleSurfaceFrame, triggerBrowserDownload / sanitizeDownloadFileName, resolveMessageInputEnterAction and collectImageFilesFromClipboardData are used with exported pure-function/type closures. The download external-opener dependency is injected. Runtime function bodies retain original behavior.
- Original text-input.web compositionend DOM-value behavior is adapted to the existing Composer.
- Workbench keeps its existing upload/remote transport, cache, 25MB limit, attachment IDs and storage model. Expo/RN state stores, a second IndexedDB, a separate native mobile application and Paseo's full attachment SDK are not activated.

## Root integration

- App mount calls installMobileLayout() from apps/web/src/mobile-layout.ts and returns its cleanup.
- Viewport meta requires viewport-fit=cover and interactive-widget=resizes-content.
- Root owns attachmentHostId() and retainAttachmentUrl(id, identity, referenceHostId?) in api.ts; the new UI calls those signatures.
- Copy mobile-web/source.json and NOTICE alongside the shared Paseo license in third_party during integration. No package dependency/install step is needed.
- PWA owner confirmed no share_target receiver in this bundle; worker does not cache API/attachment responses and warm notification navigation preserves the mounted draft.

## Remaining / unverified

NOT_RUN_DEVICE: actual iOS/Android camera/photo providers, HEIC display, OS share sheet, download destination, virtual keyboard/rotation/safe-area/selection behavior and background process eviction. No claim of installed-mobile or OS visual completion.

HEIC/HEIF remain original bytes with a MIME inferred only when the OS omits it. Engines' existing image support is unchanged; unsupported preview formats are downloadable files, not silently converted images. Browser capture is a hint and can open the OS file picker on unsupported platforms.

Uploads interrupted before a server receipt require explicit re-selection after reload. Completed references can still fail if their original host is disconnected/revoked; the UI reports the error and never falls back to another host. External app share *reception* and native share extensions are not implemented.

Owned changed files: Composer.tsx, Attachments.tsx, WorkView.tsx (pending scope/retry only), docs/DocumentView.tsx (pending scope/retry only), draft.ts, mobile-layout.ts/css, mobile-platform.ts, styles/attachments.css, vendor/paseo/mobile-web/** and this report. No commit made; root batches integration.
