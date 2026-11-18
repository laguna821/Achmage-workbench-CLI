# Test fixtures of the HanMark port (tests only; not shipped)

Copied unchanged from HanMark @ 3db078d (MIT © 2026 laguna821, see ../LICENSE-HANMARK):

- `한국언론학회 템플릿.hwpx`, `청소년학 템플릿.hwpx`, `방송학회 템플릿.hwpx`, `AI융합연구원템플릿.hwpx`, `blank.hwpx` —
  the five .hwpx templates at HanMark's root (the first two are the sources of its built-in style presets).
- `HWP5-password-123456.hwpx` — open password `123456`; from rhwp `samples/` (© edwardkim, MIT) as redistributed in
  the kordoc repository's `tests/fixtures/password/` and HanMark's `tests/fixtures/password/`.
  SHA-256 `93e7a62565e0f3efa4feee2812aaf518347dbbcc09d2f26a0d9385f9a4e26060`.
- `koreanCMapPdf.ts` — generates a minimal PDF whose text needs the Korean Adobe CMaps (HanMark tests/fixtures).
