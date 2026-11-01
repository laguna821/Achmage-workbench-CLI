# HOP improvements in the Ieum HWP editor

Source: [Achmage HOP beta.6](https://github.com/laguna821/Achmage-HOP-public/tree/d533eb4360db034cd45d87b0751c0d742c6d6ca6), MIT.
`manifest.json` records the exact copied source and adapted-file hashes.

- The original host font catalog merges localized names and keeps face weights and collection indices. Workbench enumerates installed fonts with the same fontdb dependency already used for PDF output. Paths stay inside the gateway; editor grants expose only opaque face IDs and bytes. Fonts are not installed, copied into the repository or distributed.
- `crisp-canvas.ts` is the original pixel-grid correction, installed on the existing studio iframe. It retains smooth filtering during zoom previews.
- The shared `rhwp-core` combines rhwp v0.8.7 with all20 pinned Ieum patches and original HOP patches0001/0002/0003/0005/0007/0008/0009/0010/0011. These cover numeric font metrics, auto tab indent, synthetic bold, line-break size, generated pagination/table spacing, physical margins and justification.
- 0004 only adds diagnostics. 0006 changes the stored-tab contract and conflicts with Ieum's save repair, so it is excluded. 0012 adds HOP product branding and is excluded. The HOP desktop application, AI panels and font bundles are not included.

The editor, file parser, previews and Workbench HWP CLI use the same verified WASM. The original Ieum renderer and save repairs remain in place. A normal app build consumes the checked-in engine and does not compile rhwp again.

To intentionally rebuild the engine, use `node scripts/rebuild-hwp-engine.mjs --keep` with wasm-pack0.15.0 and the pinned rhwp Rust1.93.1 toolchain. The script uses an isolated cache, verifies source pins/patches and records the output hash. The original upstream source checkout remains unchanged. Then update source hashes after reviewing any intentional adapter changes.

Validation: actual Linux Tauri34/34, focused42/42, complete183files/1270tests and all four TypeScript projects passed. Windows/macOS installed font-helper checks are included in final OS acceptance. This change is newer than the public0.2.8 installers.

Exact implementation and evidence: `research:rr-0c8711978a2135e837ebbfc93e56f825:55c55badb9096d492c3af2379c5e9f3bc081ddb636946a22074cdd57bd7cab98`.
