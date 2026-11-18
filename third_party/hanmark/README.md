# HanMark (ported parts)

HanMark 2.7.0 — the owner's Obsidian plugin for Hangul documents (MIT © 2026 laguna821), source @ 3db078d.
Workbench's 불러오기 / 내보내기 (apps/host/src/hangul-convert.ts) carries these of its files, adapted to a project
folder instead of an Obsidian vault, in `apps/host/src/hanmark/` (each file names its origin; LICENSE-HANMARK there):

- `src/io/markdownAdapter.ts` — Obsidian-flavoured Markdown cleaned for kordoc's generator
- `src/io/markdownImageTokens.ts`, `src/io/imageLinks.ts` — picture references found and rewritten
- `src/io/imageAssets.ts` — pictures resolved, checked and named for an export (its HWPX hydration is not ported:
  the kordoc core embeds pictures itself)
- `src/io/importOptions.ts` — the four import presets and the parse-option whitelist
- `src/io/messageCatalog.ts` + the Korean texts of `src/i18n/ko.ts` they use — kordoc's codes in plain Korean
- `src/io/documentStylePresets.ts` — the built-in 한국언론학회 and 청소년학 styles

kordoc itself is not here: the app runs the one kordoc of the bundled hallym-kordoc skill (third_party/skills).
