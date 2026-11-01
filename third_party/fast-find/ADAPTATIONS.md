# Fast Find in Achmage Workbench

Source: https://github.com/ssp-data/obsidian-fast-find-10k

Pinned revision: `714548efd3e361a7011a5123f4ae928630a01614` (plugin0.2.6).
Copyright2026 Simon Späti. The original MIT license is included in `LICENSE`.

`upstream.json` retains the original90 file hashes. `adaptations.json` records the changed
file hashes and reasons. `node scripts/check-fast-find-sources.mjs` verifies both sets.
The source fixture, original unit tests, golden cases and typo recall tests are retained.

Workbench adds typed title/alias/tag/property/path input without changing the raw source;
scope checks before partial matches, ranking and paging; compact candidate selection before
expensive details; and CJK compatibility at the per-field candidate boundary. The CJK lookup
references distinct original tokens by character/pair, then checks actual substrings and
adjacent original positions. It does not create a second document index or modify note bodies.
Original tier ordering, fuzzy matching and format extraction remain upstream code.

Korean particle/spacing contracts come from Workbench's `search-text.ts` and `titles.ts`.
Normalized highlights map back to original grapheme boundaries before the worker converts
UTF-8 byte ranges to UTF-16 ranges. `tests/workbench.rs` covers the adapter independently.

The shared engine runs inside the installed executable's `--search-worker` entry point,
before Tauri initializes. `apps/desktop/search-worker` is the same library with a small
development executable. Host collection, source ownership, SQLite cache and UI navigation
stay in Workbench. The old search is replaced only when the Finder/UI integration is enabled.
