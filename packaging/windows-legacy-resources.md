# Windows v0.2.2 resource migration

The NSIS `/S` and `/UPDATE` paths can overwrite an installation without running its old
uninstaller. Removed bundle resources then survive an update, even though a fresh install
is smaller. The post-install hook runs the new bundled Node worker after all new files
have been written.

`windows-legacy-v0.2.2.json` records 910 obsolete files from the published v0.2.2 NSIS
installer, whose URL and SHA256 are recorded in the manifest. The installer was verified
before extraction with 7-Zip. The inventory contains files under `hop`, `pdfcraft`,
`kordoc` and the retired Ieum Electron/runtime/editor resources. The retained Ieum CLI,
WASM, native engines, OCR, builtin skills, notices and current bundle marker are excluded.

`cleanup-legacy.mjs` deletes a listed file only when its size and SHA256 still match.
It skips directory/file links and changed files, never traverses user data directories,
and removes directories only if they are empty. Added files stay in place. A repeat
installation is harmless; an inaccessible old file is reported in `legacy-cleanup.json`
and makes the installer return a nonzero status, so it can be retried after closing the
old application. No broad recursive folder deletion or process termination is used.

The inventory is intentionally pinned: do not add a wildcard, current resources or
user data to work around a failing upgrade test. A new old-version inventory requires
its published installer hash and actual file hashes. This hook covers the NSIS EXE;
MSI installation and migration from other installer formats require separate evidence.

The Windows upgrade CI installs the real published v0.2.2, seeds data through its actual
gateway, adds personal files to former bundle folders and modifies an existing SKILL.md,
then installs the new EXE in the same location. It checks identifiers, conversations,
settings, original document bytes, previous revisions, current engines, personal files,
the complete obsolete inventory and the resulting installed size. This is not a test
of every existing WebView localStorage/IndexedDB profile.
